import { getSpendCoverage, listSpendRollupRows } from "@bb/db";
import type { SpendRollupRow } from "@bb/db";
import type { Hono } from "hono";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
  type SpendBackfillResponse,
  type SpendGroupByQueryValue,
  type SpendRollupResponse,
  type SpendRollupRowResponse,
} from "@bb/server-contract";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { backfillSpend } from "../services/system/spend-rollup.js";

const ALL_THREADS = "*";
const ALL_DAYS = "*";
const ALL_MODELS = "*";
const ALL_PROVIDERS = "*";

function groupRows(
  rows: readonly SpendRollupRow[],
  groupBy: SpendGroupByQueryValue,
): SpendRollupRowResponse[] {
  const grouped = new Map<string, SpendRollupRowResponse>();
  for (const row of rows) {
    const key =
      groupBy === "day"
        ? row.day
        : groupBy === "thread"
          ? row.threadId
          : groupBy === "provider"
            ? row.providerId
            : row.model;
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, {
        day: groupBy === "day" ? row.day : ALL_DAYS,
        threadId: groupBy === "thread" ? row.threadId : ALL_THREADS,
        providerId: groupBy === "provider" ? row.providerId : ALL_PROVIDERS,
        model: groupBy === "model" ? row.model : ALL_MODELS,
        inputTokens: row.inputTokens,
        cachedInputTokens: row.cachedInputTokens,
        outputTokens: row.outputTokens,
        reasoningOutputTokens: row.reasoningOutputTokens,
        totalTokens: row.totalTokens,
        weightedUnits: row.weightedUnits,
        turns: row.turns,
        firstEventAt: row.firstEventAt,
        lastEventAt: row.lastEventAt,
        costUsd: row.costUsd,
      });
      continue;
    }
    existing.inputTokens += row.inputTokens;
    existing.cachedInputTokens += row.cachedInputTokens;
    existing.outputTokens += row.outputTokens;
    existing.reasoningOutputTokens += row.reasoningOutputTokens;
    existing.totalTokens += row.totalTokens;
    existing.weightedUnits += row.weightedUnits;
    existing.turns += row.turns;
    existing.firstEventAt = Math.min(existing.firstEventAt, row.firstEventAt);
    existing.lastEventAt = Math.max(existing.lastEventAt, row.lastEventAt);
    existing.costUsd =
      existing.costUsd === null || row.costUsd === null
        ? null
        : existing.costUsd + row.costUsd;
  }
  return [...grouped.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

export function registerSpendRoutes(app: Hono, deps: AppDeps): void {
  const routes = publicApiRoutes.spend;
  const { get, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });

  get(routes.rollup, (context, query) => {
    const rows = listSpendRollupRows(deps.db, {
      from: query.from,
      to: query.to,
      threadId: query.threadId,
      providerId: query.providerId,
    });
    const response: SpendRollupResponse = {
      rows: query.groupBy === undefined ? rows : groupRows(rows, query.groupBy),
      coverage: getSpendCoverage(deps.db, {
        from: query.from,
        to: query.to,
      }),
    };
    return context.json(response);
  });

  post(routes.backfill, (context) => {
    const response: SpendBackfillResponse = backfillSpend(deps.db);
    return context.json(response);
  });
}
