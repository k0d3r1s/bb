import { z } from "zod";
import {
  deleteQueuedThreadMessage,
  deleteQueuedThreadMessageInTransaction,
  listQueuedThreadMessages,
  type DbConnection,
  type DbNotifier,
  type DbTransaction,
} from "@bb/db";

export const ENTER_WORKTREE_CONTINUATION_TEXT =
  "Continue implementing the user's request from the newly prepared worktree.";

const enterWorktreeContinuationInputSchema = z
  .array(
    z
      .object({
        type: z.literal("text"),
        text: z.literal(ENTER_WORKTREE_CONTINUATION_TEXT),
        mentions: z.array(z.unknown()).length(0),
        visibility: z.literal("agent-only"),
      })
      .passthrough(),
  )
  .length(1);

export function isEnterWorktreeContinuationInput(input: unknown): boolean {
  return enterWorktreeContinuationInputSchema.safeParse(input).success;
}

export function isEnterWorktreeContinuationContent(content: string): boolean {
  try {
    return isEnterWorktreeContinuationInput(JSON.parse(content));
  } catch {
    return false;
  }
}

export function isSupersedingUserQueueEnvelope(args: {
  payloadKind: string;
  sendAt: number | null;
  senderThreadId: string | null;
  systemNotice: unknown | null;
}): boolean {
  if (args.senderThreadId !== null || args.systemNotice !== null) return false;
  if (args.payloadKind !== "inline") return false;
  return args.sendAt === null || args.sendAt <= Date.now();
}

type EnterWorktreeContinuationDeleteTarget =
  | { kind: "transaction"; db: DbTransaction }
  | { kind: "notifying"; db: DbConnection; hub: DbNotifier };

export function deleteEnterWorktreeContinuations(
  target: EnterWorktreeContinuationDeleteTarget,
  threadId: string,
): void {
  for (const queuedMessage of listQueuedThreadMessages(target.db, threadId)) {
    if (isEnterWorktreeContinuationContent(queuedMessage.content)) {
      if (target.kind === "transaction") {
        deleteQueuedThreadMessageInTransaction(target.db, queuedMessage.id);
      } else {
        deleteQueuedThreadMessage(target.db, target.hub, queuedMessage.id);
      }
    }
  }
}
