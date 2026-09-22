import {
  getAppSettings,
  getThread,
  listEvents,
  setAppSettings,
} from "@bb/db";
import { systemProviderTurnWatchdogEventDataSchema } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { runProviderTurnWatchdogSweep } from "../../../src/services/threads/provider-turn-watchdog.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../../helpers/commands.js";
import { seedEvent, seedThreadFixture } from "../../helpers/seed.js";
import { withTestHarness } from "../../helpers/test-app.js";

const TURN_STARTED_AT = 1_000_000;
const NOTIFY_MS = 5 * 60_000;
const INTERRUPT_MS = 10 * 60_000;

describe("provider turn watchdog", () => {
  it("notifies once before interrupting and stopping an idle provider turn", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness, {
        thread: { status: "active" },
      });
      const turnId = "turn-watchdog";
      seedEvent(harness.deps, {
        createdAt: TURN_STARTED_AT,
        data: { providerThreadId: "provider-thread-watchdog" },
        environmentId: environment.id,
        providerThreadId: "provider-thread-watchdog",
        scope: { kind: "turn", turnId },
        sequence: 1,
        threadId: thread.id,
        type: "turn/started",
      });
      setAppSettings(harness.db, {
        ...getAppSettings(harness.db),
        providerTurnIdleNotifyMs: NOTIFY_MS,
        providerTurnIdleInterruptMs: INTERRUPT_MS,
      });

      expect(
        runProviderTurnWatchdogSweep(harness.deps, {
          now: TURN_STARTED_AT + NOTIFY_MS,
        }),
      ).toEqual({
        notifiedThreadIds: [thread.id],
        interruptedThreadIds: [],
      });
      expect(
        runProviderTurnWatchdogSweep(harness.deps, {
          now: TURN_STARTED_AT + NOTIFY_MS + 1,
        }),
      ).toEqual({
        notifiedThreadIds: [],
        interruptedThreadIds: [],
      });

      expect(
        runProviderTurnWatchdogSweep(harness.deps, {
          now: TURN_STARTED_AT + INTERRUPT_MS,
        }),
      ).toEqual({
        notifiedThreadIds: [],
        interruptedThreadIds: [thread.id],
      });

      const watchdogEvents = listEvents(harness.db, { threadId: thread.id })
        .filter((event) => event.type === "system/provider-turn-watchdog")
        .map((event) =>
          systemProviderTurnWatchdogEventDataSchema.parse(
            JSON.parse(event.data) as unknown,
          ),
        );
      expect(watchdogEvents.map((event) => event.action)).toEqual([
        "notify",
        "interrupt",
      ]);
      expect(watchdogEvents.map((event) => event.firedAt)).toEqual([
        TURN_STARTED_AT + NOTIFY_MS,
        TURN_STARTED_AT + INTERRUPT_MS,
      ]);
      expect(getThread(harness.db, thread.id)?.status).toBe("stopping");

      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      await reportQueuedCommandSuccess(harness, stopCommand, {
        providerCheckpointId: null,
      });
    });
  });
});
