import {
  applySpendContribution,
  emptySpendCursorState,
  foldTokenUsageObservation,
  getSpendCursor,
  isSpendHistoryComplete,
  listSpendBackfillThreads,
  listStoredTokenUsageEvents,
  resolveSpendModel,
  saveSpendCursor,
  type SpendContribution,
  type SpendCursorState,
  type SpendUsageBreakdown,
  type TokenUsageObservation,
} from "@bb/db";
import type { DbConnection, DbQueryConnection } from "@bb/db";
import type { ThreadEvent } from "@bb/domain";

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

interface TrackedCursorEntry {
  historyComplete: boolean | undefined;
  historicalState: SpendCursorState | null;
  processedFromSequence: number;
  providerThreadId: string;
  state: SpendCursorState;
  threadId: string;
}

const UNKNOWN_MODEL = "";

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

function readStoredUsage(raw: unknown): SpendUsageBreakdown {
  const record = (raw ?? {}) as Record<string, unknown>;
  const read = (key: string): number =>
    typeof record[key] === "number" ? (record[key] as number) : 0;
  return {
    inputTokens: read("inputTokens"),
    cachedInputTokens: read("cachedInputTokens"),
    outputTokens: read("outputTokens"),
    reasoningOutputTokens: read("reasoningOutputTokens"),
    totalTokens: read("totalTokens"),
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

function resolveHistoryComplete(
  db: DbQueryConnection,
  args: { firstSequence: number; threadId: string },
): boolean {
  return isSpendHistoryComplete(db, args);
}

function rollUpObservations(
  db: DbQueryConnection,
  observations: readonly TokenUsageObservation[],
  options: { historyComplete?: boolean } = {},
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
      const historyComplete =
        options.historyComplete ??
        (stored === null
          ? resolveHistoryComplete(db, {
              firstSequence: observation.sequence,
              threadId: observation.threadId,
            })
          : undefined);
      entry = {
        historyComplete,
        historicalState: null,
        processedFromSequence: stored?.firstSequence ?? observation.sequence,
        providerThreadId: observation.providerThreadId,
        threadId: observation.threadId,
        state: stored ?? emptySpendCursorState(observation.sequence),
      };
    }
    if (observation.sequence < entry.processedFromSequence) {
      const historicalState =
        entry.historicalState ?? emptySpendCursorState(observation.sequence);
      const model = modelForObservation(db, historicalState, observation);
      const { next, contribution } = foldTokenUsageObservation(
        historicalState,
        observation,
        model,
      );
      entry.historicalState = next;
      entry.state = {
        ...entry.state,
        firstSequence: Math.min(entry.state.firstSequence, next.firstSequence),
      };
      tracked.set(key, entry);
      if (contribution !== null) {
        contributions.push(contribution);
      }
      continue;
    }
    const model = modelForObservation(db, entry.state, observation);
    const { next, contribution } = foldTokenUsageObservation(
      entry.state,
      observation,
      model,
    );
    entry.state = next;
    tracked.set(key, entry);
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
  return rollUpObservations(db, observations);
}

export function backfillSpend(db: DbConnection): SpendBackfillResult {
  const threads = listSpendBackfillThreads(db);
  let usageEventsScanned = 0;
  let contributionsApplied = 0;
  let threadsHistoryComplete = 0;

  for (const thread of threads) {
    const rows = listStoredTokenUsageEvents(db, { threadId: thread.threadId });
    const observations: TokenUsageObservation[] = [];
    for (const row of rows) {
      usageEventsScanned += 1;
      const parsed: unknown = JSON.parse(row.data);
      const record = (parsed ?? {}) as Record<string, unknown>;
      const usage = (record.tokenUsage ?? {}) as Record<string, unknown>;
      const announced = record.providerThreadId;
      observations.push({
        createdAt: row.createdAt,
        last: readStoredUsage(usage.last),
        providerId: thread.providerId,
        providerThreadId:
          row.providerThreadId ??
          (typeof announced === "string" ? announced : row.threadId),
        sequence: row.sequence,
        threadId: row.threadId,
        total: readStoredUsage(usage.total),
        turnId: row.turnId,
      });
    }
    const firstSequence = observations[0]?.sequence;
    const historyComplete =
      firstSequence !== undefined &&
      isSpendHistoryComplete(db, {
        firstSequence,
        threadId: thread.threadId,
      });
    contributionsApplied += rollUpObservations(db, observations, {
      historyComplete,
    });
    if (historyComplete) {
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
