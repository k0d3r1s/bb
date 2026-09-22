import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { experimental_sanitizeInheritedChildProcessEnv } from "@get-bb/plugin-sdk/host";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  branchPromotionIntentSchema,
  branchPromotionRequestSchema,
  branchPromotionSnapshotSchema,
  type BranchPromotionIntent,
  type BranchPromotionRequest,
  type BranchPromotionSnapshot,
} from "bb-checkout-contract/branch-promotion";
import { runGit } from "bb-environment-provider-host/git";
import { tryWithCheckoutMutationLock } from "bb-environment-provider-host/locks";
import { withProcessLocalQueuedLocks } from "bb-environment-provider-host/process-local-lock";
import {
  emitStep,
  type ProgressCallback,
} from "bb-environment-provider-host/transcript";
import { inspectCheckout } from "./checkout.js";
import { listLocalBranches } from "./git.js";

const receiptSchema = z
  .object({
    intent: branchPromotionIntentSchema,
    commandGroupId: z.number().int().positive().nullable(),
    snapshot: branchPromotionSnapshotSchema,
  })
  .strict();
type Receipt = z.infer<typeof receiptSchema>;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readReceipt(file: string): Promise<Receipt | null> {
  try {
    return receiptSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await fs.open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeReceipt(file: string, receipt: Receipt): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await syncDirectory(path.dirname(path.dirname(file)));
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(receipt));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function contentFingerprint(cwd: string): Promise<string> {
  const hash = createHash("sha256");
  const index = await runGit(["ls-files", "--stage", "-z"], { cwd });
  hash.update(JSON.stringify(["index", digest(index.stdout)]));
  const changed = await runGit(
    [
      "ls-files",
      "--modified",
      "--deleted",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    { cwd },
  );
  for (const file of [
    ...new Set(changed.stdout.split("\0").filter(Boolean)),
  ].sort()) {
    const absolute = path.join(cwd, file);
    const stat = await fs.lstat(absolute).catch((error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      )
        return null;
      throw error;
    });
    if (stat === null) {
      hash.update(JSON.stringify([file, "missing"]));
      continue;
    }
    const payload = createHash("sha256");
    if (stat.isSymbolicLink()) payload.update(await fs.readlink(absolute));
    else if (stat.isFile())
      for await (const chunk of createReadStream(absolute))
        payload.update(chunk);
    hash.update(JSON.stringify([file, stat.mode, payload.digest("hex")]));
  }
  return hash.digest("hex");
}

async function observe(intent: BranchPromotionIntent) {
  const inspection = await inspectCheckout({ path: intent.path });
  const checkout = inspection.isGitRepo ? inspection.checkout : null;
  const status = inspection.isGitRepo
    ? (
        await runGit(
          [
            "--no-optional-locks",
            "status",
            "--porcelain=v2",
            "--untracked-files=all",
          ],
          { cwd: intent.path },
        )
      ).stdout
    : "";
  return {
    inspection,
    branchName:
      checkout?.kind === "branch" || checkout?.kind === "unborn"
        ? checkout.branchName
        : null,
    headSha:
      checkout?.kind === "branch" || checkout?.kind === "detached"
        ? checkout.headSha
        : null,
    observation: digest(
      JSON.stringify({
        operationId: intent.operationId,
        inspection,
        status,
        contents: inspection.isGitRepo
          ? await contentFingerprint(intent.path)
          : null,
      }),
    ),
  };
}

function snapshot(
  intent: BranchPromotionIntent,
  observed: Awaited<ReturnType<typeof observe>>,
  phase: BranchPromotionSnapshot["phase"],
  message: string | null,
  replayed: boolean,
): BranchPromotionSnapshot {
  return {
    operationId: intent.operationId,
    phase,
    branchName: observed.branchName,
    headSha: observed.headSha,
    observation: observed.observation,
    commandTerminated: true,
    resolution: null,
    message,
    replayed,
  };
}

async function refusal(
  intent: BranchPromotionIntent,
  observed: Awaited<ReturnType<typeof observe>>,
): Promise<string | null> {
  if (process.platform === "win32")
    return "Branch promotion requires a POSIX host";
  if (!observed.inspection.isGitRepo)
    return "Workspace is not a Git repository";
  if (
    observed.branchName !== intent.sourceBranch ||
    observed.headSha !== intent.sourceHead
  )
    return "Source branch or HEAD changed before branch promotion";
  if (observed.inspection.operation.kind !== "none")
    return "Cannot promote a branch during a Git operation";
  if (observed.inspection.hasUncommittedChanges)
    return "Cannot promote a branch with uncommitted changes";
  const exists = (await listLocalBranches(intent.path)).includes(
    intent.target.name,
  );
  if (intent.target.kind === "new" && exists)
    return "Target branch already exists";
  if (intent.target.kind === "existing" && !exists)
    return "Target local branch does not exist";
  return null;
}

function commandTerminated(groupId: number | null): boolean {
  if (groupId === null) return true;
  try {
    process.kill(-groupId, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

async function switchWithReceipt(args: {
  intent: BranchPromotionIntent;
  file: string;
  observed: Awaited<ReturnType<typeof observe>>;
  signal: AbortSignal | undefined;
}): Promise<void> {
  const { intent, file, observed, signal } = args;
  const command =
    intent.target.kind === "new"
      ? ["switch", "-c", intent.target.name, intent.sourceHead]
      : ["switch", "--no-guess", intent.target.name];
  const child = spawn(
    "/bin/sh",
    [
      "-c",
      'IFS= read -r token || exit 125; [ "$token" = go ] || exit 125; exec git "$@"',
      "bb-branch-promotion",
      ...command,
    ],
    {
      cwd: intent.path,
      detached: true,
      env: experimental_sanitizeInheritedChildProcessEnv({ env: process.env }),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let error: Error | null = null;
  let stderr = "";
  child.on("error", (cause) => {
    error = cause;
  });
  child.stdin.on("error", (cause) => {
    error = cause;
  });
  child.stdout.resume();
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 65536) stderr += chunk.toString();
  });
  const closed = new Promise<number | null>((resolve) =>
    child.once("close", resolve),
  );
  const abort = () => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (cause) {
      if (
        !(cause instanceof Error && "code" in cause && cause.code === "ESRCH")
      )
        error = cause instanceof Error ? cause : new Error(String(cause));
    }
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (child.pid === undefined) {
      await closed;
      throw error ?? new Error("Could not start branch promotion command");
    }
    await writeReceipt(file, {
      intent,
      commandGroupId: child.pid,
      snapshot: {
        ...snapshot(intent, observed, "running", null, false),
        commandTerminated: false,
      },
    });
    if (signal?.aborted) abort();
    else child.stdin.end("go\n");
    const exitCode = await closed;
    if (signal?.aborted) throw new Error("Branch promotion was cancelled");
    if (error !== null) throw error;
    if (exitCode !== 0)
      throw new Error(stderr.trim() || "Git branch promotion failed");
  } finally {
    child.stdin.end();
    await closed;
    signal?.removeEventListener("abort", abort);
  }
}

async function replayReceipt(
  request: BranchPromotionRequest,
  receipt: Receipt,
  observed: Awaited<ReturnType<typeof observe>>,
  file: string,
  terminated: boolean,
): Promise<BranchPromotionSnapshot> {
  const { intent } = request;
  const drifted =
    (receipt.snapshot.phase === "completed" ||
      receipt.snapshot.phase === "resolved") &&
    observed.observation !== receipt.snapshot.observation;
  const phase =
    receipt.snapshot.phase === "running" || drifted
      ? "uncertain"
      : receipt.snapshot.phase;
  const current = {
    ...receipt.snapshot,
    ...snapshot(intent, observed, phase, receipt.snapshot.message, true),
    resolution: receipt.snapshot.resolution,
    commandTerminated: terminated,
  };
  if (!current.commandTerminated)
    return {
      ...current,
      phase: "uncertain",
      message: "Original Git command group has not been confirmed terminated",
    };
  if (
    request.action !== "resolve" ||
    phase === "completed" ||
    phase === "failed" ||
    phase === "resolved"
  )
    return current;
  if (request.observation !== observed.observation)
    return {
      ...current,
      message: "Checkout observation changed; inspect again before resolving",
    };
  if (
    request.resolution === "accept-current" &&
    observed.branchName !== intent.target.name
  )
    return {
      ...current,
      message: "Current branch does not match the promotion target",
    };
  const resolved = {
    ...current,
    phase: "resolved" as const,
    resolution: request.resolution,
    message: null,
    replayed: false,
  };
  await writeReceipt(file, {
    intent,
    commandGroupId: null,
    snapshot: resolved,
  });
  return resolved;
}

async function processRequest(args: {
  request: BranchPromotionRequest;
  file: string;
  signal?: AbortSignal | undefined;
  onProgress?: ProgressCallback | undefined;
}): Promise<BranchPromotionSnapshot> {
  const { request, file, signal, onProgress } = args;
  const { intent } = request;
  const receipt = await readReceipt(file);
  const terminated =
    receipt?.snapshot.commandTerminated === true ||
    commandTerminated(receipt?.commandGroupId ?? null);
  const observed = await observe(intent);
  if (
    receipt !== null &&
    JSON.stringify(receipt.intent) !== JSON.stringify(intent)
  ) {
    return {
      ...snapshot(
        intent,
        observed,
        terminated ? "failed" : "uncertain",
        "Operation ID is already bound to a different intent",
        true,
      ),
      commandTerminated: terminated,
    };
  }
  if (receipt !== null)
    return replayReceipt(request, receipt, observed, file, terminated);
  if (request.action !== "enter") {
    const result = snapshot(
      intent,
      observed,
      "failed",
      "Promotion was not executed; late execution is disabled",
      false,
    );
    await writeReceipt(file, {
      intent,
      commandGroupId: null,
      snapshot: result,
    });
    return result;
  }
  const blocked = signal?.aborted
    ? "Branch promotion was cancelled before execution"
    : await refusal(intent, observed);
  if (blocked !== null) {
    const result = snapshot(intent, observed, "failed", blocked, false);
    await writeReceipt(file, {
      intent,
      commandGroupId: null,
      snapshot: result,
    });
    return result;
  }
  emitStep({
    onProgress,
    key: "branch-promotion",
    text: `Switching to branch ${intent.target.name}`,
    status: "started",
  });
  let phase: BranchPromotionSnapshot["phase"] = "completed";
  let message: string | null = null;
  try {
    await switchWithReceipt({ intent, file, observed, signal });
  } catch (error) {
    phase = "uncertain";
    message = error instanceof Error ? error.message : String(error);
  }
  const executedReceipt = await readReceipt(file);
  const groupId = executedReceipt?.commandGroupId ?? null;
  const terminatedAfterCommand = commandTerminated(groupId);
  const afterCommand = await observe(intent);
  if (!terminatedAfterCommand) {
    phase = "uncertain";
    message = "Original Git command group has not been confirmed terminated";
  } else if (
    phase === "completed" &&
    (afterCommand.branchName !== intent.target.name ||
      (intent.target.kind === "new" &&
        (afterCommand.headSha !== intent.sourceHead ||
          !afterCommand.inspection.isGitRepo ||
          afterCommand.inspection.hasUncommittedChanges)))
  ) {
    phase = "uncertain";
    message = "Checkout no longer matches the requested promotion target";
  }
  const result = {
    ...snapshot(intent, afterCommand, phase, message, false),
    commandTerminated: terminatedAfterCommand,
  };
  await writeReceipt(file, {
    intent,
    commandGroupId: terminatedAfterCommand ? null : groupId,
    snapshot: result,
  });
  emitStep({
    onProgress,
    key: "branch-promotion",
    text:
      phase === "completed"
        ? `Switched to branch ${intent.target.name}`
        : "Branch promotion requires inspection",
    status: phase === "completed" ? "completed" : "failed",
  });
  return result;
}

export async function promoteBranch(args: {
  request: BranchPromotionRequest;
  dataDir: string;
  signal?: AbortSignal | undefined;
  onProgress?: ProgressCallback | undefined;
}): Promise<BranchPromotionSnapshot> {
  const request = branchPromotionRequestSchema.parse(args.request);
  const file = path.join(
    args.dataDir,
    "branch-promotions",
    `${digest(request.intent.operationId)}.json`,
  );
  return withProcessLocalQueuedLocks({
    locks: [{ key: file }],
    work: async () => {
      const result = await tryWithCheckoutMutationLock(
        request.intent.path,
        () => processRequest({ ...args, request, file }),
      );
      if (result !== null) return result;
      throw new Error(
        "Cannot acquire the checkout mutation lock; branch promotion remains pending",
      );
    },
  });
}
