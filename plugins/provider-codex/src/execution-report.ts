import type { ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import { mapCodexReasoningLevelToBb } from "./models.js";

type ThreadExecutionDelta = Extract<ThreadDelta, { kind: "thread.execution" }>;
export type ThreadExecution = ThreadExecutionDelta["execution"];

const codexSessionSettingsResultSchema = z
  .object({
    model: z.string().min(1),
    reasoningEffort: z.string().nullable().optional(),
    approvalPolicy: z.unknown().optional(),
    approvalsReviewer: z.string().optional(),
    sandbox: z.object({ type: z.string() }).passthrough().optional(),
    serviceTier: z.string().nullable().optional(),
  })
  .passthrough();
type CodexSessionSettingsResult = z.infer<
  typeof codexSessionSettingsResultSchema
>;

function toBbPermissionMode(
  settings: CodexSessionSettingsResult,
): ThreadExecution["permissionMode"] {
  switch (settings.sandbox?.type) {
    case "dangerFullAccess":
      return settings.approvalPolicy === "never" ? "full" : null;
    case "workspaceWrite":
      switch (settings.approvalsReviewer) {
        case "auto_review":
          return "auto";
        case "user":
          return "accept-edits";
        default:
          return null;
      }
    default:
      return null;
  }
}

function toBbServiceTier(
  tier: string | null | undefined,
): ThreadExecution["serviceTier"] {
  if (tier === undefined) {
    return null;
  }
  if (tier === null) {
    return "default";
  }
  return tier === "fast" ? "fast" : null;
}

export function toCodexExecutionDelta(
  threadSessionResult: unknown,
): ThreadExecutionDelta | null {
  const parsed =
    codexSessionSettingsResultSchema.safeParse(threadSessionResult);
  if (!parsed.success) {
    return null;
  }
  const settings = parsed.data;
  return {
    kind: "thread.execution",
    execution: {
      model: settings.model,
      reasoningLevel: mapCodexReasoningLevelToBb(settings.reasoningEffort),
      permissionMode: toBbPermissionMode(settings),
      serviceTier: toBbServiceTier(settings.serviceTier),
    },
  };
}

export interface CodexTurnExecutionSettings {
  model: string | undefined;
  serviceTier: "fast" | null | undefined;
  approvalPolicy: unknown;
  approvalsReviewer: string;
  sandboxType: string;
}

export function toCodexTurnExecution(
  previous: ThreadExecution,
  turn: CodexTurnExecutionSettings,
): ThreadExecution {
  return {
    model: turn.model ?? previous.model,
    reasoningLevel: previous.reasoningLevel,
    permissionMode: toBbPermissionMode({
      model: turn.model ?? previous.model,
      approvalPolicy: turn.approvalPolicy,
      approvalsReviewer: turn.approvalsReviewer,
      sandbox: { type: turn.sandboxType },
    }),
    serviceTier:
      turn.serviceTier === undefined
        ? previous.serviceTier
        : toBbServiceTier(turn.serviceTier),
  };
}

export function sameThreadExecution(
  left: ThreadExecution,
  right: ThreadExecution,
): boolean {
  return (
    left.model === right.model &&
    left.reasoningLevel === right.reasoningLevel &&
    left.permissionMode === right.permissionMode &&
    left.serviceTier === right.serviceTier
  );
}
