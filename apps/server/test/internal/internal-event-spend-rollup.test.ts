import { and, eq, sql } from "drizzle-orm";
import {
  advanceThreadPruning,
  events,
  listSpendRollupRows,
  type SpendRollupRow,
} from "@bb/db";
import { turnScope } from "@bb/domain";
import {
  groupHostDaemonEvents,
  hostDaemonEventBatchResponseSchema,
  type HostDaemonEventEnvelope,
} from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { backfillSpend } from "../../src/services/system/spend-rollup.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

interface Reading {
  cached?: number;
  last: number;
  output?: number;
  total: number;
}

const TURN_ID = "turn-spend-1";
const PROVIDER_THREAD_ID = "provider-thread-spend";

function breakdown(total: number, parts: { cached?: number; output?: number }) {
  const cached = parts.cached ?? 0;
  const output = parts.output ?? 0;
  return {
    inputTokens: Math.max(0, total - cached - output),
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningOutputTokens: 0,
    totalTokens: total,
  };
}

function seedSpendThread(harness: TestAppHarness, hostId: string) {
  const { host, session } = seedHostSession(harness.deps, { id: hostId });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "codex",
    status: "active",
  });
  const turnStarted: HostDaemonEventEnvelope = {
    threadId: thread.id,
    event: {
      type: "turn/started",
      threadId: thread.id,
      providerThreadId: PROVIDER_THREAD_ID,
      scope: turnScope(TURN_ID),
    },
  };
  const usage = (reading: Reading): HostDaemonEventEnvelope => ({
    threadId: thread.id,
    event: {
      type: "thread/tokenUsage/updated",
      threadId: thread.id,
      providerThreadId: PROVIDER_THREAD_ID,
      scope: turnScope(TURN_ID),
      tokenUsage: {
        total: breakdown(reading.total, {}),
        last: breakdown(reading.last, {
          cached: reading.cached,
          output: reading.output,
        }),
        modelContextWindow: 258_400,
      },
    },
  });
  const post = (envelopes: HostDaemonEventEnvelope[]) =>
    harness.app.request("/internal/session/events", {
      method: "POST",
      headers: internalAuthHeaders(harness, { hostId: host.id }),
      body: JSON.stringify({
        sessionId: session.id,
        eventGroups: groupHostDaemonEvents(envelopes),
      }),
    });
  return {
    post,
    turnStarted,
    usage,
    totalTokens: () =>
      listSpendRollupRows(harness.db, { threadId: thread.id }).reduce(
        (sum, row) => sum + row.totalTokens,
        0,
      ),
    historyComplete: () =>
      harness.db.get<{ historyComplete: number }>(
        sql`SELECT history_complete AS historyComplete
            FROM fork_thread_spend_cursor WHERE thread_id = ${thread.id}`,
      )?.historyComplete,
    storedUsageEvents: () =>
      harness.db
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "thread/tokenUsage/updated"),
          ),
        )
        .all().length,
    latestSequence: () =>
      harness.db.get<{ latest: number }>(
        sql`SELECT MAX(sequence) AS latest FROM events
            WHERE thread_id = ${thread.id}`,
      )?.latest ?? 0,
  };
}

function runUsagePruning(harness: TestAppHarness): number {
  let removed = 0;
  for (let step = 0; step < 200; step += 1) {
    const result = advanceThreadPruning(harness.db, "usage");
    removed += result.removed;
    if (result.action === "cycle-complete") {
      return removed;
    }
  }
  throw new Error("Usage pruning did not complete a cycle");
}

describe("daemon event spend rollup", () => {
  it("records usage once, drops re-emissions, and survives a provider reset", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-spend",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "active",
      });

      const turnStarted: HostDaemonEventEnvelope = {
        threadId: thread.id,
        event: {
          type: "turn/started",
          threadId: thread.id,
          providerThreadId: PROVIDER_THREAD_ID,
          scope: turnScope(TURN_ID),
        },
      };
      const usage = (reading: Reading): HostDaemonEventEnvelope => ({
        threadId: thread.id,
        event: {
          type: "thread/tokenUsage/updated",
          threadId: thread.id,
          providerThreadId: PROVIDER_THREAD_ID,
          scope: turnScope(TURN_ID),
          tokenUsage: {
            total: breakdown(reading.total, {}),
            last: breakdown(reading.last, {
              cached: reading.cached,
              output: reading.output,
            }),
            modelContextWindow: 258_400,
          },
        },
      });
      const post = (envelopes: HostDaemonEventEnvelope[]) =>
        harness.app.request("/internal/session/events", {
          method: "POST",
          headers: internalAuthHeaders(harness, { hostId: host.id }),
          body: JSON.stringify({
            sessionId: session.id,
            eventGroups: groupHostDaemonEvents(envelopes),
          }),
        });
      const rollup = () =>
        listSpendRollupRows(harness.db, { threadId: thread.id });
      const totalTokens = () =>
        rollup().reduce((sum, row) => sum + row.totalTokens, 0);

      expect((await post([turnStarted])).status).toBe(200);
      expect(
        (
          await post([
            usage({ total: 100, last: 100 }),
            usage({ total: 100, last: 100 }),
            usage({ total: 250, last: 150 }),
          ])
        ).status,
      ).toBe(200);
      expect(totalTokens()).toBe(250);
      expect((await post([usage({ total: 250, last: 150 })])).status).toBe(200);
      expect(totalTokens()).toBe(250);
      expect(
        (
          await post([
            usage({ total: 40, last: 40 }),
            usage({ total: 90, last: 50 }),
          ])
        ).status,
      ).toBe(200);
      expect(totalTokens()).toBe(340);

      expect(rollup().map((row) => row.providerId)).toEqual(["codex"]);
    });
  });

  it("leaves the usage event in the thread's event log", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-spend-observe",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "active",
      });
      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: host.id }),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents([
            {
              threadId: thread.id,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: PROVIDER_THREAD_ID,
                scope: turnScope(TURN_ID),
              },
            },
            {
              threadId: thread.id,
              event: {
                type: "thread/tokenUsage/updated",
                threadId: thread.id,
                providerThreadId: PROVIDER_THREAD_ID,
                scope: turnScope(TURN_ID),
                tokenUsage: {
                  total: breakdown(100, {}),
                  last: breakdown(100, {}),
                  modelContextWindow: 258_400,
                },
              },
            },
          ]),
        }),
      });
      expect(response.status).toBe(200);

      const stored = harness.db
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "thread/tokenUsage/updated"),
          ),
        )
        .all();
      expect(stored).toHaveLength(1);
      const body = hostDaemonEventBatchResponseSchema.parse(
        await response.json(),
      );
      for (const accepted of body.acceptedEvents) {
        expect(Object.keys(accepted).sort()).toEqual([
          "eventIndex",
          "sequence",
          "threadId",
        ]);
      }
    });
  });

  it("backfills to exactly what the live path recorded", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-spend-backfill",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "active",
      });
      const usage = (reading: Reading): HostDaemonEventEnvelope => ({
        threadId: thread.id,
        event: {
          type: "thread/tokenUsage/updated",
          threadId: thread.id,
          providerThreadId: PROVIDER_THREAD_ID,
          scope: turnScope(TURN_ID),
          tokenUsage: {
            total: breakdown(reading.total, {}),
            last: breakdown(reading.last, {
              cached: reading.cached,
              output: reading.output,
            }),
            modelContextWindow: 258_400,
          },
        },
      });
      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: host.id }),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents([
            {
              threadId: thread.id,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: PROVIDER_THREAD_ID,
                scope: turnScope(TURN_ID),
              },
            },
            usage({ total: 100, last: 100, cached: 40, output: 10 }),
            usage({ total: 100, last: 100, cached: 40, output: 10 }),
            usage({ total: 250, last: 150, cached: 60, output: 20 }),
            usage({ total: 40, last: 40, output: 5 }),
            usage({ total: 90, last: 50, cached: 10, output: 5 }),
          ]),
        }),
      });
      expect(response.status).toBe(200);

      const live = listSpendRollupRows(harness.db, { threadId: thread.id });
      expect(live.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(340);

      const clear = () => {
        harness.db.run(sql`DELETE FROM fork_thread_spend_daily`);
        harness.db.run(sql`DELETE FROM fork_thread_spend_cursor`);
      };

      clear();
      expect(listSpendRollupRows(harness.db, { threadId: thread.id })).toEqual(
        [],
      );

      const first = backfillSpend(harness.db);
      expect(first.usageEventsScanned).toBe(5);
      const backfilled = listSpendRollupRows(harness.db, {
        threadId: thread.id,
      });
      expect(backfilled).toEqual(live);
      const second = backfillSpend(harness.db);
      expect(second.contributionsApplied).toBe(0);
      expect(listSpendRollupRows(harness.db, { threadId: thread.id })).toEqual<
        SpendRollupRow[]
      >(backfilled);

      clear();
      const liveAfterHistory = await harness.app.request(
        "/internal/session/events",
        {
          method: "POST",
          headers: internalAuthHeaders(harness, { hostId: host.id }),
          body: JSON.stringify({
            sessionId: session.id,
            eventGroups: groupHostDaemonEvents([
              usage({ total: 50, last: 50, output: 5 }),
            ]),
          }),
        },
      );
      expect(liveAfterHistory.status).toBe(200);
      expect(
        listSpendRollupRows(harness.db, { threadId: thread.id }).reduce(
          (sum, row) => sum + row.totalTokens,
          0,
        ),
      ).toBe(50);

      const caughtUp = backfillSpend(harness.db);
      expect(caughtUp.contributionsApplied).toBe(4);
      expect(
        listSpendRollupRows(harness.db, { threadId: thread.id }).reduce(
          (sum, row) => sum + row.totalTokens,
          0,
        ),
      ).toBe(390);
    });
  });

  it("keeps a complete thread complete when it spends again", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-spend-keeps",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "active",
      });
      const usage = (reading: Reading): HostDaemonEventEnvelope => ({
        threadId: thread.id,
        event: {
          type: "thread/tokenUsage/updated",
          threadId: thread.id,
          providerThreadId: PROVIDER_THREAD_ID,
          scope: turnScope(TURN_ID),
          tokenUsage: {
            total: breakdown(reading.total, {}),
            last: breakdown(reading.last, {}),
            modelContextWindow: 258_400,
          },
        },
      });
      const post = (envelopes: HostDaemonEventEnvelope[]) =>
        harness.app.request("/internal/session/events", {
          method: "POST",
          headers: internalAuthHeaders(harness, { hostId: host.id }),
          body: JSON.stringify({
            sessionId: session.id,
            eventGroups: groupHostDaemonEvents(envelopes),
          }),
        });
      const historyComplete = () =>
        harness.db.get<{ historyComplete: number }>(
          sql`SELECT history_complete AS historyComplete
              FROM fork_thread_spend_cursor WHERE thread_id = ${thread.id}`,
        )?.historyComplete;

      expect(
        (
          await post([
            {
              threadId: thread.id,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: PROVIDER_THREAD_ID,
                scope: turnScope(TURN_ID),
              },
            },
            usage({ total: 100, last: 100 }),
          ])
        ).status,
      ).toBe(200);
      harness.db.run(sql`DELETE FROM fork_thread_spend_cursor`);
      backfillSpend(harness.db);
      expect(historyComplete()).toBe(1);

      expect((await post([usage({ total: 250, last: 150 })])).status).toBe(200);
      expect(historyComplete()).toBe(1);
    });
  });

  it("does not double count a batch the daemon retried after it committed", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedSpendThread(harness, "host-spend-retry");
      expect((await fixture.post([fixture.turnStarted])).status).toBe(200);
      const batch = [
        fixture.usage({ total: 100, last: 100 }),
        fixture.usage({ total: 250, last: 150 }),
      ];
      expect((await fixture.post(batch)).status).toBe(200);
      expect(fixture.totalTokens()).toBe(250);
      expect((await fixture.post(batch)).status).toBe(200);
      expect(fixture.totalTokens()).toBe(250);
      expect(
        (await fixture.post([fixture.usage({ total: 330, last: 80 })])).status,
      ).toBe(200);
      expect(fixture.totalTokens()).toBe(330);

      harness.db.run(sql`DELETE FROM fork_thread_spend_daily`);
      harness.db.run(sql`DELETE FROM fork_thread_spend_cursor`);
      backfillSpend(harness.db);
      expect(fixture.totalTokens()).toBe(330);
    });
  });

  it("reports a backfilled thread as partial once the pruner removed usage", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedSpendThread(harness, "host-spend-pruned");
      expect(
        (
          await fixture.post([
            fixture.turnStarted,
            fixture.usage({ total: 100, last: 100 }),
            fixture.usage({ total: 250, last: 150 }),
            fixture.usage({ total: 400, last: 150 }),
          ])
        ).status,
      ).toBe(200);
      expect(runUsagePruning(harness)).toBeGreaterThan(0);
      expect(fixture.storedUsageEvents()).toBe(1);

      harness.db.run(sql`DELETE FROM fork_thread_spend_daily`);
      harness.db.run(sql`DELETE FROM fork_thread_spend_cursor`);
      const result = backfillSpend(harness.db);
      expect(result.threadsHistoryPartial).toBe(1);
      expect(fixture.historyComplete()).toBe(0);
      expect(fixture.totalTokens()).toBe(150);
    });
  });

  it("keeps a thread tracked from its first usage complete through pruning and backfill", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedSpendThread(harness, "host-spend-tracked");
      expect(
        (
          await fixture.post([
            fixture.turnStarted,
            fixture.usage({ total: 100, last: 100 }),
          ])
        ).status,
      ).toBe(200);
      expect(fixture.historyComplete()).toBe(1);
      for (let turn = 2; turn <= 70; turn += 1) {
        expect(
          (
            await fixture.post([
              fixture.usage({ total: turn * 100, last: 100 }),
              fixture.usage({ total: turn * 100, last: 100 }),
            ])
          ).status,
        ).toBe(200);
      }
      expect(fixture.latestSequence()).toBeGreaterThan(120);
      expect(fixture.totalTokens()).toBe(7_000);
      expect(fixture.historyComplete()).toBe(1);

      expect(runUsagePruning(harness)).toBeGreaterThan(0);
      const result = backfillSpend(harness.db);
      expect(result.contributionsApplied).toBe(0);
      expect(result.threadsHistoryComplete).toBe(1);
      expect(fixture.historyComplete()).toBe(1);
      expect(fixture.totalTokens()).toBe(7_000);
    });
  });
});
