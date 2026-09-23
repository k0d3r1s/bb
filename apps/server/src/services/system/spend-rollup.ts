import {
  applySpendContribution,
  emptySpendCursorState,
  foldTokenUsageObservation,
  getSpendCursor,
  isLiveSpendHistoryComplete,
  isReplayedTokenUsageReading,
  isSpendThreadHistoryComplete,
  isStoredSpendHistoryIntact,
  listSpendBackfillThreads,
  listStoredTokenUsageEvents,
  resolveSpendModel,
  saveSpendCursor,
  type SpendContribution,
  type SpendCursorState,
  type SpendUsageBreakdown,
  type StoredTokenUsageEventRow,
  type TokenUsageObservation,
} from "@bb/db";
import type { DbConnection, DbQueryConnection } from "@bb/db";
import {
  threadEventTokenUsageBreakdownSchema,
  type ThreadEvent,
} from "@bb/domain";
import { z } from "zod";

export interface SpendRollupObservationSource {
  createdAt: number;
  event: Extract<ThreadEvent, { type: "thread/tokenUsage/updated" }>;
  providerId: string;
  sequence: number;
  threadId: string;
  turnId: string | null;
}

export interface SpendBackfillResult {
  threadsScanned: number;
  usageEventsScanned: number;
  contributionsApplied: number;
  threadsHistoryComplete: number;
  threadsHistoryPartial: number;
}

type SpendHistoryCompleteness =
  | { kind: "live" }
  | { kind: "backfill"; storedHistoryIntact: boolean };

interface TrackedCursorEntry {
  historyComplete: boolean;
  historicalState: SpendCursorState | null;
  processedFromSequence: number;
  providerThreadId: string;
  state: SpendCursorState;
  threadId: string;
}

const UNKNOWN_MODEL = "";

const storedTokenUsageDataSchema = z.object({
  providerThreadId: z.string().optional(),
  tokenUsage: z.object({
    total: threadEventTokenUsageBreakdownSchema,
    last: threadEventTokenUsageBreakdownSchema,
  }),
});

function toBreakdown(usage: {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}): SpendUsageBreakdown {
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    totalTokens: usage.totalTokens,
  };
}

function parseStoredJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function toStoredObservation(
  row: StoredTokenUsageEventRow,
  providerId: string,
): TokenUsageObservation | null {
  const parsed = storedTokenUsageDataSchema.safeParse(
    parseStoredJson(row.data),
  );
  if (!parsed.success) {
    return null;
  }
  return {
    createdAt: row.createdAt,
    last: toBreakdown(parsed.data.tokenUsage.last),
    providerId,
    providerThreadId:
      row.providerThreadId ?? parsed.data.providerThreadId ?? row.threadId,
    sequence: row.sequence,
    threadId: row.threadId,
    total: toBreakdown(parsed.data.tokenUsage.total),
    turnId: row.turnId,
  };
}

function cursorKey(threadId: string, providerThreadId: string): string {
  return `${threadId}|${providerThreadId}`;
}

function modelForObservation(
  db: DbQueryConnection,
  state: SpendCursorState,
  observation: TokenUsageObservation,
): string {
  if (
    observation.turnId !== null &&
    observation.turnId === state.lastTurnId &&
    state.lastModel !== null
  ) {
    return state.lastModel;
  }
  return (
    resolveSpendModel(db, {
      threadId: observation.threadId,
      sequence: observation.sequence,
    }) ??
    state.lastModel ??
    UNKNOWN_MODEL
  );
}

function mergeContributions(
  contributions: readonly SpendContribution[],
): { contribution: SpendContribution; turns: number }[] {
  const merged = new Map<
    string,
    { contribution: SpendContribution; turns: number }
  >();
  for (const contribution of contributions) {
    const key = [
      contribution.day,
      contribution.threadId,
      contribution.providerId,
      contribution.model,
    ].join("|");
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, {
        contribution: { ...contribution, usage: { ...contribution.usage } },
        turns: 1,
      });
      continue;
    }
    const usage = existing.contribution.usage;
    usage.inputTokens += contribution.usage.inputTokens;
    usage.cachedInputTokens += contribution.usage.cachedInputTokens;
    usage.outputTokens += contribution.usage.outputTokens;
    usage.reasoningOutputTokens += contribution.usage.reasoningOutputTokens;
    usage.totalTokens += contribution.usage.totalTokens;
    existing.contribution.weightedUnits += contribution.weightedUnits;
    existing.contribution.at = Math.max(
      existing.contribution.at,
      contribution.at,
    );
    existing.turns += 1;
  }
  return [...merged.values()];
}

function resolveNewCursorHistoryComplete(
  db: DbQueryConnection,
  observation: TokenUsageObservation,
  completeness: SpendHistoryCompleteness,
): boolean {
  if (completeness.kind === "backfill") {
    return completeness.storedHistoryIntact;
  }
  return isLiveSpendHistoryComplete(db, {
    sequence: observation.sequence,
    threadId: observation.threadId,
  });
}

function foldObservation(
  db: DbQueryConnection,
  state: SpendCursorState,
  observation: TokenUsageObservation,
): ReturnType<typeof foldTokenUsageObservation> {
  return foldTokenUsageObservation(
    state,
    observation,
    modelForObservation(db, state, observation),
    {
      isReplayedReading: () =>
        isReplayedTokenUsageReading(db, {
          threadId: observation.threadId,
          sequence: observation.sequence,
        }),
    },
  );
}

function rollUpObservations(
  db: DbQueryConnection,
  observations: readonly TokenUsageObservation[],
  completeness: SpendHistoryCompleteness,
): number {
  const tracked = new Map<string, TrackedCursorEntry>();
  const contributions: SpendContribution[] = [];

  for (const observation of observations) {
    const key = cursorKey(observation.threadId, observation.providerThreadId);
    let entry = tracked.get(key);
    if (entry === undefined) {
      const stored = getSpendCursor(db, {
        threadId: observation.threadId,
        providerThreadId: observation.providerThreadId,
      });
      entry = {
        historyComplete:
          stored === null
            ? resolveNewCursorHistoryComplete(db, observation, completeness)
            : completeness.kind === "backfill" &&
              completeness.storedHistoryIntact,
        historicalState: null,
        processedFromSequence: stored?.firstSequence ?? observation.sequence,
        providerThreadId: observation.providerThreadId,
        threadId: observation.threadId,
        state: stored ?? emptySpendCursorState(observation.sequence),
      };
      tracked.set(key, entry);
    }
    if (observation.sequence < entry.processedFromSequence) {
      const { next, contribution } = foldObservation(
        db,
        entry.historicalState ?? emptySpendCursorState(observation.sequence),
        observation,
      );
      entry.historicalState = next;
      entry.state = {
        ...entry.state,
        firstSequence: Math.min(entry.state.firstSequence, next.firstSequence),
      };
      if (contribution !== null) {
        contributions.push(contribution);
      }
      continue;
    }
    const { next, contribution } = foldObservation(
      db,
      entry.state,
      observation,
    );
    entry.state = next;
    if (contribution !== null) {
      contributions.push(contribution);
    }
  }

  for (const merged of mergeContributions(contributions)) {
    applySpendContribution(db, merged.contribution, merged.turns);
  }

  for (const entry of tracked.values()) {
    saveSpendCursor(db, {
      threadId: entry.threadId,
      providerThreadId: entry.providerThreadId,
      state: entry.state,
      historyComplete: entry.historyComplete,
    });
  }

  return contributions.length;
}

export function recordSpendForInsertedEvents(
  db: DbQueryConnection,
  sources: readonly SpendRollupObservationSource[],
): number {
  if (sources.length === 0) {
    return 0;
  }
  const observations: TokenUsageObservation[] = sources.map((source) => ({
    createdAt: source.createdAt,
    last: toBreakdown(source.event.tokenUsage.last),
    providerId: source.providerId,
    providerThreadId: source.event.providerThreadId,
    sequence: source.sequence,
    threadId: source.threadId,
    total: toBreakdown(source.event.tokenUsage.total),
    turnId: source.turnId,
  }));
  return rollUpObservations(db, observations, { kind: "live" });
}

export function backfillSpend(db: DbConnection): SpendBackfillResult {
  const threads = listSpendBackfillThreads(db);
  let usageEventsScanned = 0;
  let contributionsApplied = 0;
  let threadsHistoryComplete = 0;

  for (const thread of threads) {
    const outcome = db.transaction(
      (tx) => {
        const rows = listStoredTokenUsageEvents(tx, {
          threadId: thread.threadId,
        });
        const observations = rows.flatMap((row) => {
          const observation = toStoredObservation(row, thread.providerId);
          return observation === null ? [] : [observation];
        });
        const applied = rollUpObservations(tx, observations, {
          kind: "backfill",
          storedHistoryIntact: isStoredSpendHistoryIntact(tx, {
            threadId: thread.threadId,
          }),
        });
        return {
          applied,
          scanned: rows.length,
          historyComplete: isSpendThreadHistoryComplete(tx, {
            threadId: thread.threadId,
          }),
        };
      },
      { behavior: "immediate" },
    );
    usageEventsScanned += outcome.scanned;
    contributionsApplied += outcome.applied;
    if (outcome.historyComplete) {
      threadsHistoryComplete += 1;
    }
  }

  return {
    threadsScanned: threads.length,
    usageEventsScanned,
    contributionsApplied,
    threadsHistoryComplete,
    threadsHistoryPartial: threads.length - threadsHistoryComplete,
  };
}
