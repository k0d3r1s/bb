import { sql } from "drizzle-orm";
import {
  applySpendContribution,
  emptySpendCursorState,
  saveSpendCursor,
  spendWeightedUnits,
  type SpendUsageBreakdown,
} from "@bb/db";
import { spendRollupResponseSchema } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import { withTestHarness } from "../helpers/test-app.js";

const USAGE: SpendUsageBreakdown = {
  inputTokens: 1_000,
  cachedInputTokens: 9_000,
  outputTokens: 500,
  reasoningOutputTokens: 100,
  totalTokens: 10_500,
};

describe("spend rollup route", () => {
  it("groups onto one dimension and reports how partial the history is", async () => {
    await withTestHarness(async (harness) => {
      for (const day of ["2026-09-10", "2026-09-11"]) {
        for (const model of ["gpt-5", "gpt-5-codex"]) {
          applySpendContribution(harness.db, {
            day,
            model,
            providerId: "codex",
            threadId: "thr_one",
            usage: USAGE,
            weightedUnits: spendWeightedUnits(USAGE),
            at: Date.parse(`${day}T12:00:00Z`),
          });
        }
      }

      const ungrouped = spendRollupResponseSchema.parse(
        await readJson(
          await harness.app.request("/api/v1/spend/rollup?from=2026-09-01"),
        ),
      );
      expect(ungrouped.rows).toHaveLength(4);

      const byProvider = spendRollupResponseSchema.parse(
        await readJson(
          await harness.app.request(
            "/api/v1/spend/rollup?from=2026-09-01&groupBy=provider",
          ),
        ),
      );
      expect(byProvider.rows).toHaveLength(1);
      expect(byProvider.rows[0]?.providerId).toBe("codex");
      expect(byProvider.rows[0]?.totalTokens).toBe(USAGE.totalTokens * 4);
      expect(byProvider.rows[0]?.firstEventAt).toBeLessThan(
        byProvider.rows[0]?.lastEventAt ?? 0,
      );

      const byModel = spendRollupResponseSchema.parse(
        await readJson(
          await harness.app.request(
            "/api/v1/spend/rollup?from=2026-09-01&groupBy=model",
          ),
        ),
      );
      expect(byModel.rows.map((row) => row.model).sort()).toEqual([
        "gpt-5",
        "gpt-5-codex",
      ]);
    });
  });

  it("reports dollars only where a price exists", async () => {
    await withTestHarness(async (harness) => {
      for (const model of ["gpt-5", "gpt-5-codex"]) {
        applySpendContribution(harness.db, {
          day: "2026-09-11",
          model,
          providerId: "codex",
          threadId: "thr_one",
          usage: USAGE,
          weightedUnits: spendWeightedUnits(USAGE),
          at: Date.parse("2026-09-11T12:00:00Z"),
        });
      }
      const unpriced = spendRollupResponseSchema.parse(
        await readJson(
          await harness.app.request("/api/v1/spend/rollup?from=2026-09-01"),
        ),
      );
      expect(unpriced.rows.map((row) => row.costUsd)).toEqual([null, null]);

      harness.db.run(
        sql`INSERT INTO fork_spend_prices (provider_id, model,
              input_usd_per_mtok, cached_input_usd_per_mtok,
              output_usd_per_mtok)
            VALUES ('codex', 'gpt-5', 1.25, 0.125, 10.0)`,
      );
      const priced = spendRollupResponseSchema.parse(
        await readJson(
          await harness.app.request("/api/v1/spend/rollup?from=2026-09-01"),
        ),
      );
      const gpt5 = priced.rows.find((row) => row.model === "gpt-5");
      expect(gpt5?.costUsd).toBeCloseTo(
        (1_000 * 1.25 + 9_000 * 0.125 + 500 * 10.0) / 1_000_000,
        10,
      );
      expect(
        priced.rows.find((row) => row.model === "gpt-5-codex")?.costUsd,
      ).toBeNull();
      const grouped = spendRollupResponseSchema.parse(
        await readJson(
          await harness.app.request(
            "/api/v1/spend/rollup?from=2026-09-01&groupBy=provider",
          ),
        ),
      );
      expect(grouped.rows[0]?.costUsd).toBeNull();
    });
  });

  it("orders a by-day grouping by day rather than by volume", async () => {
    await withTestHarness(async (harness) => {
      const volumes: [string, number][] = [
        ["2026-09-09", 1],
        ["2026-09-10", 3],
        ["2026-09-11", 2],
      ];
      for (const [day, multiple] of volumes) {
        const usage = { ...USAGE, totalTokens: USAGE.totalTokens * multiple };
        applySpendContribution(harness.db, {
          day,
          model: "gpt-5",
          providerId: "codex",
          threadId: "thr_one",
          usage,
          weightedUnits: spendWeightedUnits(usage),
          at: Date.parse(`${day}T12:00:00Z`),
        });
      }
      const byDay = spendRollupResponseSchema.parse(
        await readJson(
          await harness.app.request(
            "/api/v1/spend/rollup?from=2026-09-01&groupBy=day",
          ),
        ),
      );
      expect(byDay.rows.map((row) => row.day)).toEqual([
        "2026-09-11",
        "2026-09-10",
        "2026-09-09",
      ]);
      expect(byDay.rows.map((row) => row.threadId)).toEqual(["*", "*", "*"]);
    });
  });

  it("scopes coverage to the thread and provider filters", async () => {
    await withTestHarness(async (harness) => {
      const threads: [string, string, boolean[]][] = [
        ["thr_complete", "codex", [true]],
        ["thr_partial", "claude-code", [true, false]],
      ];
      for (const [threadId, providerId, cursors] of threads) {
        applySpendContribution(harness.db, {
          day: "2026-09-11",
          model: "a-model",
          providerId,
          threadId,
          usage: USAGE,
          weightedUnits: spendWeightedUnits(USAGE),
          at: Date.parse("2026-09-11T12:00:00Z"),
        });
        for (const [index, historyComplete] of cursors.entries()) {
          saveSpendCursor(harness.db, {
            threadId,
            providerThreadId: `${threadId}-provider-${index}`,
            state: emptySpendCursorState(1),
            historyComplete,
          });
        }
      }
      const coverage = async (query: string) =>
        spendRollupResponseSchema.parse(
          await readJson(
            await harness.app.request(
              `/api/v1/spend/rollup?from=2026-09-01${query}`,
            ),
          ),
        ).coverage;

      expect(await coverage("")).toEqual({
        threads: 2,
        historyComplete: 1,
        historyPartial: 1,
      });
      expect(await coverage("&threadId=thr_complete")).toEqual({
        threads: 1,
        historyComplete: 1,
        historyPartial: 0,
      });
      expect(await coverage("&providerId=claude-code")).toEqual({
        threads: 1,
        historyComplete: 0,
        historyPartial: 1,
      });
    });
  });

  it("rejects a day that is not a calendar day", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request(
        "/api/v1/spend/rollup?from=last-tuesday",
      );
      expect(response.status).toBe(400);
    });
  });
});
