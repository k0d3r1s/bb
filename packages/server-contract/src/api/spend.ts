import { z } from "zod";

const spendDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "expected a YYYY-MM-DD day");

export const spendGroupBySchema = z.enum([
  "day",
  "thread",
  "provider",
  "model",
]);
export type SpendGroupByQueryValue = z.infer<typeof spendGroupBySchema>;

export const spendRollupQuerySchema = z.object({
  from: spendDaySchema.optional(),
  to: spendDaySchema.optional(),
  groupBy: spendGroupBySchema.optional(),
  threadId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
});
export type SpendRollupQuery = z.infer<typeof spendRollupQuerySchema>;

export const spendRollupRowSchema = z.object({
  day: z.string(),
  threadId: z.string(),
  providerId: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
  totalTokens: z.number(),
  weightedUnits: z.number(),
  turns: z.number(),
  firstEventAt: z.number(),
  lastEventAt: z.number(),
  costUsd: z.number().nullable(),
});
export type SpendRollupRowResponse = z.infer<typeof spendRollupRowSchema>;

export const spendRollupResponseSchema = z.object({
  rows: z.array(spendRollupRowSchema),
  coverage: z.object({
    threads: z.number(),
    historyComplete: z.number(),
    historyPartial: z.number(),
  }),
});
export type SpendRollupResponse = z.infer<typeof spendRollupResponseSchema>;

export const spendBackfillResponseSchema = z.object({
  threadsScanned: z.number(),
  usageEventsScanned: z.number(),
  contributionsApplied: z.number(),
  threadsHistoryComplete: z.number(),
  threadsHistoryPartial: z.number(),
});
export type SpendBackfillResponse = z.infer<typeof spendBackfillResponseSchema>;
