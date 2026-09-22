import {
  branchPromotionRequestSchema,
  type BranchPromotionRequest,
  type BranchPromotionSnapshot,
} from "bb-checkout-contract/branch-promotion";
import { setTimeout as delay } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type {
  PluginEnvironmentProviderCreateContext,
  PluginEnvironmentProviderCreateResult,
  PluginEnvironmentProviderProgress,
} from "@get-bb/plugin-sdk/environment-provider";
import { reportHostProgress } from "bb-environment-provider-host/progress";
import { z } from "zod";
import {
  checkoutBranchSelectionSchema,
  checkoutHostContract,
  checkoutHostSignals,
  type CheckoutBranchSelection,
  type CheckoutBranch,
} from "./contract.js";
import { PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";

const ATTACH_TIMEOUT_MS = 15 * 60 * 1000;
const LIVE_THREAD_STATUSES = new Set([
  "starting",
  "active",
  "idle",
  "stopping",
]);
const LIVE_THREAD_MESSAGE =
  "Cannot checkout branch while another thread is using this workspace";
const DETACHED_MESSAGE = "Checkout blocked while HEAD is detached";
const UNBORN_MESSAGE = "Checkout blocked before the first commit";
const CONFLICTS_MESSAGE = "Checkout blocked by unresolved conflicts";
const DIRTY_MESSAGE = "Checkout blocked by uncommitted changes";

export const checkoutInputsSchema = z.object({
  path: z.string().min(1).optional(),
  branch: checkoutBranchSelectionSchema.optional(),
  promotion: branchPromotionRequestSchema.optional(),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function claimCheckoutPath(
  context: PluginEnvironmentProviderCreateContext,
  path: string,
  hasBranch: boolean,
): Promise<boolean> {
  const deadline = Date.now() + ATTACH_TIMEOUT_MS;
  while (!(await context.experimental_claimPath(path))) {
    context.signal.throwIfAborted();
    if (hasBranch || Date.now() >= deadline) return false;
    await delay(50, undefined, { signal: context.signal });
  }
  return true;
}

function resolveCheckoutBranch(
  branch: CheckoutBranchSelection | undefined,
  suggestedName: string,
): CheckoutBranch | null {
  if (branch === undefined) return null;
  if (branch.kind === "existing") return branch;
  return { kind: "new", name: suggestedName, baseBranch: branch.baseBranch };
}

async function checkoutCreateBlocker(
  context: PluginEnvironmentProviderCreateContext,
  path: string,
  hasBranch: boolean,
  liveThreadUsesPath: () => Promise<boolean>,
): Promise<string | null> {
  if (!(await claimCheckoutPath(context, path, hasBranch)))
    return "Workspace is being prepared by another thread";
  return hasBranch && (await liveThreadUsesPath()) ? LIVE_THREAD_MESSAGE : null;
}

async function createPromotion(args: {
  context: PluginEnvironmentProviderCreateContext<
    { projectCheckout: true },
    typeof checkoutInputsSchema
  >;
  promotion: BranchPromotionRequest;
  reports: Map<string, PluginEnvironmentProviderProgress>;
  liveThreadUsesPath(): Promise<boolean>;
  call(request: BranchPromotionRequest): Promise<BranchPromotionSnapshot>;
}): Promise<PluginEnvironmentProviderCreateResult> {
  const { context, promotion, reports } = args;
  if (
    context.inputs.path !== undefined ||
    context.inputs.branch !== undefined
  ) {
    return {
      status: "failed",
      message: "Promotion cannot be combined with checkout inputs",
    };
  }
  if (!(await context.experimental_claimPath(promotion.intent.path))) {
    return {
      status: "failed",
      message: "Branch promotion reservation is no longer held",
    };
  }
  const blocked =
    promotion.action === "enter" && (await args.liveThreadUsesPath());
  const operationId = promotion.intent.operationId;
  reports.set(operationId, context.report);
  try {
    const result = await args.call(
      blocked ? { action: "inspect", intent: promotion.intent } : promotion,
    );
    return {
      status: "created",
      path: promotion.intent.path,
      ownsPath: false,
      resource: blocked ? { ...result, message: LIVE_THREAD_MESSAGE } : result,
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    return { status: "failed", message: errorMessage(error) };
  } finally {
    reports.delete(operationId);
  }
}

export default async function checkoutPlugin(bb: BbPluginApi): Promise<void> {
  const host = bb.hosts.experimental_client({
    contract: checkoutHostContract,
    experimental_signals: checkoutHostSignals,
  });
  const reports = new Map<string, PluginEnvironmentProviderProgress>();

  host.experimental_onSignal("progress", (event) => {
    const report = reports.get(event.payload.operationId);
    if (report !== undefined) reportHostProgress(report, event.payload);
  });

  async function otherLiveThreadUsesPath(args: {
    hostId: string;
    path: string;
    threadId: string | null;
  }): Promise<boolean> {
    const rows = await bb.sdk.environments.list({
      hostId: args.hostId,
      path: args.path,
    });
    for (const row of rows) {
      const threads = await bb.sdk.threads.list({
        environmentId: row.id,
        archived: false,
      });
      if (
        threads.some(
          (thread) =>
            thread.id !== args.threadId &&
            LIVE_THREAD_STATUSES.has(thread.status),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  async function branchSwitchBlocker(args: {
    hostId: string;
    path: string;
    branch: CheckoutBranchSelection;
  }): Promise<string | null> {
    let inspection;
    try {
      inspection = await host.call(
        "inspectCheckout",
        { path: args.path },
        { hostId: args.hostId },
      );
    } catch {
      return null;
    }
    if (!inspection.isGitRepo) {
      return null;
    }
    const { checkout, operation } = inspection;
    if (
      args.branch.kind === "existing" &&
      (checkout.kind === "branch" || checkout.kind === "unborn") &&
      checkout.branchName === args.branch.name
    ) {
      return null;
    }
    switch (checkout.kind) {
      case "branch":
        break;
      case "detached":
        return DETACHED_MESSAGE;
      case "unborn":
        return UNBORN_MESSAGE;
      case "unknown":
        return null;
    }
    if (operation.kind !== "none" && operation.hasConflicts) {
      return CONFLICTS_MESSAGE;
    }
    if (operation.kind !== "none") {
      return `Checkout blocked by an in-progress ${operation.kind}`;
    }
    if (inspection.hasUncommittedChanges) {
      return DIRTY_MESSAGE;
    }
    return null;
  }

  async function foreignEnvironmentAtPath(args: {
    hostId: string;
    path: string;
  }): Promise<string | null> {
    const rows = await bb.sdk.environments.list({
      hostId: args.hostId,
      path: args.path,
    });
    const environment = rows.find(
      (row) =>
        row.status !== "destroyed" &&
        row.environmentProviderId !== null &&
        row.environmentProviderId !== PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
    );
    return environment?.id ?? null;
  }

  bb.experimental_environments.register({
    id: PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
    displayName: "Project checkout",
    description: "Work in a project checkout on this machine.",
    icon: "Laptop",
    requires: { projectCheckout: true },
    inputs: checkoutInputsSchema,
    policy: { retireGraceMs: null },
    experimental_existingPath: (inputs) =>
      inputs.branch === undefined ? (inputs.path ?? null) : null,
    async validate(context) {
      if (context.inputs.promotion !== undefined) {
        return {
          action: "refuse",
          message:
            "Branch promotion is reserved for the internal promotion workflow",
        };
      }
      const branch = context.inputs.branch;
      const path = context.inputs.path ?? context.projectCheckout.path;
      const foreignEnvironmentId = await foreignEnvironmentAtPath({
        hostId: context.host.id,
        path,
      });
      if (foreignEnvironmentId !== null) {
        return {
          action: "refuse",
          message: `This directory belongs to environment ${foreignEnvironmentId}; reuse that environment instead.`,
        };
      }
      if (branch === undefined) {
        return { action: "accept" };
      }
      if (
        await otherLiveThreadUsesPath({
          hostId: context.host.id,
          path,
          threadId: null,
        })
      ) {
        return { action: "refuse", message: LIVE_THREAD_MESSAGE };
      }
      const blocker = await branchSwitchBlocker({
        hostId: context.host.id,
        path,
        branch,
      });
      return blocker === null
        ? { action: "accept" }
        : { action: "refuse", message: blocker };
    },
    async create(context) {
      const hostId = context.host.id;
      const promotion = context.inputs.promotion;
      if (promotion !== undefined) {
        return createPromotion({
          context,
          promotion,
          reports,
          liveThreadUsesPath: () =>
            otherLiveThreadUsesPath({
              hostId,
              path: promotion.intent.path,
              threadId: context.thread.id,
            }),
          call: (request) =>
            host.call("promoteBranch", request, {
              hostId,
              signal: context.signal,
              timeoutMs: ATTACH_TIMEOUT_MS,
            }),
        });
      }
      const path = context.inputs.path ?? context.projectCheckout.path;
      const branchInput = context.inputs.branch;
      const blocker = await checkoutCreateBlocker(
        context,
        path,
        branchInput !== undefined,
        () =>
          otherLiveThreadUsesPath({
            hostId,
            path,
            threadId: context.thread.id,
          }),
      );
      if (blocker !== null) return { status: "failed", message: blocker };
      const branch = resolveCheckoutBranch(
        branchInput,
        context.suggestedBranchName,
      );
      const operationId = `${context.pathKey}#${context.attempt}`;
      reports.set(operationId, context.report);
      try {
        const result = await host.call(
          "attach",
          { operationId, path, branch },
          { hostId, signal: context.signal, timeoutMs: ATTACH_TIMEOUT_MS },
        );
        if (result.status === "failed") {
          return {
            status: "failed",

            message: result.message,
          };
        }
        return {
          status: "created",
          path: result.path,
          ownsPath:
            result.path === context.projectCheckout.path &&
            context.projectCheckout.experimental_ownsPath === true,
        };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return {
          status: "failed",

          message: errorMessage(error),
        };
      } finally {
        reports.delete(operationId);
      }
    },
    async remove() {
      return { status: "removed" };
    },
  });
}
