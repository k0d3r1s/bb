import { z } from "zod";

export const threadWorktreePromotionValues = [
  "armed",
  "declined",
  "promoted",
] as const;
export const threadWorktreePromotionSchema = z.enum(
  threadWorktreePromotionValues,
);
export type ThreadWorktreePromotion = z.infer<
  typeof threadWorktreePromotionSchema
>;

export const threadPromotionTargetValues = ["worktree", "branch"] as const;
export const threadPromotionTargetSchema = z.enum(threadPromotionTargetValues);
export type ThreadPromotionTarget = z.infer<typeof threadPromotionTargetSchema>;
