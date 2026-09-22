import {
  ENTER_BRANCH_TOOL_NAME,
  handleEnterBranchToolCall,
} from "../services/threads/thread-environment-branch.fork.js";
import {
  hostDaemonToolCallRequestSchema,
  typedRoutes,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import type { Thread, ToolCallResponse } from "@bb/domain";
import type { EnvironmentRow } from "@bb/db";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { requireThreadEnvironment } from "../services/lib/entity-lookup.js";
import {
  findPluginAgentTool,
  invokePluginAgentTool,
} from "../services/plugins/plugin-agent-contributions.js";
import { deliverDetachedToolResult } from "../services/plugins/detached-tool-result-delivery.js";
import { requirePluginToolCallRegistry } from "../services/plugins/plugin-tool-calls.js";
import {
  handleUpdateEnvironmentDirectoryToolCall,
  UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME,
} from "../services/threads/thread-environment-directory.js";
import {
  ENTER_WORKTREE_TOOL_NAME,
  handleEnterWorktreeToolCall,
  handleKeepCheckoutToolCall,
  KEEP_CHECKOUT_TOOL_NAME,
} from "../services/threads/thread-environment-directory.fork.js";
import { requireAuthenticatedDaemonSession } from "./session-state.js";

const textEncoder = new TextEncoder();

function streamToolCallResponse(
  result: Promise<ToolCallResponse>,
  abortController: AbortController,
): Response {
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      abortController.abort();
    },
    start(controller) {
      void result.then(
        (response) => {
          try {
            controller.enqueue(textEncoder.encode(JSON.stringify(response)));
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
        (error) => controller.error(error),
      );
    },
  });
  return new Response(body, {
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

async function invokeEnvironmentTool(
  deps: AppDeps,
  tool: string,
  input: unknown,
  args: {
    currentEnvironment: EnvironmentRow;
    thread: Thread;
    turnId: string;
    signal: AbortSignal;
  },
): Promise<ToolCallResponse | null> {
  if (tool === UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME) {
    return handleUpdateEnvironmentDirectoryToolCall(deps, { ...args, input });
  }
  if (tool === ENTER_BRANCH_TOOL_NAME)
    return handleEnterBranchToolCall(deps, { ...args, input });
  if (tool === ENTER_WORKTREE_TOOL_NAME) {
    return handleEnterWorktreeToolCall(deps, { ...args, input });
  }
  if (tool === KEEP_CHECKOUT_TOOL_NAME) {
    return handleKeepCheckoutToolCall(deps, { ...args, input });
  }
  return null;
}

export function registerInternalToolCallRoutes(app: Hono, deps: AppDeps): void {
  const { post } = typedRoutes<HostDaemonInternalSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  post(
    "/session/tool-call",
    hostDaemonToolCallRequestSchema,
    async (context, payload) => {
      const session = requireAuthenticatedDaemonSession({
        context,
        db: deps.db,
        sessionId: payload.sessionId,
      });
      const { environment, thread } = requireThreadEnvironment(
        deps.db,
        payload.threadId,
      );
      if (environment.hostId !== session.hostId) {
        throw new ApiError(
          403,
          "invalid_request",
          "Thread does not belong to the session host",
        );
      }

      const environmentToolResponse = await invokeEnvironmentTool(
        deps,
        payload.tool,
        payload.arguments,
        {
          currentEnvironment: environment,
          thread,
          turnId: payload.turnId,
          signal: context.req.raw.signal,
        },
      );
      if (environmentToolResponse) {
        return context.json(environmentToolResponse);
      }

      const pluginTool = findPluginAgentTool(payload.tool);
      if (pluginTool) {
        const roundTrip = new AbortController();
        const response = requirePluginToolCallRegistry().run({
          pluginId: pluginTool.pluginId,
          threadId: thread.id,
          callId: payload.callId,
          toolName: payload.tool,
          roundTrip: AbortSignal.any([
            context.req.raw.signal,
            roundTrip.signal,
          ]),
          invoke: (signal) =>
            invokePluginAgentTool(pluginTool, {
              input: payload.arguments,
              ctx: {
                threadId: thread.id,
                projectId: thread.projectId,
                signal,
              },
            }),
          onDetachedResult: (result) =>
            deliverDetachedToolResult(deps, {
              threadId: thread.id,
              toolName: payload.tool,
              presentation: pluginTool.record.presentation,
              response: result,
            }),
        });
        return streamToolCallResponse(response, roundTrip);
      }

      return context.json({
        success: false,
        contentItems: [
          { type: "inputText", text: `Unsupported tool: ${payload.tool}` },
        ],
      });
    },
  );
}
