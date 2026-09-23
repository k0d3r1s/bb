import { sql, type SQL } from "drizzle-orm";
import type { DbQueryConnection } from "../connection.js";

const DAILY_TABLE = "fork_thread_spend_daily";
const CURSOR_TABLE = "fork_thread_spend_cursor";
const PRICES_TABLE = "fork_spend_prices";

export interface SpendUsageBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface SpendCursorState {
  lastSequence: number;
  lastTotalTokens: number;
  firstSequence: number;
  lastTurnId: string | null;
  lastModel: string | null;
}

export interface TokenUsageObservation {
  createdAt: number;
  last: SpendUsageBreakdown;
  providerId: string;
  providerThreadId: string;
  sequence: number;
  threadId: string;
  total: SpendUsageBreakdown;
  turnId: string | null;
}

export interface SpendContribution {
  day: string;
  model: string;
  providerId: string;
  threadId: string;
  usage: SpendUsageBreakdown;
  weightedUnits: number;
  at: number;
}

export interface SpendRollupRow {
  day: string;
  threadId: string;
  providerId: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  weightedUnits: number;
  turns: number;
  firstEventAt: number;
  lastEventAt: number;
  costUsd: number | null;
}

export interface SpendCoverage {
  threads: number;
  historyComplete: number;
  historyPartial: number;
}

export const SPEND_WEIGHTS = {
  input: 1,
  cachedInput: 0.1,
  output: 5,
} as const;

export function spendWeightedUnits(usage: SpendUsageBreakdown): number {
  return (
    usage.inputTokens * SPEND_WEIGHTS.input +
    usage.cachedInputTokens * SPEND_WEIGHTS.cachedInput +
    usage.outputTokens * SPEND_WEIGHTS.output
  );
}

export function normalizeSpendUsage(
  usage: SpendUsageBreakdown,
  providerId: string,
): SpendUsageBreakdown {
  if (providerId !== "codex") {
    return usage;
  }
  if (usage.cachedInputTokens <= 0) {
    return usage;
  }
  const asInclusive = Math.abs(
    usage.totalTokens - usage.inputTokens - usage.outputTokens,
  );
  const asDisjoint = Math.abs(
    usage.totalTokens -
      usage.inputTokens -
      usage.cachedInputTokens -
      usage.outputTokens,
  );
  if (asInclusive >= asDisjoint) {
    return usage;
  }
  return {
    ...usage,
    inputTokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens),
  };
}

export function spendLocalDay(at: number): string {
  const date = new Date(at);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function emptySpendCursorState(sequence: number): SpendCursorState {
  return {
    lastSequence: 0,
    lastTotalTokens: 0,
    firstSequence: sequence,
    lastTurnId: null,
    lastModel: null,
  };
}

interface SpendFoldOptions {
  isReplayedReading?: () => boolean;
}

type ReadingDisposition = "advance" | "restart" | "stale" | "uncumulative";

function classifyReading(
  state: SpendCursorState,
  total: SpendUsageBreakdown,
  last: SpendUsageBreakdown,
  options: SpendFoldOptions,
): ReadingDisposition {
  if (total.totalTokens <= 0) {
    return "uncumulative";
  }
  if (total.totalTokens > state.lastTotalTokens) {
    return "advance";
  }
  const restartsCumulativeCount =
    total.totalTokens < state.lastTotalTokens &&
    total.totalTokens === last.totalTokens;
  if (restartsCumulativeCount && options.isReplayedReading?.() !== true) {
    return "restart";
  }
  return "stale";
}

export function foldTokenUsageObservation(
  state: SpendCursorState,
  observation: TokenUsageObservation,
  model: string,
  options: SpendFoldOptions = {},
): { next: SpendCursorState; contribution: SpendContribution | null } {
  if (observation.sequence <= state.lastSequence) {
    return { next: state, contribution: null };
  }

  const total = normalizeSpendUsage(observation.total, observation.providerId);
  const last = normalizeSpendUsage(observation.last, observation.providerId);
  const disposition = classifyReading(state, total, last, options);

  const advanced: SpendCursorState = {
    lastSequence: observation.sequence,
    lastTotalTokens:
      disposition === "advance" || disposition === "restart"
        ? total.totalTokens
        : state.lastTotalTokens,
    firstSequence:
      state.firstSequence === 0
        ? observation.sequence
        : Math.min(state.firstSequence, observation.sequence),
    lastTurnId: observation.turnId,
    lastModel: model,
  };

  if (disposition === "stale" || last.totalTokens <= 0) {
    return { next: advanced, contribution: null };
  }

  return {
    next: advanced,
    contribution: {
      day: spendLocalDay(observation.createdAt),
      model,
      providerId: observation.providerId,
      threadId: observation.threadId,
      usage: last,
      weightedUnits: spendWeightedUnits(last),
      at: observation.createdAt,
    },
  };
}

const TOKEN_USAGE_EVENT_TYPE = "thread/tokenUsage/updated";

function hasThreadRewind(
  db: DbQueryConnection,
  args: { threadId: string },
): boolean {
  const row = db.get<{ found: number }>(
    sql`SELECT 1 AS found FROM events
        WHERE thread_id = ${args.threadId}
          AND type = 'system/operation'
          AND json_extract(data, '$.operation') = 'edit_message'
        LIMIT 1`,
  );
  return row?.found === 1;
}

export function isReplayedTokenUsageReading(
  db: DbQueryConnection,
  args: { threadId: string; sequence: number },
): boolean {
  const row = db.get<{ found: number }>(
    sql`SELECT 1 AS found
        FROM events reading
        JOIN events earlier
          ON earlier.thread_id = reading.thread_id
          AND earlier.type = reading.type
          AND earlier.sequence < reading.sequence
          AND earlier.data = reading.data
          AND earlier.turn_id IS reading.turn_id
        WHERE reading.thread_id = ${args.threadId}
          AND reading.sequence = ${args.sequence}
          AND reading.type = ${TOKEN_USAGE_EVENT_TYPE}
        LIMIT 1`,
  );
  return row?.found === 1;
}

export function getSpendCursor(
  db: DbQueryConnection,
  args: { threadId: string; providerThreadId: string },
): SpendCursorState | null {
  const row = db.get<{
    lastSequence: number;
    lastTotalTokens: number;
    firstSequence: number;
    lastTurnId: string | null;
    lastModel: string | null;
  }>(
    sql`SELECT last_sequence AS lastSequence,
               last_total_tokens AS lastTotalTokens,
               first_sequence AS firstSequence,
               last_turn_id AS lastTurnId,
               last_model AS lastModel
        FROM ${sql.raw(CURSOR_TABLE)}
        WHERE thread_id = ${args.threadId}
          AND provider_thread_id = ${args.providerThreadId}`,
  );
  return row ?? null;
}

export function saveSpendCursor(
  db: DbQueryConnection,
  args: {
    threadId: string;
    providerThreadId: string;
    state: SpendCursorState;
    historyComplete: boolean;
  },
): void {
  const historyComplete = args.historyComplete ? 1 : 0;
  db.run(
    sql`INSERT INTO ${sql.raw(CURSOR_TABLE)} (thread_id, provider_thread_id,
          last_sequence, last_total_tokens, first_sequence, history_complete,
          last_turn_id, last_model)
        VALUES (${args.threadId}, ${args.providerThreadId},
          ${args.state.lastSequence}, ${args.state.lastTotalTokens},
          ${args.state.firstSequence}, ${historyComplete},
          ${args.state.lastTurnId}, ${args.state.lastModel})
        ON CONFLICT (thread_id, provider_thread_id) DO UPDATE SET
          last_sequence = excluded.last_sequence,
          last_total_tokens = excluded.last_total_tokens,
          first_sequence = MIN(${sql.raw(CURSOR_TABLE)}.first_sequence,
            excluded.first_sequence),
          history_complete = MAX(${sql.raw(CURSOR_TABLE)}.history_complete,
            excluded.history_complete),
          last_turn_id = excluded.last_turn_id,
          last_model = excluded.last_model`,
  );
}

export function isLiveSpendHistoryComplete(
  db: DbQueryConnection,
  args: { sequence: number; threadId: string },
): boolean {
  const row = db.get<{
    cursors: number;
    partialCursors: number;
    earlierUsage: number;
  }>(
    sql`SELECT
          (SELECT COUNT(*) FROM ${sql.raw(CURSOR_TABLE)}
            WHERE thread_id = ${args.threadId}) AS cursors,
          (SELECT COUNT(*) FROM ${sql.raw(CURSOR_TABLE)}
            WHERE thread_id = ${args.threadId}
              AND history_complete = 0) AS partialCursors,
          EXISTS (SELECT 1 FROM events
            WHERE thread_id = ${args.threadId}
              AND type = ${TOKEN_USAGE_EVENT_TYPE}
              AND sequence < ${args.sequence}) AS earlierUsage`,
  );
  if (row === undefined) {
    return false;
  }
  if (row.cursors > 0) {
    return row.partialCursors === 0;
  }
  return (
    row.earlierUsage === 0 && !hasThreadRewind(db, { threadId: args.threadId })
  );
}

export function isStoredSpendHistoryIntact(
  db: DbQueryConnection,
  args: { threadId: string },
): boolean {
  const row = db.get<{ stored: number; latest: number | null }>(
    sql`SELECT COUNT(*) AS stored, MAX(sequence) AS latest
        FROM events
        WHERE thread_id = ${args.threadId}`,
  );
  if (row === undefined || row.latest === null || row.stored !== row.latest) {
    return false;
  }
  return !hasThreadRewind(db, { threadId: args.threadId });
}

export function isSpendThreadHistoryComplete(
  db: DbQueryConnection,
  args: { threadId: string },
): boolean {
  const row = db.get<{ cursors: number; partialCursors: number }>(
    sql`SELECT COUNT(*) AS cursors,
               COUNT(CASE WHEN history_complete = 0 THEN 1 END) AS partialCursors
        FROM ${sql.raw(CURSOR_TABLE)}
        WHERE thread_id = ${args.threadId}`,
  );
  return row !== undefined && row.cursors > 0 && row.partialCursors === 0;
}

export function applySpendContribution(
  db: DbQueryConnection,
  contribution: SpendContribution,
  turns = 1,
): void {
  db.run(
    sql`INSERT INTO ${sql.raw(DAILY_TABLE)} (day, thread_id, provider_id, model,
          input_tokens, cached_input_tokens, output_tokens,
          reasoning_output_tokens, total_tokens, weighted_units, turns,
          first_event_at, last_event_at)
        VALUES (${contribution.day}, ${contribution.threadId},
          ${contribution.providerId}, ${contribution.model},
          ${contribution.usage.inputTokens},
          ${contribution.usage.cachedInputTokens},
          ${contribution.usage.outputTokens},
          ${contribution.usage.reasoningOutputTokens},
          ${contribution.usage.totalTokens},
          ${contribution.weightedUnits}, ${turns},
          ${contribution.at}, ${contribution.at})
        ON CONFLICT (day, thread_id, provider_id, model) DO UPDATE SET
          input_tokens = input_tokens + excluded.input_tokens,
          cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
          output_tokens = output_tokens + excluded.output_tokens,
          reasoning_output_tokens =
            reasoning_output_tokens + excluded.reasoning_output_tokens,
          total_tokens = total_tokens + excluded.total_tokens,
          weighted_units = weighted_units + excluded.weighted_units,
          turns = turns + excluded.turns,
          first_event_at = MIN(first_event_at, excluded.first_event_at),
          last_event_at = MAX(last_event_at, excluded.last_event_at)`,
  );
}

export type SpendGroupBy = "day" | "thread" | "provider" | "model";

export interface ListSpendRollupArgs {
  from?: string | undefined;
  to?: string | undefined;
  threadId?: string | undefined;
  providerId?: string | undefined;
}

const SPEND_ALL = "*";

const SPEND_GROUP_COLUMNS: Record<SpendGroupBy, string> = {
  day: "day",
  thread: "thread_id",
  provider: "provider_id",
  model: "model",
};

function spendRollupConditions(args: ListSpendRollupArgs): SQL {
  const conditions = [sql`1 = 1`];
  if (args.from !== undefined) {
    conditions.push(sql`rollup.day >= ${args.from}`);
  }
  if (args.to !== undefined) {
    conditions.push(sql`rollup.day <= ${args.to}`);
  }
  if (args.threadId !== undefined) {
    conditions.push(sql`rollup.thread_id = ${args.threadId}`);
  }
  if (args.providerId !== undefined) {
    conditions.push(sql`rollup.provider_id = ${args.providerId}`);
  }
  return sql.join(conditions, sql` AND `);
}

const ROLLUP_COST_SQL = sql`CASE WHEN price.provider_id IS NULL THEN NULL ELSE
  (rollup.input_tokens * price.input_usd_per_mtok
   + rollup.cached_input_tokens * price.cached_input_usd_per_mtok
   + rollup.output_tokens * price.output_usd_per_mtok) / 1000000.0
END`;

export function listSpendRollupRows(
  db: DbQueryConnection,
  args: ListSpendRollupArgs,
): SpendRollupRow[] {
  return db.all<SpendRollupRow>(
    sql`SELECT rollup.day AS day,
               rollup.thread_id AS threadId,
               rollup.provider_id AS providerId,
               rollup.model AS model,
               rollup.input_tokens AS inputTokens,
               rollup.cached_input_tokens AS cachedInputTokens,
               rollup.output_tokens AS outputTokens,
               rollup.reasoning_output_tokens AS reasoningOutputTokens,
               rollup.total_tokens AS totalTokens,
               rollup.weighted_units AS weightedUnits,
               rollup.turns AS turns,
               rollup.first_event_at AS firstEventAt,
               rollup.last_event_at AS lastEventAt,
               ${ROLLUP_COST_SQL} AS costUsd
        FROM ${sql.raw(DAILY_TABLE)} rollup
        LEFT JOIN ${sql.raw(PRICES_TABLE)} price
          ON price.provider_id = rollup.provider_id
          AND price.model = rollup.model
        WHERE ${spendRollupConditions(args)}
        ORDER BY rollup.day DESC, rollup.total_tokens DESC`,
  );
}

export function listSpendRollupGroups(
  db: DbQueryConnection,
  args: ListSpendRollupArgs & { groupBy: SpendGroupBy },
): SpendRollupRow[] {
  const groupColumn = sql.raw(`rollup.${SPEND_GROUP_COLUMNS[args.groupBy]}`);
  const dimension = (groupBy: SpendGroupBy): SQL =>
    groupBy === args.groupBy ? groupColumn : sql`${SPEND_ALL}`;
  const order =
    args.groupBy === "day"
      ? sql`day DESC`
      : sql`totalTokens DESC, ${groupColumn} ASC`;
  return db.all<SpendRollupRow>(
    sql`SELECT ${dimension("day")} AS day,
               ${dimension("thread")} AS threadId,
               ${dimension("provider")} AS providerId,
               ${dimension("model")} AS model,
               SUM(rollup.input_tokens) AS inputTokens,
               SUM(rollup.cached_input_tokens) AS cachedInputTokens,
               SUM(rollup.output_tokens) AS outputTokens,
               SUM(rollup.reasoning_output_tokens) AS reasoningOutputTokens,
               SUM(rollup.total_tokens) AS totalTokens,
               SUM(rollup.weighted_units) AS weightedUnits,
               SUM(rollup.turns) AS turns,
               MIN(rollup.first_event_at) AS firstEventAt,
               MAX(rollup.last_event_at) AS lastEventAt,
               CASE WHEN COUNT(price.provider_id) = COUNT(*)
                 THEN SUM(${ROLLUP_COST_SQL}) ELSE NULL END AS costUsd
        FROM ${sql.raw(DAILY_TABLE)} rollup
        LEFT JOIN ${sql.raw(PRICES_TABLE)} price
          ON price.provider_id = rollup.provider_id
          AND price.model = rollup.model
        WHERE ${spendRollupConditions(args)}
        GROUP BY ${groupColumn}
        ORDER BY ${order}`,
  );
}

export function getSpendCoverage(
  db: DbQueryConnection,
  args: ListSpendRollupArgs = {},
): SpendCoverage {
  const row = db.get<{ threads: number; historyComplete: number | null }>(
    sql`SELECT COUNT(*) AS threads, SUM(complete) AS historyComplete
        FROM (
          SELECT cursor.thread_id, MIN(cursor.history_complete) AS complete
          FROM ${sql.raw(CURSOR_TABLE)} cursor
          WHERE EXISTS (
            SELECT 1 FROM ${sql.raw(DAILY_TABLE)} rollup
            WHERE rollup.thread_id = cursor.thread_id
              AND ${spendRollupConditions(args)}
          )
          GROUP BY cursor.thread_id
        )`,
  );
  const threads = row?.threads ?? 0;
  const historyComplete = row?.historyComplete ?? 0;
  return {
    threads,
    historyComplete,
    historyPartial: threads - historyComplete,
  };
}

export function resolveSpendModel(
  db: DbQueryConnection,
  args: { threadId: string; sequence: number },
): string | null {
  const row = db.get<{ model: string | null }>(
    sql`SELECT json_extract(data, '$.execution.model') AS model
        FROM events
        WHERE thread_id = ${args.threadId}
          AND type = 'client/turn/requested'
          AND sequence <= ${args.sequence}
        ORDER BY sequence DESC
        LIMIT 1`,
  );
  const model = row?.model;
  return typeof model === "string" && model.length > 0 ? model : null;
}

export interface StoredTokenUsageEventRow {
  createdAt: number;
  data: string;
  providerThreadId: string | null;
  sequence: number;
  threadId: string;
  turnId: string | null;
}

export function listStoredTokenUsageEvents(
  db: DbQueryConnection,
  args: { threadId: string },
): StoredTokenUsageEventRow[] {
  return db.all<StoredTokenUsageEventRow>(
    sql`SELECT thread_id AS threadId, provider_thread_id AS providerThreadId,
               turn_id AS turnId, sequence, created_at AS createdAt, data
        FROM events
        WHERE thread_id = ${args.threadId}
          AND type = ${TOKEN_USAGE_EVENT_TYPE}
        ORDER BY sequence`,
  );
}

export interface SpendBackfillThreadRow {
  threadId: string;
  providerId: string;
}

export function listSpendBackfillThreads(
  db: DbQueryConnection,
): SpendBackfillThreadRow[] {
  return db.all<SpendBackfillThreadRow>(
    sql`SELECT usage.thread_id AS threadId,
               threads.provider_id AS providerId
        FROM events usage
        JOIN threads ON threads.id = usage.thread_id
        WHERE usage.type = ${TOKEN_USAGE_EVENT_TYPE}
        GROUP BY usage.thread_id, threads.provider_id
        ORDER BY usage.thread_id`,
  );
}
