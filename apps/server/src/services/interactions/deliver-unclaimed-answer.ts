import type { JsonValue, PendingInteraction } from "@bb/domain";
import { buildUnclaimedAnswerMessage } from "./unclaimed-answer-message.js";

export interface UnclaimedAnswerDelivery {
  threadId: string;
  text: string;
}

export function planUnclaimedAnswerDelivery(args: {
  interaction: Pick<PendingInteraction, "threadId" | "payload">;
  value: JsonValue;
}): UnclaimedAnswerDelivery | null {
  if (args.interaction.payload.kind !== "plugin") return null;
  const text = buildUnclaimedAnswerMessage(
    args.interaction.payload.data,
    args.value,
  );
  if (text === null) return null;
  return { threadId: args.interaction.threadId, text };
}
