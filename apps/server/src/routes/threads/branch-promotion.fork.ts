import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { requirePublicThread } from "../../services/lib/entity-lookup.js";
import {
  inspectThreadBranchPromotion,
  resolveThreadBranchPromotion,
} from "../../services/threads/thread-environment-branch.fork.js";

export function registerBranchPromotionRoutes(app: Hono, deps: AppDeps): void {
  const { get, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });
  get(publicApiRoutes.threads.inspectBranchPromotion, async (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    return context.json(
      await inspectThreadBranchPromotion(
        deps,
        thread.id,
        context.req.raw.signal,
      ),
    );
  });
  post(
    publicApiRoutes.threads.resolveBranchPromotion,
    async (context, payload) => {
      const thread = requirePublicThread(deps.db, context.req.param("id"));
      return context.json(
        await resolveThreadBranchPromotion(
          deps,
          { threadId: thread.id, ...payload },
          context.req.raw.signal,
        ),
      );
    },
  );
}
