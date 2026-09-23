import { Command } from "commander";
import type { SpendGroupByQueryValue } from "@bb/server-contract";
import { action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { renderBorderlessTable } from "../table.js";
import { outputJson } from "./helpers.js";

const DEFAULT_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;

type ResolveServerUrl = () => string;

interface SpendListOptions {
  by?: string;
  from?: string;
  json?: boolean;
  provider?: string;
  thread?: string;
  to?: string;
}

const GROUP_BY_VALUES: readonly SpendGroupByQueryValue[] = [
  "day",
  "thread",
  "provider",
  "model",
];

function localDay(at: number): string {
  const date = new Date(at);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function parseGroupBy(value: string | undefined): SpendGroupByQueryValue {
  if (value === undefined) return "provider";
  const match = GROUP_BY_VALUES.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new Error(`--by must be one of ${GROUP_BY_VALUES.join(", ")}`);
  }
  return match;
}

function compact(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}

function labelFor(
  groupBy: SpendGroupByQueryValue,
  row: { day: string; model: string; providerId: string; threadId: string },
): string {
  if (groupBy === "day") return row.day;
  if (groupBy === "thread") return row.threadId;
  if (groupBy === "provider") return row.providerId;
  return row.model === "" ? "unknown-model" : row.model;
}

export function registerSpendCommands(
  program: Command,
  getUrl: ResolveServerUrl,
): void {
  const spend = program
    .command("spend")
    .description("Token and usage totals recorded by the server");

  spend
    .command("list", { isDefault: true })
    .description("Show recorded token totals")
    .option("--by <dimension>", "day, thread, provider or model")
    .option("--from <day>", "First local day to include (YYYY-MM-DD)")
    .option("--to <day>", "Last local day to include (YYYY-MM-DD)")
    .option("--thread <id>", "Only this thread")
    .option("--provider <id>", "Only this provider")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: SpendListOptions) => {
        const groupBy = parseGroupBy(opts.by);
        const sdk = createCliBbSdk(getUrl());
        const now = Date.now();
        const result = await sdk.spend.rollup({
          from: opts.from ?? localDay(now - (DEFAULT_WINDOW_DAYS - 1) * DAY_MS),
          to: opts.to ?? localDay(now),
          groupBy,
          ...(opts.thread === undefined ? {} : { threadId: opts.thread }),
          ...(opts.provider === undefined ? {} : { providerId: opts.provider }),
        });
        if (outputJson(opts, result)) return;
        if (result.rows.length === 0) {
          console.log("No spend recorded for this window.");
          console.log(
            "If the rollup is new, run `bb spend backfill` to replay the usage events still in the store.",
          );
          return;
        }
        const priced = result.rows.some((row) => row.costUsd !== null);
        console.log(
          renderBorderlessTable(
            {
              head: [
                groupBy,
                "total",
                "fresh in",
                "cached",
                "out",
                "weighted",
                "turns",
                ...(priced ? ["usd"] : []),
              ],
              colWidths: [34, 10, 10, 10, 10, 12, 7, ...(priced ? [10] : [])],
            },
            result.rows.map((row) => [
              labelFor(groupBy, row),
              compact(row.totalTokens),
              compact(row.inputTokens),
              compact(row.cachedInputTokens),
              compact(row.outputTokens),
              compact(Math.round(row.weightedUnits)),
              `${row.turns}`,
              ...(priced
                ? [row.costUsd === null ? "no price" : row.costUsd.toFixed(2)]
                : []),
            ]),
          ),
        );
        console.log("");
        console.log(
          "weighted = fresh input x1 + cached x0.1 + output x5. A cost proxy, not money.",
        );
        if (!priced)
          console.log("No dollar figure: bb does not guess a billing rate.");
        if (result.coverage.historyPartial > 0) {
          console.log(
            `${result.coverage.historyPartial} of ${result.coverage.threads} threads could not be proven complete; their totals are floors.`,
          );
        }
      }),
    );

  spend
    .command("backfill")
    .description("Replay the usage events still in the event store")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: { json?: boolean }) => {
        const result = await createCliBbSdk(getUrl()).spend.backfill();
        if (outputJson(opts, result)) return;
        console.log(`Threads scanned:        ${result.threadsScanned}`);
        console.log(`Usage events scanned:   ${result.usageEventsScanned}`);
        console.log(`Contributions applied:  ${result.contributionsApplied}`);
        console.log(`History complete:       ${result.threadsHistoryComplete}`);
        console.log(`History partial:        ${result.threadsHistoryPartial}`);
        if (result.threadsHistoryPartial > 0) {
          console.log("");
          console.log(
            "A partial thread could not be proven complete: usage events may have been pruned before the rollup recorded them. Its recorded total is a floor.",
          );
        }
      }),
    );
}
