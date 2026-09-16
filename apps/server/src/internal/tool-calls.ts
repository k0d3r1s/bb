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
  },
): Promise<ToolCallResponse | null> {
  if (tool === UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME) {
    return handleUpdateEnvironmentDirectoryToolCall(deps, { ...args, input });
  }
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
        },
      );
      if (environmentToolResponse) {
        return context.json(environmentToolResponse);
      }

      const pluginTool = findPluginAgentTool(payload.tool);
      if (pluginTool) {
        const controller = new AbortController();
        const signal = AbortSignal.any([
          context.req.raw.signal,
          controller.signal,
        ]);
        return streamToolCallResponse(
          invokePluginAgentTool(pluginTool, {
            input: payload.arguments,
            ctx: {
              threadId: thread.id,
              projectId: thread.projectId,
              signal,
            },
          }),
          controller,
        );
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
