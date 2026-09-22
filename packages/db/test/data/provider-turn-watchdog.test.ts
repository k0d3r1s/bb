import { describe, expect, it } from "vitest";
import { threadScope, turnScope } from "@bb/domain";
import { noopNotifier } from "../../src/notifier.js";
import { createEnvironment } from "../../src/data/environments.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { insertEvents } from "../../src/data/events.js";
import { createPendingInteraction } from "../../src/data/pending-interactions.js";
import { listProviderTurnIdleWatchdogCandidates } from "../../src/data/provider-turn-watchdog.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

const emptyItemFields = {
  itemId: null,
  itemKind: null,
  parentToolCallId: null,
} as const;

const NOW = 1_000_000;
const THRESHOLD = 1_000;

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "host-a" });
  const { project } = createProject(db, noopNotifier, {
    name: "project-a",
    source: { type: "local_path", hostId: host.id, path: "/tmp/a" },
  });
  const environment = createEnvironment(db, noopNotifier, {
    providerOwnsPath: false,
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/a",
  });
  const thread = createThread(db, noopNotifier, {
    environmentId: environment.id,
    projectId: project.id,
    providerId: "codex",
    status: "active",
  });
  return { db, environment, host, project, thread };
}

interface EventInput {
  sequence: number;
  type: string;
  createdAt: number;
  turnId?: string;
}

function seed(
  db: ReturnType<typeof setup>["db"],
  threadId: string,
  events: EventInput[],
): void {
  insertEvents(
    db,
    noopNotifier,
    events.map((event) => ({
      threadId,
      sequence: event.sequence,
      type: event.type as never,
      scope: event.turnId ? turnScope(event.turnId) : threadScope(),
      createdAt: event.createdAt,
      environmentId: null,
      providerThreadId: null,
      ...emptyItemFields,
      data: JSON.stringify({}),
    })),
  );
}

function listCandidates(db: ReturnType<typeof setup>["db"]) {
  return listProviderTurnIdleWatchdogCandidates(db, {
    idleThresholdMs: THRESHOLD,
    limit: 25,
    now: NOW,
  });
}

describe("listProviderTurnIdleWatchdogCandidates", () => {
  it("flags an active turn idle past the threshold", () => {
    const { db, thread } = setup();
    seed(db, thread.id, [
      { sequence: 1, type: "turn/started", createdAt: NOW - 2_000, turnId: "turn-1" },
    ]);

    const candidates = listCandidates(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      threadId: thread.id,
      activeTurnId: "turn-1",
      hasPriorWatchdogEvent: false,
    });
    expect(candidates[0]?.elapsedMs).toBe(2_000);
  });

  it("excludes a turn with recent activity (streaming)", () => {
    const { db, thread } = setup();
    seed(db, thread.id, [
      { sequence: 1, type: "turn/started", createdAt: NOW - 2_000, turnId: "turn-1" },
      {
        sequence: 2,
        type: "item/agentMessage/delta",
        createdAt: NOW - 500,
        turnId: "turn-1",
      },
    ]);

    expect(listCandidates(db)).toHaveLength(0);
  });

  it("excludes a turn awaiting a pending interaction", () => {
    const { db, thread } = setup();
    seed(db, thread.id, [
      { sequence: 1, type: "turn/started", createdAt: NOW - 2_000, turnId: "turn-1" },
    ]);
    createPendingInteraction(db, {
      threadId: thread.id,
      turnId: "turn-1",
      providerId: "codex",
      providerThreadId: "provider-thread-1",
      providerRequestId: "request-1",
      payload: JSON.stringify({ subject: { kind: "command" } }),
    });

    expect(listCandidates(db)).toHaveLength(0);
  });

  it("excludes a turn that already completed", () => {
    const { db, thread } = setup();
    seed(db, thread.id, [
      { sequence: 1, type: "turn/started", createdAt: NOW - 2_000, turnId: "turn-1" },
      {
        sequence: 2,
        type: "turn/completed",
        createdAt: NOW - 1_900,
        turnId: "turn-1",
      },
    ]);

    expect(listCandidates(db)).toHaveLength(0);
  });

  it("marks hasPriorWatchdogEvent once a watchdog event exists in the turn", () => {
    const { db, thread } = setup();
    seed(db, thread.id, [
      { sequence: 1, type: "turn/started", createdAt: NOW - 2_000, turnId: "turn-1" },
      {
        sequence: 2,
        type: "system/provider-turn-watchdog",
        createdAt: NOW - 1_000,
      },
    ]);

    const candidates = listCandidates(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.hasPriorWatchdogEvent).toBe(true);
  });
});
