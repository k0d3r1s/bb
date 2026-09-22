import { eq } from "drizzle-orm";
import { environments, getHost, updateHost } from "@bb/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  branchPromotionRequestSchema,
  type BranchPromotionRequest,
  type BranchPromotionSnapshot,
} from "@bb/domain";
import { getEnvironment, getThread, getActiveBranchPromotion } from "@bb/db";
import {
  validatePluginEnvironmentProviderDeclaration,
  validatePluginMachineProviderDeclaration,
} from "@get-bb/plugin-sdk/internal/host-policy";
import { setPluginMachineProviderBridge } from "../../src/services/plugins/plugin-machine-provider-registry.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { setPluginEnvironmentProviderBridge } from "../../src/services/plugins/plugin-environment-provider-registry.js";
import { invokePluginInline } from "../../src/services/plugins/plugin-hook-registry.js";
import {
  handleEnterBranchToolCall,
  inspectThreadBranchPromotion,
  resolveThreadBranchPromotion,
  validateBranchPromotionPlacement,
} from "../../src/services/threads/thread-environment-branch.fork.js";
import { handleKeepCheckoutToolCall } from "../../src/services/threads/thread-environment-directory.fork.js";
import { assertEnvironmentPathAvailable } from "../../src/services/environments/path-admission.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function setup(harness: TestAppHarness, loseResponse = false) {
  const { host, session } = seedHostSession(harness.deps, {
    id: "host-branch-promotion",
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/branch-promotion",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/branch-promotion",
    environmentProviderId: "project-checkout",
    branchName: "main",
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    promotionTarget: "branch",
    worktreePromotion: "armed",
  });
  harness.deps.db
    .update(environments)
    .set({ ownerThreadId: thread.id })
    .where(eq(environments.id, environment.id))
    .run();
  let branchName = "main";
  const requests: BranchPromotionRequest[] = [];
  registerHostRpcResponder(harness, {
    hostId: host.id,
    sessionId: session.id,
    handle: () => ({
      ok: true,
      result: {
        checkout: { kind: "branch", branchName, headSha: "a".repeat(40) },
        defaultBranch: "main",
        defaultBranchRelation: null,
        originDefaultBranch: null,
        isWorktree: false,
        hasUncommittedChanges: false,
        operation: { kind: "none" },
      },
    }),
  });
  const provider = validatePluginEnvironmentProviderDeclaration({
    id: "project-checkout",
    displayName: "Checkout",
    description: "Checkout",
    icon: "Folder",
    requires: { projectCheckout: true },
    inputs: z.object({ promotion: branchPromotionRequestSchema }),
    async remove() {
      throw new Error("Promotion must not remove the environment");
    },
    async create(context) {
      const request = z
        .object({ promotion: branchPromotionRequestSchema })
        .parse(context.inputs).promotion;
      requests.push(request);
      expect(await context.experimental_claimPath(environment.path!)).toBe(
        true,
      );
      if (request.action === "enter") {
        branchName = request.intent.target.name;
        if (loseResponse) throw new Error("lost response");
      }
      const snapshot: BranchPromotionSnapshot = {
        operationId: request.intent.operationId,
        phase:
          request.action === "resolve"
            ? request.observation === "observed"
              ? "resolved"
              : "uncertain"
            : loseResponse
              ? "uncertain"
              : "completed",
        branchName,
        headSha: "a".repeat(40),
        observation: "observed",
        commandTerminated: true,
        resolution: request.action === "resolve" ? request.resolution : null,
        message:
          request.action === "resolve" && request.observation !== "observed"
            ? "Checkout observation changed; inspect again before resolving"
            : null,
        replayed: request.action !== "enter",
      };
      return {
        status: "created",
        path: environment.path!,
        ownsPath: false,
        resource: snapshot,
      };
    },
  });
  const record = { pluginId: "environment-project-checkout", provider };
  setPluginEnvironmentProviderBridge({
    listEnvironmentProviders: () => [record],
    getEnvironmentProvider: () => record,
    invokeProvider: (_pluginId, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 1000,
  });
  const enter = (input: unknown = {}) =>
    handleEnterBranchToolCall(harness.deps, {
      thread,
      currentEnvironment: environment,
      input,
      signal: new AbortController().signal,
    });
  return { environment, thread, requests, enter, host, session };
}

afterEach(() => {
  setPluginEnvironmentProviderBridge(undefined);
  setPluginMachineProviderBridge(undefined);
});

describe("checkout branch promotion", () => {
  it("resumes the parent's suspended machine before inspecting branch placement", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/checkout",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/checkout",
        environmentProviderId: "project-checkout",
      });
      const parent = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const resume = vi.fn(async () => ({ resource: { id: "owned" } }));
      const record = {
        pluginId: "test-machine",
        provider: validatePluginMachineProviderDeclaration({
          id: "test-machine",
          displayName: "Test machine",
          description: "Test machine",
          icon: "Terminal",
          create: async () => ({
            status: "created",
            name: "Test machine",
            hostId: host.id,
            resource: { id: "owned" },
          }),
          suspend: async () => ({ resource: { id: "owned" } }),
          resume,
          remove: async () => ({ status: "removed" }),
          reconcileCleanup: async () => ({ status: "removed" }),
        }),
      };
      setPluginMachineProviderBridge({
        listMachineProviders: () => [record],
        getMachineProvider: () => record,
        invokeProvider: async (_id, _label, run) => ({
          ok: true,
          value: await run(),
        }),
        decisionTimeoutMs: 1000,
      });
      updateHost(harness.db, harness.hub, host.id, {
        machineProviderId: "test-machine",
        resource: { id: "owned" },
        phase: "suspended",
        suspendedAt: Date.now(),
      });
      let inspected = false;
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: ({ command }) => {
          expect(command.type).toBe("host.inspect_git_source");
          expect(resume).toHaveBeenCalledTimes(1);
          expect(getHost(harness.db, host.id)?.phase).toBe("active");
          inspected = true;
          return {
            ok: true,
            result: {
              checkout: {
                kind: "branch",
                branchName: "main",
                headSha: "a".repeat(40),
              },
              defaultBranch: "main",
              defaultBranchRelation: null,
              originDefaultBranch: null,
              isWorktree: false,
              hasUncommittedChanges: false,
              operation: { kind: "none" },
            },
          };
        },
      });
      const created = await createThreadFromRequest(harness.deps, {
        projectId: project.id,
        parentThreadId: parent.id,
        providerId: "codex",
        model: "gpt-5",
        input: [],
        origin: "app",
        startedOnBehalfOf: null,
        environment: { type: "project-default", promotion: "branch" },
      });
      expect(inspected).toBe(true);
      expect(created).toMatchObject({
        promotionTarget: "branch",
        worktreePromotion: "armed",
      });
    });
  });

  it.each(["branch", "detached", "unborn", "not-git", "worktree"])(
    "validates %s checkout placement before creating a branch-mode thread",
    async (kind) => {
      await withTestHarness(async (harness) => {
        const { host, session, environment } = setup(harness);
        registerHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
          handle: () => ({
            ok: true,
            result: {
              checkout:
                kind === "detached"
                  ? { kind: "detached", headSha: "a".repeat(40) }
                  : kind === "unborn"
                    ? { kind: "unborn", branchName: "main" }
                    : kind === "not-git"
                      ? { kind: "unknown", reason: "not a Git repository" }
                      : {
                          kind: "branch",
                          branchName: "main",
                          headSha: "a".repeat(40),
                        },
              defaultBranch: "main",
              defaultBranchRelation: null,
              originDefaultBranch: null,
              isWorktree: kind === "worktree",
              hasUncommittedChanges: false,
              operation: { kind: "none" },
            },
          }),
        });
        const validation = validateBranchPromotionPlacement(
          harness.deps,
          {
            type: "provider",
            environmentProviderId: "project-checkout",
            machine: { type: "existing", hostId: host.id },
            inputs: { path: environment.path },
          },
          { type: "project-default", promotion: "branch" },
        );
        if (kind === "branch")
          await expect(validation).resolves.toBeUndefined();
        else
          await expect(validation).rejects.toThrow(/requires a Git checkout/);
      });
    },
  );

  it("keeps the environment, persists metadata, and repeats completion without another switch", async () => {
    await withTestHarness(async (harness) => {
      const { thread, environment, enter, requests } = setup(harness);
      const response = await enter();
      expect(response).toMatchObject({ success: true });
      expect(getThread(harness.deps.db, thread.id)).toMatchObject({
        environmentId: environment.id,
        worktreePromotion: "promoted",
      });
      expect(getEnvironment(harness.deps.db, environment.id)).toMatchObject({
        path: environment.path,
        branchName: requests[0]!.intent.target.name,
        claimPath: null,
        defaultBranch: "main",
      });
      await enter();
      expect(requests).toHaveLength(1);
      expect(
        handleKeepCheckoutToolCall(harness.deps, {
          thread,
          currentEnvironment: environment,
          input: {},
        }),
      ).toMatchObject({ success: false });
    });
  });

  it("keeps lost responses reserved until inspection and explicit resolution", async () => {
    await withTestHarness(async (harness) => {
      const { thread, environment, enter, requests } = setup(harness, true);
      expect(await enter({ branch: "existing" })).toMatchObject({
        success: false,
      });
      expect(
        getActiveBranchPromotion(harness.deps.db, thread.id),
      ).not.toBeNull();
      expect(() =>
        assertEnvironmentPathAvailable(harness.deps, {
          hostId: environment.hostId,
          path: environment.path,
          threadId: thread.id,
        }),
      ).toThrow(/checkout/);
      const inspected = await inspectThreadBranchPromotion(
        harness.deps,
        thread.id,
        new AbortController().signal,
      );
      expect(inspected?.snapshot?.phase).toBe("uncertain");
      await expect(
        resolveThreadBranchPromotion(
          harness.deps,
          {
            threadId: thread.id,
            operationId: inspected!.operationId,
            observation: "stale",
            resolution: "accept-current",
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(
        "Checkout observation changed; inspect again before resolving",
      );
      expect(
        getActiveBranchPromotion(harness.deps.db, thread.id),
      ).not.toBeNull();
      await resolveThreadBranchPromotion(
        harness.deps,
        {
          threadId: thread.id,
          operationId: inspected!.operationId,
          observation: "observed",
          resolution: "accept-current",
        },
        new AbortController().signal,
      );
      expect(requests.map((request) => request.action)).toEqual([
        "enter",
        "inspect",
        "resolve",
        "resolve",
      ]);
      expect(getThread(harness.deps.db, thread.id)?.worktreePromotion).toBe(
        "promoted",
      );
      expect(() =>
        assertEnvironmentPathAvailable(harness.deps, {
          hostId: environment.hostId,
          path: environment.path,
          threadId: thread.id,
        }),
      ).not.toThrow();
    });
  });

  it("rejects malformed tool inputs before calling the provider", async () => {
    await withTestHarness(async (harness) => {
      const { enter, requests } = setup(harness);
      for (const input of [
        { branch: " " },
        { branch: "bad..ref" },
        { unknown: true },
      ])
        expect(await enter(input)).toMatchObject({ success: false });
      expect(requests).toHaveLength(0);
    });
  });
});
