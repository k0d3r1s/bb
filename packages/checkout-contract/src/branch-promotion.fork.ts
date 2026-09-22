import { z } from "zod";
import { gitBranchNameSchema } from "./git-branch-name.js";

export const branchPromotionIntentSchema = z
  .object({
    operationId: z.string().min(1),
    path: z.string().min(1),
    sourceBranch: gitBranchNameSchema,
    sourceHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
    target: z
      .object({ kind: z.enum(["new", "existing"]), name: gitBranchNameSchema })
      .strict(),
  })
  .strict();
export type BranchPromotionIntent = z.infer<typeof branchPromotionIntentSchema>;

export const branchPromotionRequestSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("enter"), intent: branchPromotionIntentSchema })
    .strict(),
  z
    .object({
      action: z.literal("inspect"),
      intent: branchPromotionIntentSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("resolve"),
      intent: branchPromotionIntentSchema,
      observation: z.string().min(1),
      resolution: z.enum(["accept-current", "keep-current"]),
    })
    .strict(),
]);
export type BranchPromotionRequest = z.infer<
  typeof branchPromotionRequestSchema
>;

export const branchPromotionSnapshotSchema = z
  .object({
    operationId: z.string().min(1),
    phase: z.enum(["running", "uncertain", "completed", "failed", "resolved"]),
    branchName: z.string().min(1).nullable(),
    headSha: z.string().min(1).nullable(),
    observation: z.string().min(1),
    commandTerminated: z.boolean(),
    resolution: z.enum(["accept-current", "keep-current"]).nullable(),
    message: z.string().nullable(),
    replayed: z.boolean(),
  })
  .strict();
export type BranchPromotionSnapshot = z.infer<
  typeof branchPromotionSnapshotSchema
>;
