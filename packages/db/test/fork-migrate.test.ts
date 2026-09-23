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
const worktreePromotionHash =
  "dbdda013c3b84e828babc97fcebe1761bea42507c6cf8dabcb6dc8b4b392f07d";
const branchPromotionHash =
  "9c385da0fe1dc75da9cc083a73b6dff8bd86eb6e23a32250823001138f2fc54a";
const adoptedFromStatusHash =
  "02d9525357114cfa6832d46cfc408b236a75e97e963e755c1934d4ede3cabd28";
const borrowedFeaturesHash =
  "3a412357541b0f5c0b06802bb966d8d39dd40cd650a7457e191ebef3853b263b";
const legacyWorkQuiesceWhen = 1_789_631_822_477;
const legacyWorktreePromotionWhen = 1_789_631_836_275;
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

function dropBranchPromotionSchema(
  db: ReturnType<typeof createConnection>,
): void {
  db.$client.exec(`
    DROP TABLE IF EXISTS branch_promotions;
    ALTER TABLE threads DROP COLUMN promotion_target;
    ALTER TABLE environments DROP COLUMN adopted_from_status;
  `);
}

function dropBorrowedFeatureSchema(
  db: ReturnType<typeof createConnection>,
): void {
  db.$client.exec(`
    DROP TABLE IF EXISTS fork_spend_prices;
    DROP TABLE IF EXISTS fork_thread_execution_reports;
    DROP TABLE IF EXISTS fork_thread_spend_cursor;
    DROP TABLE IF EXISTS fork_thread_spend_daily;
  `);
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
        expect.objectContaining({ hash: worktreePromotionHash }),
        expect.objectContaining({ hash: branchPromotionHash }),
        expect.objectContaining({ hash: adoptedFromStatusHash }),
        expect.objectContaining({ hash: borrowedFeaturesHash }),
      ]);
    } finally {
      db.$client.close();
    }
  });

  it("migrates the existing two-entry fork history without losing promotion intent", () => {
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
        .set({ worktreePromotion: "armed" })
        .where(eq(threads.id, thread.id))
        .run();
      dropBranchPromotionSchema(db);
      dropBorrowedFeatureSchema(db);
      db.$client.exec(`
        DELETE FROM __bb_fork_migrations
        WHERE hash IN ('${branchPromotionHash}', '${adoptedFromStatusHash}', '${borrowedFeaturesHash}');
      `);

      expect(migrationRows(db, "__bb_fork_migrations")).toEqual([
        expect.objectContaining({ hash: workQuiesceHash }),
        expect.objectContaining({ hash: worktreePromotionHash }),
      ]);

      migrate(db);

      expect(
        db
          .select({
            promotionTarget: threads.promotionTarget,
            worktreePromotion: threads.worktreePromotion,
          })
          .from(threads)
          .where(eq(threads.id, thread.id))
          .get(),
      ).toEqual({ promotionTarget: "worktree", worktreePromotion: "armed" });
      expect(
        db.$client
          .prepare<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'branch_promotions'",
          )
          .get(),
      ).toEqual({ name: "branch_promotions" });
      expect(migrationRows(db, "__bb_fork_migrations")).toEqual([
        expect.objectContaining({ hash: workQuiesceHash }),
        expect.objectContaining({ hash: worktreePromotionHash }),
        expect.objectContaining({ hash: branchPromotionHash }),
        expect.objectContaining({ hash: adoptedFromStatusHash }),
        expect.objectContaining({ hash: borrowedFeaturesHash }),
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
      dropBranchPromotionSchema(db);
      dropBorrowedFeatureSchema(db);
      db.$client.exec(`
        ALTER TABLE threads DROP COLUMN worktree_promotion;
        DELETE FROM __bb_fork_migrations;
        DELETE FROM __drizzle_migrations
        WHERE created_at = ${threadStorageDeletedAtWhen};
        INSERT INTO __drizzle_migrations (hash, created_at)
        VALUES ('${workQuiesceHash}', ${legacyWorkQuiesceWhen});
      `);

      migrate(db);

      expect(
        db
          .select({ storageDeletedAt: threads.storageDeletedAt })
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
        expect.objectContaining({ hash: worktreePromotionHash }),
        expect.objectContaining({ hash: branchPromotionHash }),
        expect.objectContaining({ hash: adoptedFromStatusHash }),
        expect.objectContaining({ hash: borrowedFeaturesHash }),
      ]);
    } finally {
      db.$client.close();
    }
  });

  it("adopts legacy worktree promotion without replaying or losing intent", () => {
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
        .set({ worktreePromotion: "armed" })
        .where(eq(threads.id, thread.id))
        .run();
      dropBranchPromotionSchema(db);
      dropBorrowedFeatureSchema(db);
      db.$client.exec(`
        DELETE FROM __bb_fork_migrations;
        INSERT INTO __drizzle_migrations (hash, created_at)
        VALUES
          ('${workQuiesceHash}', ${legacyWorkQuiesceWhen}),
          ('${worktreePromotionHash}', ${legacyWorktreePromotionWhen});
      `);

      migrate(db);

      expect(
        db
          .select({ worktreePromotion: threads.worktreePromotion })
          .from(threads)
          .where(eq(threads.id, thread.id))
          .get(),
      ).toEqual({ worktreePromotion: "armed" });
      expect(
        migrationRows(db, "__drizzle_migrations").some(
          (row) =>
            row.createdAt === legacyWorkQuiesceWhen ||
            row.createdAt === legacyWorktreePromotionWhen,
        ),
      ).toBe(false);
      expect(migrationRows(db, "__bb_fork_migrations")).toEqual([
        expect.objectContaining({ hash: workQuiesceHash }),
        expect.objectContaining({ hash: worktreePromotionHash }),
        expect.objectContaining({ hash: branchPromotionHash }),
        expect.objectContaining({ hash: adoptedFromStatusHash }),
        expect.objectContaining({ hash: borrowedFeaturesHash }),
      ]);
    } finally {
      db.$client.close();
    }
  });

  it("retains a legacy promotion row when the fork prefix is missing", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      db.$client.exec(`
        DELETE FROM __bb_fork_migrations;
        INSERT INTO __drizzle_migrations (hash, created_at)
        VALUES ('${worktreePromotionHash}', ${legacyWorktreePromotionWhen});
      `);

      expect(() => migrate(db)).toThrow(
        "Cannot adopt worktree promotion before work quiesce",
      );
      expect(migrationRows(db, "__drizzle_migrations")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            createdAt: legacyWorktreePromotionWhen,
            hash: worktreePromotionHash,
          }),
        ]),
      );
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

  it("refuses to adopt legacy promotion when the column was altered", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      db.$client.exec(`
        ALTER TABLE threads DROP COLUMN worktree_promotion;
        ALTER TABLE threads ADD worktree_promotion text DEFAULT 'declined';
        DELETE FROM __bb_fork_migrations;
        INSERT INTO __drizzle_migrations (hash, created_at)
        VALUES
          ('${workQuiesceHash}', ${legacyWorkQuiesceWhen}),
          ('${worktreePromotionHash}', ${legacyWorktreePromotionWhen});
      `);

      expect(() => migrate(db)).toThrow(
        "Legacy fork migration schema does not match 0001_thread_worktree_promotion: worktree_promotion",
      );
      expect(migrationRows(db, "__drizzle_migrations")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            createdAt: legacyWorktreePromotionWhen,
            hash: worktreePromotionHash,
          }),
        ]),
      );
    } finally {
      db.$client.close();
    }
  });
});
