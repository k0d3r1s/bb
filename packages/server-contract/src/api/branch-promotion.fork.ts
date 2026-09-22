import { z } from "zod";
import {
  branchPromotionIntentSchema,
  branchPromotionSnapshotSchema,
} from "@bb/domain";

export const threadBranchPromotionResponseSchema = z
  .object({
    operationId: z.string(),
    phase: z.enum([
      "prepared",
      "running",
      "reconciling",
      "completed",
      "failed",
    ]),
    intent: branchPromotionIntentSchema,
    snapshot: branchPromotionSnapshotSchema.nullable(),
  })
  .nullable();
export type ThreadBranchPromotionResponse = z.infer<
  typeof threadBranchPromotionResponseSchema
>;

export const resolveThreadBranchPromotionRequestSchema = z
  .object({
    operationId: z.string().min(1),
    observation: z.string().min(1),
    resolution: z.enum(["accept-current", "keep-current"]),
  })
  .strict();
export type ResolveThreadBranchPromotionRequest = z.infer<
  typeof resolveThreadBranchPromotionRequestSchema
>;
