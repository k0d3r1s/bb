import { z } from "zod";
import type { ThreadEventType } from "./provider-event.js";
import { threadEventScopePolicyByType } from "./thread-event-scope.js";
import type { ThreadOnlyThreadEventType } from "./thread-event-scope.js";

export const providerTurnWatchdogActivityEventTypeValues = [
  "turn/started",
  "turn/input/accepted",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/plan/delta",
  "item/mcpToolCall/progress",
  "item/toolCall/progress",
  "item/backgroundTask/progress",
  "item/backgroundTask/completed",
  "turn/plan/updated",
  "turn/diff/updated",
  "provider/error",
  "provider/warning",
] as const satisfies readonly ThreadEventType[];
export const providerTurnWatchdogActivityEventTypeSchema = z.enum(
  providerTurnWatchdogActivityEventTypeValues,
);
export type ProviderTurnWatchdogActivityEventType = z.infer<
  typeof providerTurnWatchdogActivityEventTypeSchema
>;

export type ProviderTurnWatchdogThreadScopedActivityEventType = Extract<
  ProviderTurnWatchdogActivityEventType,
  ThreadOnlyThreadEventType
>;

export const providerTurnWatchdogThreadScopedActivityEventTypeValues: readonly ProviderTurnWatchdogThreadScopedActivityEventType[] =
  providerTurnWatchdogActivityEventTypeValues.filter(
    (
      eventType,
    ): eventType is ProviderTurnWatchdogThreadScopedActivityEventType =>
      threadEventScopePolicyByType[eventType] === "thread",
  );
