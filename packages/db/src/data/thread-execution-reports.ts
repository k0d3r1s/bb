import {
  threadExecutionReportSchema,
  type ThreadExecutionReport,
} from "@bb/domain";
import { sql } from "drizzle-orm";
import type { DbQueryConnection } from "../connection.js";

const EXECUTION_REPORTS_TABLE = "fork_thread_execution_reports";

interface ExecutionReportRow {
  model: string;
  reasoningLevel: string | null;
  permissionMode: string | null;
  serviceTier: string | null;
}

export function upsertThreadExecutionReport(
  db: DbQueryConnection,
  args: {
    threadId: string;
    execution: ThreadExecutionReport;
    reportedAt: number;
  },
): void {
  db.run(
    sql`INSERT INTO ${sql.raw(EXECUTION_REPORTS_TABLE)} (thread_id, model,
          reasoning_level, permission_mode, service_tier, reported_at)
        VALUES (${args.threadId}, ${args.execution.model},
          ${args.execution.reasoningLevel}, ${args.execution.permissionMode},
          ${args.execution.serviceTier}, ${args.reportedAt})
        ON CONFLICT (thread_id) DO UPDATE SET
          model = excluded.model,
          reasoning_level = excluded.reasoning_level,
          permission_mode = excluded.permission_mode,
          service_tier = excluded.service_tier,
          reported_at = excluded.reported_at`,
  );
}

export function getThreadExecutionReport(
  db: DbQueryConnection,
  threadId: string,
): ThreadExecutionReport | null {
  const row = db.get<ExecutionReportRow>(
    sql`SELECT model, reasoning_level AS reasoningLevel,
          permission_mode AS permissionMode, service_tier AS serviceTier
        FROM ${sql.raw(EXECUTION_REPORTS_TABLE)}
        WHERE thread_id = ${threadId}`,
  );
  if (row === undefined) {
    return null;
  }
  const parsed = threadExecutionReportSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}
