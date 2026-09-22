import { Command } from "commander";
import type { ThreadBranchPromotionResponse } from "@bb/server-contract";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { outputJson } from "../helpers.js";

function printPromotion(result: ThreadBranchPromotionResponse): void {
  if (result === null) {
    console.log("No branch promotion operation.");
    return;
  }
  console.log(`Operation: ${result.operationId}`);
  console.log(`Phase: ${result.phase}`);
  console.log(`Checkout: ${result.intent.path}`);
  console.log(`Target branch: ${result.intent.target.name}`);
  const snapshot = result.snapshot;
  if (snapshot === null) {
    console.log("No host observation available; recovery remains blocked.");
    return;
  }
  console.log(`Host phase: ${snapshot.phase}`);
  console.log(`Current branch: ${snapshot.branchName ?? "detached"}`);
  console.log(`Current HEAD: ${snapshot.headSha ?? "unborn"}`);
  console.log(`Command terminated: ${snapshot.commandTerminated}`);
  console.log(`Observation: ${snapshot.observation}`);
  if (snapshot.message) console.log(snapshot.message);
  if (snapshot.resolution) console.log(`Resolution: ${snapshot.resolution}`);
  console.log(
    "--accept-current accepts the requested target at the observed HEAD; --keep-current declines promotion and stays on the observed branch. Recovery does not mutate Git.",
  );
}

export function registerPromotionCommands(
  parent: Command,
  getUrl: () => string,
): void {
  const promotion = parent
    .command("promotion")
    .description(
      "Inspect or recover checkout branch promotion without mutating Git",
    );
  promotion
    .command("inspect <id>")
    .description(
      "Inspect the host outcome and observation token; unknown command termination blocks recovery",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (threadId: string, opts: { json?: boolean }) => {
        const result = await createCliBbSdk(
          getUrl(),
        ).threads.inspectBranchPromotion({ threadId });
        if (!outputJson(opts, result)) printPromotion(result);
      }),
    );
  promotion
    .command("resolve <id>")
    .description(
      "Resolve a proven-stopped operation using the latest inspection; does not mutate Git",
    )
    .requiredOption("--operation <id>", "Operation ID from inspect")
    .requiredOption(
      "--observation <token>",
      "Latest host observation token from inspect",
    )
    .option(
      "--accept-current",
      "Accept the requested target at the observed HEAD",
    )
    .option(
      "--keep-current",
      "Decline promotion and stay on the observed branch",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          threadId: string,
          opts: {
            operation: string;
            observation: string;
            acceptCurrent?: boolean;
            keepCurrent?: boolean;
            json?: boolean;
          },
        ) => {
          if (Boolean(opts.acceptCurrent) === Boolean(opts.keepCurrent)) {
            throw new Error(
              "Choose exactly one of --accept-current or --keep-current.",
            );
          }
          if (!opts.operation.trim() || !opts.observation.trim()) {
            throw new Error("--operation and --observation must be non-empty.");
          }
          const result = await createCliBbSdk(
            getUrl(),
          ).threads.resolveBranchPromotion({
            threadId,
            operationId: opts.operation,
            observation: opts.observation,
            resolution: opts.acceptCurrent ? "accept-current" : "keep-current",
          });
          if (!outputJson(opts, result)) printPromotion(result);
        },
      ),
    );
}
