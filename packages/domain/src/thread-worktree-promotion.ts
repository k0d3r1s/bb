import { z } from "zod";

export const threadWorktreePromotionValues = ["armed", "declined"] as const;
export const threadWorktreePromotionSchema = z.enum(
  threadWorktreePromotionValues,
);
export type ThreadWorktreePromotion = z.infer<
  typeof threadWorktreePromotionSchema
>;
