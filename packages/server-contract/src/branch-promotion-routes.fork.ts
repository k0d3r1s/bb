import {
  defineRoute,
  jsonRequest,
  jsonResponse,
  noRequest,
} from "@bb/hono-typed-routes";
import type { PathId } from "./common.js";
import {
  resolveThreadBranchPromotionRequestSchema,
  type ResolveThreadBranchPromotionRequest,
  type ThreadBranchPromotionResponse,
} from "./api/branch-promotion.fork.js";

export const branchPromotionRoutes = {
  inspectBranchPromotion: defineRoute({
    path: "/threads/:id/branch-promotion",
    method: "get",
    request: noRequest<PathId>(),
    response: jsonResponse<ThreadBranchPromotionResponse>(),
  }),
  resolveBranchPromotion: defineRoute({
    path: "/threads/:id/branch-promotion/resolve",
    method: "post",
    request: jsonRequest<PathId, ResolveThreadBranchPromotionRequest>(
      resolveThreadBranchPromotionRequestSchema,
    ),
    response: jsonResponse<ThreadBranchPromotionResponse>(),
  }),
};
