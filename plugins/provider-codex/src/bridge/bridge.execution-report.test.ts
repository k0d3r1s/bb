import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  experimental_assembleCapturedThreadEvents as assembleCapturedThreadEvents,
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";

import { handleLine } from "./bridge.js";

const THREAD_ID = "thr_1787_execution_report";
const RESUMED_PROVIDER_THREAD_ID = "codex-1787-resumed";

const fakeAppServerPath = fileURLToPath(
  new URL("./fake-codex-app-server.mjs", import.meta.url),
);

let harness: ReturnType<typeof createBridgeJsonRpcTestHarness>;
let workspaceDir: string;
let providerThreadId: string | null;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-codex-1787-ws-"));
  providerThreadId = null;
  vi.stubEnv("BB_CODEX_BRIDGE_APP_SERVER_COMMAND", process.execPath);
  vi.stubEnv(
    "BB_CODEX_BRIDGE_APP_SERVER_ARGS",
    JSON.stringify([fakeAppServerPath]),
  );
  harness = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(async () => {
  const cleanupId = 994_001;
  harness.sendRequest(cleanupId, "thread/stop", {
    threadId: THREAD_ID,
    providerThreadId,
    intent: "release",
    activeTurnId: null,
  });
  await harness.waitForResponse(cleanupId).catch(() => undefined);
  harness.restore();
  vi.unstubAllEnvs();
  rmSync(workspaceDir, { recursive: true, force: true });
});

function executionReports() {
  return assembleCapturedThreadEvents(harness.messages, "codex").filter(
    (event) => event.type === "thread/execution/reported",
  );
}

it("reports the settings the app-server resolved for a new session", async () => {
  harness.sendRequest(1, "thread/start", {
    threadId: THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: {
      model: "gpt-5.5",
      permissionMode: "auto",
      permissionScope: "workspace",
      approvalReviewer: "automatic",
      permissionEscalation: "ask",
    },
  });
  const started = await harness.waitForResponse(1);
  expect(started.error).toBeUndefined();
  providerThreadId = (started.result as { providerThreadId: string })
    .providerThreadId;

  expect(executionReports()).toEqual([
    expect.objectContaining({
      scope: expect.objectContaining({ kind: "thread" }),
      execution: {
        model: "gpt-5.5",
        reasoningLevel: "medium",
        permissionMode: "auto",
        serviceTier: "default",
      },
    }),
  ]);
});

it("reports again when a session is resumed", async () => {
  providerThreadId = RESUMED_PROVIDER_THREAD_ID;
  harness.sendRequest(1, "thread/resume", {
    threadId: THREAD_ID,
    providerThreadId: RESUMED_PROVIDER_THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: {
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    },
  });
  const resumed = await harness.waitForResponse(1);
  expect(resumed.error).toBeUndefined();

  expect(executionReports()).toEqual([
    expect.objectContaining({
      execution: {
        model: "fake-codex-model",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
      },
    }),
  ]);
});

const AUTO_SESSION_OPTIONS = {
  model: "gpt-5.5",
  permissionMode: "auto",
  permissionScope: "workspace",
  approvalReviewer: "automatic",
  permissionEscalation: "ask",
} as const;

async function completedTurnCount(expected: number): Promise<void> {
  await vi.waitFor(
    () => {
      const completed = assembleCapturedThreadEvents(
        harness.messages,
        "codex",
      ).filter((event) => event.type === "turn/completed");
      expect(completed).toHaveLength(expected);
    },
    { timeout: 10_000 },
  );
}

async function runTurn(
  id: number,
  clientRequestId: string,
  overrides: { model?: string; serviceTier?: "fast" },
): Promise<void> {
  harness.sendRequest(id, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId,
    input: [{ type: "text", text: "/clear", mentions: [] }],
    clientRequestId,
    options: { ...AUTO_SESSION_OPTIONS, ...overrides },
  });
  const response = await harness.waitForResponse(id);
  expect(response.error).toBeUndefined();
}

it("reports a fresh profile when a turn changes the model or service tier, and stays quiet when it does not", async () => {
  harness.sendRequest(1, "thread/start", {
    threadId: THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: AUTO_SESSION_OPTIONS,
  });
  const started = await harness.waitForResponse(1);
  expect(started.error).toBeUndefined();
  providerThreadId = (started.result as { providerThreadId: string })
    .providerThreadId;

  await runTurn(2, "creq_execrptaaa", {});
  await completedTurnCount(1);
  expect(executionReports()).toHaveLength(1);

  await runTurn(3, "creq_execrptbbb", {
    model: "gpt-5.5-mini",
    serviceTier: "fast",
  });
  await completedTurnCount(2);

  expect(executionReports().map((report) => report.execution)).toEqual([
    {
      model: "gpt-5.5",
      reasoningLevel: "medium",
      permissionMode: "auto",
      serviceTier: "default",
    },
    {
      model: "gpt-5.5-mini",
      reasoningLevel: "medium",
      permissionMode: "auto",
      serviceTier: "fast",
    },
  ]);
}, 30_000);
