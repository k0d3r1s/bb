import { describe, expect, it } from "vitest";
import {
  emptySpendCursorState,
  foldTokenUsageObservation,
  normalizeSpendUsage,
  spendLocalDay,
  type SpendCursorState,
  type SpendUsageBreakdown,
  type TokenUsageObservation,
} from "../../src/data/thread-spend.js";

interface Reading {
  cached?: number;
  input?: number;
  last: number;
  output?: number;
  sequence: number;
  total: number;
}

const BASE_AT = Date.UTC(2026, 8, 11, 15, 0, 0);

function breakdown(
  total: number,
  parts: { cached?: number; input?: number; output?: number } = {},
): SpendUsageBreakdown {
  const output = parts.output ?? 0;
  const cached = parts.cached ?? 0;
  return {
    inputTokens: parts.input ?? Math.max(0, total - cached - output),
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningOutputTokens: 0,
    totalTokens: total,
  };
}

function observation(
  reading: Reading,
  providerId = "codex",
): TokenUsageObservation {
  return {
    createdAt: BASE_AT + reading.sequence,
    last: breakdown(reading.last, {
      cached: reading.cached,
      input: reading.input,
      output: reading.output,
    }),
    providerId,
    providerThreadId: "conversation-1",
    sequence: reading.sequence,
    threadId: "thr_spend",
    total: breakdown(reading.total),
    turnId: null,
  };
}

function play(
  readings: readonly Reading[],
  options: {
    providerId?: string;
    replayed?: ReadonlySet<number>;
    state?: SpendCursorState;
  } = {},
): { contributed: number; rows: number; state: SpendCursorState } {
  let state = options.state ?? emptySpendCursorState(readings[0]?.sequence ?? 1);
  let contributed = 0;
  let rows = 0;
  for (const reading of readings) {
    const result = foldTokenUsageObservation(
      state,
      observation(reading, options.providerId),
      "a-model",
      {
        isReplayedReading: () =>
          options.replayed?.has(reading.sequence) === true,
      },
    );
    state = result.next;
    if (result.contribution !== null) {
      contributed += result.contribution.usage.totalTokens;
      rows += 1;
    }
  }
  return { contributed, rows, state };
}

describe("spend fold", () => {
  it("drops a re-emitted reading whose running total did not advance", () => {
    expect(
      play([
        { sequence: 1, total: 100, last: 100 },
        { sequence: 2, total: 100, last: 100 },
        { sequence: 3, total: 250, last: 150 },
      ]).contributed,
    ).toBe(250);
  });

  it("still drops a repeat that arrives in a later batch", () => {
    const first = play([
      { sequence: 1, total: 100, last: 100 },
      { sequence: 2, total: 100, last: 100 },
    ]);
    const second = play([{ sequence: 3, total: 100, last: 100 }], {
      state: first.state,
    });
    expect(first.contributed + second.contributed).toBe(100);
  });

  it("counts a turn after a provider process restart", () => {
    expect(
      play([
        { sequence: 1, total: 100, last: 100 },
        { sequence: 2, total: 250, last: 150 },
        { sequence: 3, total: 40, last: 40 },
        { sequence: 4, total: 90, last: 50 },
      ]).contributed,
    ).toBe(340);
  });

  it("ignores an event at or below the cursor", () => {
    const first = play([
      { sequence: 1, total: 100, last: 100 },
      { sequence: 2, total: 250, last: 150 },
    ]);
    const replayed = play(
      [
        { sequence: 1, total: 100, last: 100 },
        { sequence: 2, total: 250, last: 150 },
      ],
      { state: first.state },
    );
    expect(first.contributed).toBe(250);
    expect(replayed.contributed).toBe(0);
    expect(replayed.rows).toBe(0);
  });

  it("drops a whole batch the daemon retried under new sequences", () => {
    const first = play([
      { sequence: 1, total: 100, last: 100 },
      { sequence: 2, total: 250, last: 150 },
    ]);
    const retried = play(
      [
        { sequence: 3, total: 100, last: 100 },
        { sequence: 4, total: 250, last: 150 },
      ],
      { state: first.state, replayed: new Set([3]) },
    );
    expect(first.contributed).toBe(250);
    expect(retried.contributed).toBe(0);
    expect(retried.state.lastSequence).toBe(4);
    expect(retried.state.lastTotalTokens).toBe(250);
  });

  it("drops a retried mid-run batch on the running total alone", () => {
    const first = play([
      { sequence: 1, total: 100, last: 100 },
      { sequence: 2, total: 250, last: 150 },
      { sequence: 3, total: 400, last: 150 },
    ]);
    const retried = play(
      [
        { sequence: 4, total: 250, last: 150 },
        { sequence: 5, total: 400, last: 150 },
      ],
      { state: first.state },
    );
    expect(first.contributed).toBe(400);
    expect(retried.contributed).toBe(0);
  });

  it("counts the rest of a run that restarted below the previous total", () => {
    const result = play([
      { sequence: 1, total: 100, last: 100 },
      { sequence: 2, total: 250, last: 150 },
      { sequence: 3, total: 40, last: 40 },
      { sequence: 4, total: 90, last: 50 },
      { sequence: 5, total: 200, last: 110 },
      { sequence: 6, total: 300, last: 100 },
    ]);
    expect(result.contributed).toBe(550);
    expect(result.state.lastTotalTokens).toBe(300);
  });

  it("contributes nothing for a zero-token reading", () => {
    expect(play([{ sequence: 1, total: 0, last: 0 }]).rows).toBe(0);
  });

  it("records codex cached input disjointly from fresh input", () => {
    const result = foldTokenUsageObservation(
      emptySpendCursorState(1),
      {
        createdAt: BASE_AT,
        last: {
          inputTokens: 208_000,
          cachedInputTokens: 208_000,
          outputTokens: 1_000,
          reasoningOutputTokens: 0,
          totalTokens: 209_000,
        },
        providerId: "codex",
        providerThreadId: "conversation-1",
        sequence: 1,
        threadId: "thr_spend",
        total: {
          inputTokens: 208_000,
          cachedInputTokens: 208_000,
          outputTokens: 1_000,
          reasoningOutputTokens: 0,
          totalTokens: 209_000,
        },
        turnId: null,
      },
      "gpt-5",
    );
    expect(result.contribution?.usage.inputTokens).toBe(0);
    expect(result.contribution?.usage.cachedInputTokens).toBe(208_000);
    expect(result.contribution?.usage.totalTokens).toBe(209_000);
  });

  it("leaves an anthropic reading alone", () => {
    const usage: SpendUsageBreakdown = {
      inputTokens: 8_295,
      cachedInputTokens: 2_065_773,
      outputTokens: 11_062,
      reasoningOutputTokens: 0,
      totalTokens: 2_085_130,
    };
    expect(normalizeSpendUsage(usage, "claude-code")).toEqual(usage);
  });

  it("normalises a small cached prefix, and does so only once", () => {
    const reported: SpendUsageBreakdown = {
      inputTokens: 25_699,
      cachedInputTokens: 4_224,
      outputTokens: 800,
      reasoningOutputTokens: 0,
      totalTokens: 26_499,
    };
    const once = normalizeSpendUsage(reported, "codex");
    expect(once.inputTokens).toBe(21_475);
    expect(normalizeSpendUsage(once, "codex")).toEqual(once);
  });

  it("buckets by the local calendar day either side of midnight", () => {
    const endOfDay = new Date(2026, 8, 11, 23, 59, 59, 999).getTime();
    const startOfNext = new Date(2026, 8, 12, 0, 0, 0, 0).getTime();
    expect(spendLocalDay(endOfDay)).toBe("2026-09-11");
    expect(spendLocalDay(startOfNext)).toBe("2026-09-12");
  });

  it("keeps the raw event time on the contribution so a row can be re-bucketed", () => {
    const result = foldTokenUsageObservation(
      emptySpendCursorState(1),
      observation({ sequence: 1, total: 100, last: 100 }),
      "a-model",
    );
    expect(result.contribution?.at).toBe(BASE_AT + 1);
  });
});
