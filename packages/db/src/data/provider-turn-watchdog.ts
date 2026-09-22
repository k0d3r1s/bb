import { aliasedTable, and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import {
  providerTurnWatchdogActivityEventTypeSchema,
  providerTurnWatchdogActivityEventTypeValues,
  providerTurnWatchdogThreadScopedActivityEventTypeValues,
} from "@bb/domain";
import type { ProviderTurnWatchdogActivityEventType } from "@bb/domain";
import type { DbQueryConnection } from "../connection.js";
import { environments, events, pendingInteractions, threads } from "../schema.js";

export interface ListProviderTurnIdleWatchdogCandidatesArgs {
  idleThresholdMs: number;
  limit: number;
  now: number;
}

export interface ProviderTurnIdleWatchdogCandidateRow {
  activeTurnId: string;
  activeTurnStartedAt: number;
  elapsedMs: number;
  environmentId: string;
  hasPriorWatchdogEvent: boolean;
  hostId: string;
  lastActivityEventAt: number;
  lastActivityEventSequence: number;
  lastActivityEventType: ProviderTurnWatchdogActivityEventType;
  providerId: string;
  providerThreadId: string | null;
  threadId: string;
}

const activityEventTypeSqlList = sql.join(
  providerTurnWatchdogActivityEventTypeValues.map((eventType) =>
    sql`${eventType}`,
  ),
  sql`, `,
);

const threadScopedActivityEventTypeSqlList = sql.join(
  providerTurnWatchdogThreadScopedActivityEventTypeValues.map((eventType) =>
    sql`${eventType}`,
  ),
  sql`, `,
);

type LatestTurnStartedColumn = "created_at" | "sequence" | "turn_id";

function latestTurnStartedSql(column: LatestTurnStartedColumn): SQL {
  return sql`(
    SELECT latest_started.${sql.raw(column)}
    FROM events AS latest_started
    WHERE latest_started.thread_id = ${threads.id}
      AND latest_started.type = 'turn/started'
      AND latest_started.turn_id IS NOT NULL
    ORDER BY latest_started.sequence DESC
    LIMIT 1
  )`;
}

interface ActivityAnchorShapeSqlArgs {
  activeTurnIdSql: SQL;
  turnIdColumn: AnyColumn;
  typeColumn: AnyColumn;
}

function activityAnchorShapeSql(args: ActivityAnchorShapeSqlArgs): SQL {
  return sql`(
    (${args.turnIdColumn} = ${args.activeTurnIdSql} AND ${args.typeColumn} IN (${activityEventTypeSqlList}))
    OR
    (${args.turnIdColumn} IS NULL AND ${args.typeColumn} IN (${threadScopedActivityEventTypeSqlList}))
  )`;
}

function parseNonEmptyString(value: string | null, fieldName: string): string {
  if (value === null || value.length === 0) {
    throw new Error(`Provider turn watchdog candidate missing ${fieldName}`);
  }
  return value;
}

function parseNonNegativeInteger(
  value: number | null,
  fieldName: string,
): number {
  if (value === null || !Number.isInteger(value) || value < 0) {
    throw new Error(`Provider turn watchdog candidate invalid ${fieldName}`);
  }
  return value;
}

function parsePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Provider turn watchdog candidate invalid ${fieldName}`);
  }
  return value;
}

function parseProviderTurnIdleWatchdogCandidateRow(
  row: Omit<
    ProviderTurnIdleWatchdogCandidateRow,
    | "activeTurnId"
    | "activeTurnStartedAt"
    | "hasPriorWatchdogEvent"
    | "lastActivityEventType"
  > & {
    activeTurnId: string | null;
    activeTurnStartedAt: number | null;
    hasPriorWatchdogEvent: number;
    lastActivityEventType: string;
  },
): ProviderTurnIdleWatchdogCandidateRow {
  return {
    activeTurnId: parseNonEmptyString(row.activeTurnId, "activeTurnId"),
    activeTurnStartedAt: parseNonNegativeInteger(
      row.activeTurnStartedAt,
      "activeTurnStartedAt",
    ),
    elapsedMs: parseNonNegativeInteger(row.elapsedMs, "elapsedMs"),
    environmentId: row.environmentId,
    hasPriorWatchdogEvent: row.hasPriorWatchdogEvent !== 0,
    hostId: row.hostId,
    lastActivityEventAt: parseNonNegativeInteger(
      row.lastActivityEventAt,
      "lastActivityEventAt",
    ),
    lastActivityEventSequence: parsePositiveInteger(
      row.lastActivityEventSequence,
      "lastActivityEventSequence",
    ),
    lastActivityEventType: providerTurnWatchdogActivityEventTypeSchema.parse(
      row.lastActivityEventType,
    ),
    providerId: row.providerId,
    providerThreadId: row.providerThreadId,
    threadId: row.threadId,
  };
}

export function listProviderTurnIdleWatchdogCandidates(
  db: DbQueryConnection,
  args: ListProviderTurnIdleWatchdogCandidatesArgs,
): ProviderTurnIdleWatchdogCandidateRow[] {
  const activeTurnIdSql = latestTurnStartedSql("turn_id");
  const activityEvents = aliasedTable(events, "activity");
  const rows = db
    .select({
      activeTurnId: sql<string | null>`${activeTurnIdSql}`,
      activeTurnStartedAt: sql<number | null>`${latestTurnStartedSql(
        "created_at",
      )}`,
      elapsedMs: sql<number>`${args.now} - ${events.createdAt}`,
      environmentId: environments.id,
      hasPriorWatchdogEvent: sql<number>`(
        SELECT CASE WHEN EXISTS (
          SELECT 1
          FROM events AS prior_watchdog
          WHERE prior_watchdog.thread_id = ${threads.id}
            AND prior_watchdog.type = 'system/provider-turn-watchdog'
            AND prior_watchdog.sequence > ${latestTurnStartedSql("sequence")}
        ) THEN 1 ELSE 0 END
      )`,
      hostId: environments.hostId,
      lastActivityEventAt: events.createdAt,
      lastActivityEventSequence: events.sequence,
      lastActivityEventType: events.type,
      providerId: threads.providerId,
      providerThreadId: sql<string | null>`COALESCE(
        NULLIF(${events.providerThreadId}, ''),
        (
          SELECT latest_provider.provider_thread_id
          FROM events AS latest_provider
          WHERE latest_provider.thread_id = ${events.threadId}
            AND latest_provider.provider_thread_id IS NOT NULL
            AND latest_provider.provider_thread_id != ''
          ORDER BY latest_provider.sequence DESC
          LIMIT 1
        )
      )`,
      threadId: threads.id,
    })
    .from(events)
    .innerJoin(threads, eq(threads.id, events.threadId))
    .innerJoin(environments, eq(environments.id, threads.environmentId))
    .where(
      and(
        eq(threads.status, "active"),
        isNull(threads.deletedAt),
        isNotNull(threads.environmentId),
        sql`${activeTurnIdSql} IS NOT NULL`,
        activityAnchorShapeSql({
          activeTurnIdSql,
          turnIdColumn: events.turnId,
          typeColumn: events.type,
        }),
        sql`${events.sequence} = (
          SELECT MAX(${activityEvents.sequence})
          FROM events AS activity
          WHERE ${activityEvents.threadId} = ${events.threadId}
            AND ${activityAnchorShapeSql({
              activeTurnIdSql,
              turnIdColumn: activityEvents.turnId,
              typeColumn: activityEvents.type,
            })}
        )`,
        sql`NOT EXISTS (
          SELECT 1
          FROM events AS completed
          WHERE completed.thread_id = ${threads.id}
            AND completed.turn_id = ${activeTurnIdSql}
            AND completed.type = 'turn/completed'
        )`,
        sql`${args.now} - ${events.createdAt} >= ${args.idleThresholdMs}`,
        sql`NOT EXISTS (
          SELECT 1
          FROM ${pendingInteractions} AS active_interaction
          WHERE active_interaction.thread_id = ${threads.id}
            AND active_interaction.turn_id = ${activeTurnIdSql}
            AND active_interaction.status IN ('pending', 'resolving')
        )`,
      ),
    )
    .orderBy(asc(events.createdAt))
    .limit(args.limit)
    .all();

  return rows.map(parseProviderTurnIdleWatchdogCandidateRow);
}
