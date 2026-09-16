import {
  parseDataDirEnvValue,
  resolveConfiguredDataDir,
  resolveProdDataDir,
} from "@bb/config/runtime";
import {
  createNodeAdminClient,
  type NodeAdminClient,
} from "@bb/sdk/node-admin";
import type { Command } from "commander";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { action } from "../action.js";
import { outputJson } from "./helpers.js";

interface MaintenanceOutputOptions {
  json?: boolean;
}

type OwnedOptions = MaintenanceOutputOptions;

const maintenancePhases = new Set([
  "draining",
  "sealing",
  "sealed",
  "activating",
  "verifying",
  "rolling-back",
  "rollback-failed",
  "releasing",
]);
const maintenanceResolutions = new Set([
  "completed",
  "rolled-back",
  "force-aborted",
]);

function resolveDataDir(command: Command): string {
  const dataDir = command.optsWithGlobals().dataDir as string | undefined;
  const homeDir = homedir();
  if (dataDir !== undefined) {
    if (!isAbsolute(dataDir)) {
      throw new Error("--data-dir must be an absolute path");
    }
    return parseDataDirEnvValue({ homeDir, rawDataDir: dataDir });
  }
  return resolveConfiguredDataDir({
    env: process.env,
    homeDir,
    defaultDataDir: resolveProdDataDir({ homeDir }),
  });
}

function createClient(command: Command): NodeAdminClient {
  return createNodeAdminClient({ dataDir: resolveDataDir(command) });
}

function operationDirectory(command: Command): string {
  return join(resolveDataDir(command), "admin", "operations");
}

function operationPath(command: Command, operationId: string): string {
  if (!operationId || operationId.includes("/") || operationId.includes("\\")) {
    throw new Error("operation ID must be a non-empty filename-safe value");
  }
  return join(operationDirectory(command), `${operationId}.json`);
}

function readOwner(command: Command, operationId: string): string {
  const fromEnvironment = process.env.BB_MAINTENANCE_OWNER_SECRET;
  if (fromEnvironment) return fromEnvironment;
  const parsed = JSON.parse(
    readFileSync(operationPath(command, operationId), "utf8"),
  ) as {
    operationId?: unknown;
    ownerSecret?: unknown;
  };
  if (
    parsed.operationId !== operationId ||
    typeof parsed.ownerSecret !== "string" ||
    !parsed.ownerSecret
  ) {
    throw new Error(`maintenance owner file for ${operationId} is invalid`);
  }
  return parsed.ownerSecret;
}

function createOwner(command: Command, requestedOperationId?: string) {
  const operationId = requestedOperationId ?? randomUUID();
  const filePath = operationPath(command, operationId);
  mkdirSync(operationDirectory(command), { recursive: true, mode: 0o700 });
  chmodSync(operationDirectory(command), 0o700);
  try {
    const existing = JSON.parse(readFileSync(filePath, "utf8")) as {
      operationId?: unknown;
      ownerSecret?: unknown;
    };
    if (
      existing.operationId !== operationId ||
      typeof existing.ownerSecret !== "string" ||
      !existing.ownerSecret
    ) {
      throw new Error(`maintenance owner file for ${operationId} is invalid`);
    }
    return { operationId, ownerSecret: existing.ownerSecret, filePath };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  const ownerSecret =
    process.env.BB_MAINTENANCE_OWNER_SECRET ??
    randomBytes(32).toString("base64url");
  writeFileSync(filePath, `${JSON.stringify({ operationId, ownerSecret })}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return { operationId, ownerSecret, filePath };
}

function parseTtl(value: string): number {
  if (!/^\d+$/u.test(value))
    throw new Error("--ttl-ms must be an integer from 30000 through 1800000");
  const ttlMs = Number(value);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 30_000 || ttlMs > 1_800_000) {
    throw new Error("--ttl-ms must be an integer from 30000 through 1800000");
  }
  return ttlMs;
}

function printResult(options: MaintenanceOutputOptions, result: unknown): void {
  if (outputJson(options, result)) return;
  console.log(JSON.stringify(result, null, 2));
}

export function registerMaintenanceCommands(program: Command): void {
  const maintenance = program
    .command("maintenance")
    .description("Control local work admission for safe headless maintenance")
    .option("--data-dir <absolute-path>", "BB data directory")
    .option("--json", "Output JSON");

  maintenance
    .command("identity")
    .description("Verify the local maintenance protocol identity")
    .option("--json", "Output JSON")
    .action(
      action(async (options: MaintenanceOutputOptions, command: Command) => {
        printResult(options, await createClient(command).identity());
      }),
    );

  maintenance
    .command("status")
    .description("Show the current lease, barriers, and active work")
    .option("--json", "Output JSON")
    .action(
      action(async (options: MaintenanceOutputOptions, command: Command) => {
        printResult(options, await createClient(command).status());
      }),
    );

  maintenance
    .command("acquire")
    .description("Acquire maintenance and establish daemon barriers")
    .requiredOption("--reason <reason>", "Operator-visible reason")
    .option(
      "--ttl-ms <milliseconds>",
      "Draining lease TTL (30000-1800000)",
      "300000",
    )
    .option("--operation-id <id>", "Reuse a caller-generated operation ID")
    .option("--json", "Output JSON")
    .action(
      action(
        async (
          options: OwnedOptions & {
            operationId?: string;
            reason: string;
            ttlMs: string;
          },
          command: Command,
        ) => {
          const owner = createOwner(command, options.operationId);
          const result = await createClient(command).acquire({
            operationId: owner.operationId,
            ownerSecret: owner.ownerSecret,
            reason: options.reason,
            ttlMs: parseTtl(options.ttlMs),
          });
          printResult(options, result);
        },
      ),
    );

  maintenance
    .command("renew <operation-id>")
    .description("Renew an unsealed draining lease")
    .option(
      "--ttl-ms <milliseconds>",
      "Draining lease TTL (30000-1800000)",
      "300000",
    )
    .option("--json", "Output JSON")
    .action(
      action(
        async (
          operationId: string,
          options: OwnedOptions & { ttlMs: string },
          command: Command,
        ) => {
          const result = await createClient(command).renew({
            operationId,
            ownerSecret: readOwner(command, operationId),
            ttlMs: parseTtl(options.ttlMs),
          });
          printResult(options, result);
        },
      ),
    );

  maintenance
    .command("seal <operation-id>")
    .description("Seal daemon gates before service activation")
    .requiredOption("--candidate <commit>", "Candidate release identity")
    .requiredOption("--previous <commit>", "Previous release identity")
    .option("--allow-active-work", "Explicitly accept reported active work")
    .option("--json", "Output JSON")
    .action(
      action(
        async (
          operationId: string,
          options: OwnedOptions & {
            allowActiveWork?: boolean;
            candidate: string;
            previous: string;
          },
          command: Command,
        ) => {
          const result = await createClient(command).seal({
            operationId,
            ownerSecret: readOwner(command, operationId),
            candidateRelease: options.candidate,
            previousRelease: options.previous,
            allowActiveWork: options.allowActiveWork ?? false,
          });
          printResult(options, result);
        },
      ),
    );

  maintenance
    .command("transition <operation-id> <expected-phase> <phase>")
    .description("Advance an owned activation or rollback phase")
    .option("--json", "Output JSON")
    .action(
      action(
        async (
          operationId: string,
          expectedPhase: Parameters<
            NodeAdminClient["transition"]
          >[0]["expectedPhase"],
          phase: Parameters<NodeAdminClient["transition"]>[0]["phase"],
          options: OwnedOptions,
          command: Command,
        ) => {
          if (
            !maintenancePhases.has(expectedPhase) ||
            !maintenancePhases.has(phase)
          ) {
            throw new Error("maintenance phase is invalid");
          }
          const result = await createClient(command).transition({
            operationId,
            ownerSecret: readOwner(command, operationId),
            expectedPhase,
            phase,
          });
          printResult(options, result);
        },
      ),
    );

  maintenance
    .command("release <operation-id>")
    .description("Unquiesce daemons, then release the database lease")
    .requiredOption(
      "--resolution <resolution>",
      "completed, rolled-back, or force-aborted",
    )
    .option("--json", "Output JSON")
    .action(
      action(
        async (
          operationId: string,
          options: OwnedOptions & {
            resolution: Parameters<NodeAdminClient["release"]>[0]["resolution"];
          },
          command: Command,
        ) => {
          if (!maintenanceResolutions.has(options.resolution)) {
            throw new Error(
              "--resolution must be completed, rolled-back, or force-aborted",
            );
          }
          const result = await createClient(command).release({
            operationId,
            ownerSecret: readOwner(command, operationId),
            resolution: options.resolution,
          });
          unlinkSync(operationPath(command, operationId));
          printResult(options, result);
        },
      ),
    );

  maintenance
    .command("recover <operation-id>")
    .description(
      "Force-abort an owned draining, sealing, or rollback-failed lease",
    )
    .option("--json", "Output JSON")
    .action(
      action(
        async (
          operationId: string,
          options: OwnedOptions,
          command: Command,
        ) => {
          const result = await createClient(command).recover({
            operationId,
            ownerSecret: readOwner(command, operationId),
          });
          unlinkSync(operationPath(command, operationId));
          printResult(options, result);
        },
      ),
    );
}
