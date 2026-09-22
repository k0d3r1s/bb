import { getAppSettings, listProviderTurnIdleWatchdogCandidates } from "@bb/db";
import type { ProviderTurnIdleWatchdogCandidateRow } from "@bb/db";
import type {
  ProviderTurnWatchdogAction,
  SystemProviderTurnWatchdogEventData,
} from "@bb/domain";
import { threadScope } from "@bb/domain";
import { getThread } from "@bb/db";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { emitPluginThreadTurnWatchdog } from "../plugins/plugin-thread-events.js";
import { appendThreadEvent } from "./thread-events.js";
import { requestThreadStop } from "./thread-lifecycle.js";

const PROVIDER_TURN_IDLE_WATCHDOG_BATCH_SIZE = 25;

type ProviderTurnWatchdogSweepDeps = LoggedPendingInteractionWorkSessionDeps;

interface RunProviderTurnWatchdogSweepOptions {
  now?: number;
}

interface RunProviderTurnWatchdogSweepResult {
  notifiedThreadIds: string[];
  interruptedThreadIds: string[];
}

interface BuildProviderTurnWatchdogEventDataArgs {
  action: ProviderTurnWatchdogAction;
  thresholdMs: number;
  now: number;
}

function buildProviderTurnWatchdogEventData(
  candidate: ProviderTurnIdleWatchdogCandidateRow,
  args: BuildProviderTurnWatchdogEventDataArgs,
): SystemProviderTurnWatchdogEventData {
  return {
    reason: "provider-turn-idle",
    action: args.action,
    thresholdMs: args.thresholdMs,
    elapsedMs: Math.max(0, candidate.elapsedMs),
    activeTurnId: candidate.activeTurnId,
    activeTurnStartedAt: candidate.activeTurnStartedAt,
    lastActivityEventSequence: candidate.lastActivityEventSequence,
    lastActivityEventType: candidate.lastActivityEventType,
    lastActivityEventAt: candidate.lastActivityEventAt,
    providerId: candidate.providerId,
    providerThreadId: candidate.providerThreadId,
    firedAt: args.now,
  };
}

function fireProviderTurnWatchdogStage(
  deps: ProviderTurnWatchdogSweepDeps,
  candidate: ProviderTurnIdleWatchdogCandidateRow,
  args: BuildProviderTurnWatchdogEventDataArgs,
): void {
  const data = buildProviderTurnWatchdogEventData(candidate, args);
  appendThreadEvent(deps, {
    threadId: candidate.threadId,
    environmentId: candidate.environmentId,
    type: "system/provider-turn-watchdog",
    scope: threadScope(),
    data,
  });
  const thread = getThread(deps.db, candidate.threadId);
  if (thread) {
    emitPluginThreadTurnWatchdog(thread, {
      elapsedMs: data.elapsedMs,
      thresholdMs: args.thresholdMs,
      action: args.action,
    });
  }
}

export function runProviderTurnWatchdogSweep(
  deps: ProviderTurnWatchdogSweepDeps,
  options: RunProviderTurnWatchdogSweepOptions = {},
): RunProviderTurnWatchdogSweepResult {
  const now = options.now ?? Date.now();
  const notifiedThreadIds: string[] = [];
  const interruptedThreadIds: string[] = [];

  const settings = getAppSettings(deps.db);
  if (!settings.providerTurnIdleWatchdogEnabled) {
    return { notifiedThreadIds, interruptedThreadIds };
  }
  const notifyMs = settings.providerTurnIdleNotifyMs;
  const interruptMs = settings.providerTurnIdleInterruptMs;

  const candidates = listProviderTurnIdleWatchdogCandidates(deps.db, {
    idleThresholdMs: notifyMs,
    limit: PROVIDER_TURN_IDLE_WATCHDOG_BATCH_SIZE,
    now,
  });

  for (const candidate of candidates) {
    const elapsedMs = Math.max(0, candidate.elapsedMs);
    try {
      if (elapsedMs >= interruptMs) {
        fireProviderTurnWatchdogStage(deps, candidate, {
          action: "interrupt",
          thresholdMs: interruptMs,
          now,
        });
        requestThreadStop(deps, {
          environmentId: candidate.environmentId,
          hostId: candidate.hostId,
          interruptionReason: "provider-turn-idle",
          threadId: candidate.threadId,
        });
        interruptedThreadIds.push(candidate.threadId);
        deps.logger.warn(
          {
            activeTurnId: candidate.activeTurnId,
            elapsedMs,
            interruptMs,
            lastActivityEventType: candidate.lastActivityEventType,
            providerId: candidate.providerId,
            threadId: candidate.threadId,
          },
          "Provider turn watchdog interrupted an idle provider turn",
        );
        continue;
      }

      if (!candidate.hasPriorWatchdogEvent) {
        fireProviderTurnWatchdogStage(deps, candidate, {
          action: "notify",
          thresholdMs: notifyMs,
          now,
        });
        notifiedThreadIds.push(candidate.threadId);
        deps.logger.warn(
          {
            activeTurnId: candidate.activeTurnId,
            elapsedMs,
            notifyMs,
            lastActivityEventType: candidate.lastActivityEventType,
            providerId: candidate.providerId,
            threadId: candidate.threadId,
          },
          "Provider turn watchdog flagged an idle provider turn",
        );
      }
    } catch (error) {
      deps.logger.warn(
        {
          err: error,
          threadId: candidate.threadId,
        },
        "Provider turn watchdog stage failed",
      );
    }
  }

  return { notifiedThreadIds, interruptedThreadIds };
}
