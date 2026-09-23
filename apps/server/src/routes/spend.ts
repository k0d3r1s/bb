import {
  getSpendCoverage,
  listSpendRollupGroups,
  listSpendRollupRows,
} from "@bb/db";
import type { Hono } from "hono";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
  type SpendBackfillResponse,
  type SpendRollupResponse,
} from "@bb/server-contract";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { backfillSpend } from "../services/system/spend-rollup.js";

export function registerSpendRoutes(app: Hono, deps: AppDeps): void {
  const routes = publicApiRoutes.spend;
  const { get, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });

  get(routes.rollup, (context, query) => {
    const filters = {
      from: query.from,
      to: query.to,
      threadId: query.threadId,
      providerId: query.providerId,
    };
    const response: SpendRollupResponse = {
      rows:
        query.groupBy === undefined
          ? listSpendRollupRows(deps.db, filters)
          : listSpendRollupGroups(deps.db, {
              ...filters,
              groupBy: query.groupBy,
            }),
      coverage: getSpendCoverage(deps.db, filters),
    };
    return context.json(response);
  });

  post(routes.backfill, (context) => {
    const response: SpendBackfillResponse = backfillSpend(deps.db);
    return context.json(response);
  });
}
