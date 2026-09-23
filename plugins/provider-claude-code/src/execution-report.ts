import {
  reasoningLevelSchema,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { ClaudeInitSystemMessage } from "./schemas.js";

type ThreadExecutionDelta = Extract<ThreadDelta, { kind: "thread.execution" }>;
type ThreadExecution = ThreadExecutionDelta["execution"];

function toBbPermissionMode(
  mode: string | undefined,
): ThreadExecution["permissionMode"] {
  switch (mode) {
    case "acceptEdits":
      return "accept-edits";
    case "auto":
      return "auto";
    case "bypassPermissions":
      return "full";
    default:
      return null;
  }
}

function toBbServiceTier(
  fastModeState: string | undefined,
): ThreadExecution["serviceTier"] {
  switch (fastModeState) {
    case "on":
      return "fast";
    case "off":
      return "default";
    default:
      return null;
  }
}

export function toClaudeExecutionDelta(
  message: ClaudeInitSystemMessage,
): ThreadExecutionDelta {
  return {
    kind: "thread.execution",
    execution: {
      model: message.model,
      reasoningLevel:
        reasoningLevelSchema.safeParse(message.effort).data ?? null,
      permissionMode: toBbPermissionMode(message.permissionMode),
      serviceTier: toBbServiceTier(message.fast_mode_state),
    },
  };
}
