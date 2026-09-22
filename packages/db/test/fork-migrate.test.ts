import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createConnection } from "../src/connection.js";
import { createProject } from "../src/data/projects.js";
import { createThread } from "../src/data/threads.js";
import { upsertHost } from "../src/data/hosts.js";
import { migrate } from "../src/migrate.js";
import { noopNotifier } from "../src/notifier.js";
import { threads } from "../src/schema.js";

const workQuiesceHash =
  "f162a056f845a9e712b63f50351f0651858c5659c6c2fc05cd063f49c15ca87f";
const legacyWorkQuiesceWhen = 1_789_478_684_565;
const threadStorageDeletedAtWhen = 1_789_421_366_079;

interface MigrationRow {
  createdAt: number;
  hash: string;
}

function migrationRows(
  db: ReturnType<typeof createConnection>,
  table: "__bb_fork_migrations" | "__drizzle_migrations",
): MigrationRow[] {
  return db.$client
    .prepare<[], MigrationRow>(
      `SELECT hash, created_at AS createdAt FROM ${table} ORDER BY created_at`,
    )
    .all();
}

describe("fork migrations", () => {
  it("keeps fork history out of the upstream migration ledger", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);

      expect(
        migrationRows(db, "__drizzle_migrations").some(
          (row) => row.hash === workQuiesceHash,
        ),
      ).toBe(false);
      expect(migrationRows(db, "__bb_fork_migrations")).toEqual([
        expect.objectContaining({ hash: workQuiesceHash }),
      ]);
    } finally {
      db.$client.close();
    }
  });

  it("rejects a noncontiguous or modified fork history", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      db.$client
        .prepare("UPDATE __bb_fork_migrations SET hash = 'modified'")
        .run();

      expect(() => migrate(db)).toThrow("Fork migration history is invalid");
    } finally {
      db.$client.close();
    }
  });

  it("adopts a legacy fork row without replaying an existing upstream column", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      const host = upsertHost(db, noopNotifier, { name: "host" });
      const { project } = createProject(db, noopNotifier, {
        name: "project",
        source: { type: "local_path", hostId: host.id, path: "/tmp/project" },
      });
      const thread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      db.update(threads)
        .set({ storageDeletedAt: 4_242 })
        .where(eq(threads.id, thread.id))
        .run();
      db.$client.exec(`
        DELETE FROM __bb_fork_migrations;
        DELETE FROM __drizzle_migrations
        WHERE created_at = ${threadStorageDeletedAtWhen};
        INSERT INTO __drizzle_migrations (hash, created_at)
        VALUES ('${workQuiesceHash}', ${legacyWorkQuiesceWhen});
      `);

      migrate(db);

      expect(
        db.select({ storageDeletedAt: threads.storageDeletedAt })
          .from(threads)
          .where(eq(threads.id, thread.id))
          .get(),
      ).toEqual({ storageDeletedAt: 4_242 });
      expect(migrationRows(db, "__drizzle_migrations")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ createdAt: threadStorageDeletedAtWhen }),
        ]),
      );
      expect(
        migrationRows(db, "__drizzle_migrations").some(
          (row) => row.createdAt === legacyWorkQuiesceWhen,
        ),
      ).toBe(false);
      expect(migrationRows(db, "__bb_fork_migrations")).toEqual([
        expect.objectContaining({ hash: workQuiesceHash }),
      ]);
    } finally {
      db.$client.close();
    }
  });

  it("refuses to adopt legacy history when the fork schema was altered", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      db.$client.exec(`
        DELETE FROM __bb_fork_migrations;
        DROP INDEX work_admissions_state_idx;
        INSERT INTO __drizzle_migrations (hash, created_at)
        VALUES ('${workQuiesceHash}', ${legacyWorkQuiesceWhen});
      `);

      expect(() => migrate(db)).toThrow(
        "Legacy fork migration schema does not match",
      );
    } finally {
      db.$client.close();
    }
  });
});
