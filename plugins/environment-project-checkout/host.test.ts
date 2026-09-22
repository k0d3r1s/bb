import { tryWithCheckoutMutationLock } from "bb-environment-provider-host/locks";
import { promoteBranch } from "./host/branch-promotion.js";
import { createHash, randomBytes } from "node:crypto";
import type { BranchPromotionIntent } from "bb-checkout-contract/branch-promotion";
import { execFile, spawn } from "node:child_process";
import {
  chmod,
  lstat,
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCheckoutHostEntry } from "./host.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "bb",
      GIT_AUTHOR_EMAIL: "bb@example.com",
      GIT_COMMITTER_NAME: "bb",
      GIT_COMMITTER_EMAIL: "bb@example.com",
    },
  });
  return result.stdout;
}

async function createRepository(): Promise<{ repo: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "bb-checkout-plugin-"));
  temporaryRoots.push(root);
  const repo = join(root, "repo");
  const dataDir = join(root, "plugin-data");
  await execFileAsync("mkdir", ["-p", repo, dataDir]);
  await git(repo, "init", "--initial-branch=main");
  await writeFile(join(repo, "README.md"), "hello\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");
  return { repo, dataDir };
}

function createHarness(dataDir: string) {
  return experimental_createHostEntryHarness(createCheckoutHostEntry(), {
    experimental_paths: { dataDir, tempDir: join(dataDir, "tmp") },
  });
}

function progressText(harness: ReturnType<typeof createHarness>): string {
  return harness
    .experimental_getSignals()
    .map((event) => event.payload.text)
    .join("\n");
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("checkout host entry", () => {
  it("attaches to the checkout as it is", async () => {
    const { repo, dataDir } = await createRepository();
    const harness = createHarness(dataDir);
    const result = await harness.experimental_call("attach", {
      operationId: "plain",
      path: repo,
      branch: null,
    });
    expect(result).toEqual({
      status: "attached",
      path: repo,
      branchName: "main",
    });
    expect(progressText(harness)).not.toContain("Using");
    await harness.experimental_dispose();
  });

  it("switches to an existing branch and creates a new one from a base", async () => {
    const { repo, dataDir } = await createRepository();
    await git(repo, "branch", "release");
    const harness = createHarness(dataDir);

    const existing = await harness.experimental_call("attach", {
      operationId: "existing",
      path: repo,
      branch: { kind: "existing", name: "release" },
    });
    expect(existing.status).toBe("attached");
    expect((await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe(
      "release",
    );
    expect(progressText(harness)).toContain("Switched to branch release");

    const created = await harness.experimental_call("attach", {
      operationId: "new",
      path: repo,
      branch: { kind: "new", name: "bb/feature-thr_1", baseBranch: "main" },
    });
    expect(created.status).toBe("attached");
    expect((await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe(
      "bb/feature-thr_1",
    );
    expect(progressText(harness)).toContain("Created branch bb/feature-thr_1");
    await harness.experimental_dispose();
  });

  it("resumes the same branch switch idempotently after restart", async () => {
    const { repo, dataDir } = await createRepository();
    await git(repo, "branch", "release");
    const first = createHarness(dataDir);
    expect(
      await first.experimental_call("attach", {
        operationId: "same-path-key-1",
        path: repo,
        branch: { kind: "existing", name: "release" },
      }),
    ).toMatchObject({ status: "attached", branchName: "release" });
    await first.experimental_dispose();

    const restarted = createHarness(dataDir);
    expect(
      await restarted.experimental_call("attach", {
        operationId: "same-path-key-2",
        path: repo,
        branch: { kind: "existing", name: "release" },
      }),
    ).toMatchObject({ status: "attached", branchName: "release" });
    expect((await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe(
      "release",
    );
    await restarted.experimental_dispose();
  });

  it("refuses to switch branches over uncommitted changes", async () => {
    const { repo, dataDir } = await createRepository();
    await git(repo, "branch", "release");
    await writeFile(join(repo, "README.md"), "edited\n");
    const harness = createHarness(dataDir);
    const result = await harness.experimental_call("attach", {
      operationId: "dirty",
      path: repo,
      branch: { kind: "existing", name: "release" },
    });
    expect(result).toMatchObject({
      status: "failed",
      message: expect.stringContaining("uncommitted changes"),
    });
    expect((await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe(
      "main",
    );
    await harness.experimental_dispose();
  });

  it("inspects dirty and detached checkouts", async () => {
    const { repo, dataDir } = await createRepository();
    await writeFile(join(repo, "README.md"), "edited\n");
    const harness = createHarness(dataDir);
    expect(
      await harness.experimental_call("inspectCheckout", { path: repo }),
    ).toMatchObject({
      isGitRepo: true,
      checkout: { kind: "branch", branchName: "main" },
      hasUncommittedChanges: true,
      operation: { kind: "none" },
    });
    await git(repo, "checkout", "--detach", "HEAD");
    expect(
      await harness.experimental_call("inspectCheckout", { path: repo }),
    ).toMatchObject({
      isGitRepo: true,
      checkout: { kind: "detached" },
      operation: { kind: "none" },
    });
    await harness.experimental_dispose();
  });

  it("fails a plain attach on a missing directory", async () => {
    const { dataDir } = await createRepository();
    const harness = createHarness(dataDir);
    const result = await harness.experimental_call("attach", {
      operationId: "missing",
      path: join(dataDir, "nope"),
      branch: null,
    });
    expect(result).toMatchObject({
      status: "failed",
      message: expect.stringContaining("does not exist"),
    });
    await harness.experimental_dispose();
  });
});

describe("branch promotion host receipts", () => {
  async function setup(kind: "new" | "existing" = "new") {
    const { repo, dataDir } = await createRepository();
    if (kind === "existing") await git(repo, "branch", "feature");
    const intent: BranchPromotionIntent = {
      operationId: "opaque/../operation",
      path: repo,
      sourceBranch: "main",
      sourceHead: (await git(repo, "rev-parse", "HEAD")).trim(),
      target: { kind, name: "feature" },
    };
    return { repo, dataDir, intent, harness: createHarness(dataDir) };
  }

  async function pending(
    dataDir: string,
    intent: BranchPromotionIntent,
    commandGroupId: number | null = null,
  ) {
    const file = join(
      dataDir,
      "branch-promotions",
      `${createHash("sha256").update(intent.operationId).digest("hex")}.json`,
    );
    await mkdir(join(dataDir, "branch-promotions"), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        intent,
        commandGroupId,
        snapshot: {
          operationId: intent.operationId,
          phase: "running",
          branchName: "main",
          headSha: intent.sourceHead,
          observation: "before-command",
          commandTerminated: false,
          resolution: null,
          message: null,
          replayed: false,
        },
      }),
    );
    return file;
  }

  it.each(["new", "existing"] as const)(
    "promotes %s and replays durably after restart",
    async (kind) => {
      const { repo, dataDir, intent, harness } = await setup(kind);
      const first = await harness.experimental_call("promoteBranch", {
        action: "enter",
        intent,
      });
      expect(first).toMatchObject({
        phase: "completed",
        branchName: "feature",
        headSha: intent.sourceHead,
        commandTerminated: true,
        replayed: false,
      });
      await harness.experimental_dispose();
      const restarted = createHarness(dataDir);
      expect(
        await restarted.experimental_call("promoteBranch", {
          action: "enter",
          intent,
        }),
      ).toMatchObject({ ...first, replayed: true });
      expect((await git(repo, "branch", "--list", "feature")).trim()).toBe(
        "* feature",
      );
      expect(
        await restarted.experimental_call("promoteBranch", {
          action: "enter",
          intent: { ...intent, target: { kind: "new", name: "another" } },
        }),
      ).toMatchObject({
        phase: "failed",
        message: expect.stringContaining("different intent"),
      });
      expect((await git(repo, "branch", "--list", "another")).trim()).toBe("");
      await restarted.experimental_dispose();
    },
  );

  it("does not reset a colliding new branch", async () => {
    const { repo, intent, harness } = await setup();
    await git(repo, "branch", "feature");
    await writeFile(join(repo, "second"), "commit two");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "second");
    const sourceHead = (await git(repo, "rev-parse", "HEAD")).trim();
    const result = await harness.experimental_call("promoteBranch", {
      action: "enter",
      intent: { ...intent, sourceHead },
    });
    expect(result).toMatchObject({
      phase: "failed",
      message: "Target branch already exists",
      branchName: "main",
    });
    expect((await git(repo, "rev-parse", "feature")).trim()).toBe(
      intent.sourceHead,
    );
    await harness.experimental_dispose();
  });

  it.each([
    "tracked",
    "untracked",
    "source-head",
    "source-branch",
    "operation",
    "missing-target",
  ])("refuses %s state before mutation", async (mode) => {
    const { repo, intent, harness } = await setup();
    if (mode === "tracked") await writeFile(join(repo, "README.md"), "dirty");
    if (mode === "untracked") await writeFile(join(repo, "new.txt"), "dirty");
    if (mode === "source-head") intent.sourceHead = "0".repeat(40);
    if (mode === "source-branch") intent.sourceBranch = "other";
    if (mode === "operation")
      await writeFile(join(repo, ".git", "MERGE_HEAD"), intent.sourceHead);
    if (mode === "missing-target") intent.target.kind = "existing";
    expect(
      await harness.experimental_call("promoteBranch", {
        action: "enter",
        intent,
      }),
    ).toMatchObject({
      phase: "failed",
      commandTerminated: true,
      branchName: "main",
    });
    expect((await git(repo, "branch", "--list", "feature")).trim()).toBe("");
    await harness.experimental_dispose();
  });

  it("tombstones an absent receipt before a delayed enter", async () => {
    const { repo, intent, harness } = await setup();
    expect(
      await harness.experimental_call("promoteBranch", {
        action: "inspect",
        intent,
      }),
    ).toMatchObject({ phase: "failed", commandTerminated: true });
    expect(
      await harness.experimental_call("promoteBranch", {
        action: "enter",
        intent,
      }),
    ).toMatchObject({ phase: "failed", replayed: true });
    expect((await git(repo, "branch", "--list", "feature")).trim()).toBe("");
    await harness.experimental_dispose();
  });

  it.each(["tracked", "untracked", "staged"])(
    "rejects content drift in an already dirty %s file",
    async (kind) => {
      const { repo, dataDir, intent, harness } = await setup();
      await pending(dataDir, intent);
      const file = join(
        repo,
        kind === "untracked" ? "untracked.txt" : "README.md",
      );
      await writeFile(file, "first dirty contents");
      if (kind === "staged") await git(repo, "add", "README.md");
      const before = await harness.experimental_call("promoteBranch", {
        action: "inspect",
        intent,
      });
      await writeFile(file, "second dirty contents");
      if (kind === "staged") await git(repo, "add", "README.md");
      expect(
        await harness.experimental_call("promoteBranch", {
          action: "resolve",
          intent,
          observation: before.observation,
          resolution: "keep-current",
        }),
      ).toMatchObject({
        phase: "uncertain",
        message: expect.stringContaining("changed"),
      });
      const current = await harness.experimental_call("promoteBranch", {
        action: "inspect",
        intent,
      });
      expect(
        await harness.experimental_call("promoteBranch", {
          action: "resolve",
          intent,
          observation: current.observation,
          resolution: "keep-current",
        }),
      ).toMatchObject({ phase: "resolved" });
      await writeFile(file, "contents changed after host acknowledgement");
      expect(
        await harness.experimental_call("promoteBranch", {
          action: "inspect",
          intent,
        }),
      ).toMatchObject({ phase: "uncertain" });
      await harness.experimental_dispose();
    },
  );

  it.each(["working", "staged"])(
    "refuses and recovers a large dirty %s binary without buffering its diff",
    async (kind) => {
      const { repo, dataDir, intent, harness } = await setup();
      const contents = randomBytes(17 * 1024 * 1024);
      contents[0] = 0;
      await writeFile(join(repo, "README.md"), contents);
      if (kind === "staged") await git(repo, "add", "README.md");
      expect(
        await harness.experimental_call("promoteBranch", {
          action: "enter",
          intent,
        }),
      ).toMatchObject({ phase: "failed", commandTerminated: true });
      expect((await git(repo, "branch", "--list", "feature")).trim()).toBe("");
      await pending(dataDir, intent);
      const current = await harness.experimental_call("promoteBranch", {
        action: "inspect",
        intent,
      });
      expect(
        await harness.experimental_call("promoteBranch", {
          action: "resolve",
          intent,
          observation: current.observation,
          resolution: "keep-current",
        }),
      ).toMatchObject({ phase: "resolved", resolution: "keep-current" });
      expect((await readFile(join(repo, "README.md"))).equals(contents)).toBe(
        true,
      );
      await harness.experimental_dispose();
    },
  );

  it.each(["deleted", "renamed", "replaced-parent"])(
    "rejects a stale observation after a tracked file is %s",
    async (kind) => {
      const { repo, dataDir, intent, harness } = await setup();
      if (kind === "replaced-parent") {
        await mkdir(join(repo, "parent"));
        await git(repo, "mv", "README.md", "parent/README.md");
        await git(repo, "commit", "-m", "Move tracked file into directory");
        intent.sourceHead = (await git(repo, "rev-parse", "HEAD")).trim();
      }
      await pending(dataDir, intent);
      const before = await harness.experimental_call("promoteBranch", {
        action: "inspect",
        intent,
      });
      if (kind === "deleted") await rm(join(repo, "README.md"));
      else if (kind === "replaced-parent") {
        await rm(join(repo, "parent"), { recursive: true });
        await writeFile(join(repo, "parent"), "replacement file");
      } else await rename(join(repo, "README.md"), join(repo, "renamed.md"));
      expect(
        await harness.experimental_call("promoteBranch", {
          action: "resolve",
          intent,
          observation: before.observation,
          resolution: "keep-current",
        }),
      ).toMatchObject({
        phase: "uncertain",
        message: expect.stringContaining("changed"),
      });
      const current = await harness.experimental_call("promoteBranch", {
        action: "inspect",
        intent,
      });
      expect(
        await harness.experimental_call("promoteBranch", {
          action: "resolve",
          intent,
          observation: current.observation,
          resolution: "keep-current",
        }),
      ).toMatchObject({ phase: "resolved" });
      await harness.experimental_dispose();
    },
  );

  it("distinguishes untracked contents that move across file boundaries", async () => {
    const { repo, dataDir, intent, harness } = await setup();
    await pending(dataDir, intent);
    await writeFile(join(repo, "a"), "x");
    await writeFile(join(repo, "b"), "y");
    const header = JSON.stringify(["b", (await lstat(join(repo, "b"))).mode]);
    await writeFile(join(repo, "b"), `${header}y`);
    const before = await harness.experimental_call("promoteBranch", {
      action: "inspect",
      intent,
    });
    await writeFile(join(repo, "a"), `x${header}`);
    await writeFile(join(repo, "b"), "y");
    expect(
      await harness.experimental_call("promoteBranch", {
        action: "resolve",
        intent,
        observation: before.observation,
        resolution: "keep-current",
      }),
    ).toMatchObject({
      phase: "uncertain",
      message: expect.stringContaining("changed"),
    });
    await harness.experimental_dispose();
  });

  it("requires fresh acknowledgement when a keep-current resolution drifts before settlement", async () => {
    const { repo, dataDir, intent, harness } = await setup();
    await pending(dataDir, intent);
    const before = await harness.experimental_call("promoteBranch", {
      action: "inspect",
      intent,
    });
    await harness.experimental_call("promoteBranch", {
      action: "resolve",
      intent,
      observation: before.observation,
      resolution: "keep-current",
    });
    await git(repo, "switch", "-c", "manual-after-resolution");
    expect(
      await harness.experimental_call("promoteBranch", {
        action: "inspect",
        intent,
      }),
    ).toMatchObject({
      phase: "uncertain",
      branchName: "manual-after-resolution",
    });
    await harness.experimental_dispose();
  });

  it("never replays a pending receipt and resolves only a fresh acceptable observation", async () => {
    const { repo, dataDir, intent, harness } = await setup();
    const file = await pending(dataDir, intent);
    const uncertain = await harness.experimental_call("promoteBranch", {
      action: "enter",
      intent,
    });
    expect(uncertain).toMatchObject({
      phase: "uncertain",
      commandTerminated: true,
      branchName: "main",
      replayed: true,
    });
    expect((await git(repo, "branch", "--list", "feature")).trim()).toBe("");
    expect(
      await harness.experimental_call("promoteBranch", {
        action: "resolve",
        intent,
        observation: uncertain.observation,
        resolution: "accept-current",
      }),
    ).toMatchObject({
      phase: "uncertain",
      message: expect.stringContaining("does not match"),
    });
    await git(repo, "switch", "-c", "manual");
    expect(
      await harness.experimental_call("promoteBranch", {
        action: "resolve",
        intent,
        observation: uncertain.observation,
        resolution: "keep-current",
      }),
    ).toMatchObject({
      phase: "uncertain",
      message: expect.stringContaining("changed"),
    });
    const fresh = await harness.experimental_call("promoteBranch", {
      action: "inspect",
      intent,
    });
    expect(
      await harness.experimental_call("promoteBranch", {
        action: "resolve",
        intent,
        observation: fresh.observation,
        resolution: "keep-current",
      }),
    ).toMatchObject({
      phase: "resolved",
      resolution: "keep-current",
      branchName: "manual",
    });
    expect(JSON.parse(await readFile(file, "utf8")).snapshot.phase).toBe(
      "resolved",
    );
    expect(
      await harness.experimental_call("promoteBranch", {
        action: "enter",
        intent,
      }),
    ).toMatchObject({
      phase: "resolved",
      replayed: true,
      branchName: "manual",
    });
    await harness.experimental_dispose();
  });

  it("accepts current target after a pending switch and surfaces completed drift", async () => {
    const { repo, dataDir, intent, harness } = await setup();
    await pending(dataDir, intent);
    await git(repo, "switch", "-c", "feature");
    const current = await harness.experimental_call("promoteBranch", {
      action: "inspect",
      intent,
    });
    expect(
      await harness.experimental_call("promoteBranch", {
        action: "resolve",
        intent,
        observation: current.observation,
        resolution: "accept-current",
      }),
    ).toMatchObject({ phase: "resolved", resolution: "accept-current" });
    const second = {
      ...intent,
      operationId: "second",
      sourceBranch: "feature",
      target: { kind: "new" as const, name: "second" },
    };
    await harness.experimental_call("promoteBranch", {
      action: "enter",
      intent: second,
    });
    await git(repo, "switch", "main");
    const drift = await harness.experimental_call("promoteBranch", {
      action: "inspect",
      intent: second,
    });
    expect(drift).toMatchObject({ phase: "uncertain", branchName: "main" });
    expect(
      await harness.experimental_call("promoteBranch", {
        action: "resolve",
        intent: second,
        observation: drift.observation,
        resolution: "keep-current",
      }),
    ).toMatchObject({ phase: "resolved" });
    await harness.experimental_dispose();
  });

  it("waits for the existing mutation lock before declaring command termination", async () => {
    const { repo, dataDir, intent, harness } = await setup();
    await pending(dataDir, intent);
    let acquiredResolve = () => {};
    let releaseResolve = () => {};
    const acquired = {
      promise: new Promise<void>((resolve) => {
        acquiredResolve = resolve;
      }),
      resolve: () => acquiredResolve(),
    };
    const release = {
      promise: new Promise<void>((resolve) => {
        releaseResolve = resolve;
      }),
      resolve: () => releaseResolve(),
    };
    const locked = tryWithCheckoutMutationLock(repo, async () => {
      acquired.resolve();
      await release.promise;
      await git(repo, "switch", "-c", "feature");
    });
    await acquired.promise;
    let finished = false;
    const inspecting = harness
      .experimental_call("promoteBranch", { action: "inspect", intent })
      .then((result) => {
        finished = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(finished).toBe(false);
    release.resolve();
    await locked;
    expect(await inspecting).toMatchObject({
      phase: "uncertain",
      branchName: "feature",
      commandTerminated: true,
    });
    await harness.experimental_dispose();
  });

  it("records cancellation without replaying the mutation", async () => {
    const { repo, dataDir, intent, harness } = await setup();
    const controller = new AbortController();
    const result = await promoteBranch({
      request: { action: "enter", intent },
      dataDir,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    expect(result).toMatchObject({
      phase: "uncertain",
      commandTerminated: true,
      branchName: "main",
    });
    expect(
      await harness.experimental_call("promoteBranch", {
        action: "enter",
        intent,
      }),
    ).toMatchObject({ phase: "uncertain", replayed: true });
    expect((await git(repo, "branch", "--list", "feature")).trim()).toBe("");
    await harness.experimental_dispose();
  });

  it.each([
    "--detach",
    "bad..branch",
    "refs/heads/.hidden",
    "branch.lock",
    "@{-1}",
  ])("rejects invalid target %s at the RPC boundary", async (name) => {
    const { repo, intent, harness } = await setup();
    await expect(
      harness.experimental_call("promoteBranch", {
        action: "enter",
        intent: { ...intent, target: { kind: "new", name } },
      }),
    ).rejects.toThrow();
    expect((await git(repo, "branch", "--show-current")).trim()).toBe("main");
    await harness.experimental_dispose();
  });

  it("does not resolve a pending receipt while its original command PID is alive", async () => {
    const { repo, dataDir, intent, harness } = await setup();
    const child = spawn(
      "/bin/sh",
      ["-c", "read token && exec git switch -c feature"],
      { cwd: repo, detached: true, stdio: ["pipe", "ignore", "ignore"] },
    );
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    if (child.pid === undefined) throw new Error("Missing child PID");
    try {
      await pending(dataDir, intent, child.pid);
      const running = await harness.experimental_call("promoteBranch", {
        action: "inspect",
        intent,
      });
      expect(running).toMatchObject({
        phase: "uncertain",
        commandTerminated: false,
      });
      expect(
        await harness.experimental_call("promoteBranch", {
          action: "enter",
          intent: { ...intent, target: { kind: "new", name: "different" } },
        }),
      ).toMatchObject({
        phase: "uncertain",
        commandTerminated: false,
        message: expect.stringContaining("different intent"),
      });
      expect(
        await harness.experimental_call("promoteBranch", {
          action: "resolve",
          intent,
          observation: running.observation,
          resolution: "keep-current",
        }),
      ).toMatchObject({ phase: "uncertain", commandTerminated: false });
      child.stdin.end("go\n");
      await closed;
      const finished = await harness.experimental_call("promoteBranch", {
        action: "inspect",
        intent,
      });
      expect(finished).toMatchObject({
        phase: "uncertain",
        commandTerminated: true,
        branchName: "feature",
      });
      expect(
        await harness.experimental_call("promoteBranch", {
          action: "resolve",
          intent,
          observation: finished.observation,
          resolution: "accept-current",
        }),
      ).toMatchObject({ phase: "resolved" });
    } finally {
      child.stdin.end();
      await closed;
      await harness.experimental_dispose();
    }
  });

  it("keeps recovery queued through cancellation until the command streams close", async () => {
    const { repo, dataDir, intent, harness } = await setup();
    const marker = join(repo, ".git", "promotion-hook-started");
    const gate = join(repo, ".git", "promotion-hook-release");
    const hook = join(repo, ".git", "hooks", "post-checkout");
    await writeFile(
      hook,
      "#!/bin/sh\ntrap '' TERM\nprintf started > .git/promotion-hook-started\nwhile [ ! -f .git/promotion-hook-release ]; do sleep 0.01; done\n",
    );
    await chmod(hook, 0o755);
    const controller = new AbortController();
    const promoting = promoteBranch({
      request: { action: "enter", intent },
      dataDir,
      signal: controller.signal,
    });
    try {
      await vi.waitFor(async () => {
        await access(marker);
      });
      let finished = false;
      const inspecting = harness
        .experimental_call("promoteBranch", { action: "inspect", intent })
        .then((result) => {
          finished = true;
          return result;
        });
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(finished).toBe(false);
      await writeFile(gate, "release");
      expect(await promoting).toMatchObject({
        phase: "uncertain",
        branchName: "feature",
        commandTerminated: true,
      });
      expect(await inspecting).toMatchObject({
        phase: "uncertain",
        commandTerminated: true,
      });
    } finally {
      await writeFile(gate, "release");
      await promoting;
      await harness.experimental_dispose();
    }
  });

  it("refuses recovery without a checkout mutation lock", async () => {
    const { dataDir, intent, harness } = await setup();
    const checkoutPath = join(dataDir, "not-a-repository");
    await mkdir(checkoutPath);
    for (const action of ["enter", "inspect"] as const) {
      await expect(
        harness.experimental_call("promoteBranch", {
          action,
          intent: { ...intent, path: checkoutPath },
        }),
      ).rejects.toThrow("checkout mutation lock");
    }
    await expect(access(join(dataDir, "branch-promotions"))).rejects.toThrow();
    await harness.experimental_dispose();
  });

  it.each(["branch", "head", "contents"] as const)(
    "does not complete when a successful checkout hook changes the target %s",
    async (mode) => {
      const { repo, intent, harness } = await setup();
      const otherHead = (
        await git(
          repo,
          "commit-tree",
          "HEAD^{tree}",
          "-p",
          "HEAD",
          "-m",
          "other",
        )
      ).trim();
      const hook = join(repo, ".git", "hooks", "post-checkout");
      const command =
        mode === "branch"
          ? "git symbolic-ref HEAD refs/heads/main"
          : mode === "head"
            ? `git update-ref refs/heads/feature ${otherHead}`
            : "printf changed > README.md";
      await writeFile(hook, `#!/bin/sh\n${command}\n`);
      await chmod(hook, 0o755);
      const result = await harness.experimental_call("promoteBranch", {
        action: "enter",
        intent,
      });
      expect(result).toMatchObject({
        phase: "uncertain",
        commandTerminated: true,
        message: expect.stringContaining("no longer matches"),
      });
      expect(result.branchName).toBe(mode === "branch" ? "main" : "feature");
      expect(result.headSha).toBe(
        mode === "head" ? otherHead : intent.sourceHead,
      );
      expect(
        await harness.experimental_call("promoteBranch", {
          action: "enter",
          intent,
        }),
      ).toMatchObject({ phase: "uncertain", replayed: true });
      await harness.experimental_dispose();
    },
  );

  it("blocks restarted recovery after Git exits while its hook still owns the process group", async () => {
    const { repo, dataDir, intent, harness } = await setup();
    const marker = join(repo, ".git", "orphan-hook-started");
    const gate = join(repo, ".git", "orphan-hook-release");
    const hook = join(repo, ".git", "hooks", "post-checkout");
    await writeFile(
      hook,
      "#!/bin/sh\nprintf started > .git/orphan-hook-started\nwhile [ ! -f .git/orphan-hook-release ]; do sleep 0.01; done\ngit symbolic-ref HEAD refs/heads/main\n",
    );
    await chmod(hook, 0o755);
    const child = spawn("git", ["switch", "-c", "feature", intent.sourceHead], {
      cwd: repo,
      detached: true,
      stdio: "ignore",
    });
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    const groupId = child.pid;
    if (groupId === undefined) throw new Error("Missing process group ID");
    try {
      await pending(dataDir, intent, groupId);
      await vi.waitFor(async () => {
        await access(marker);
      });
      child.kill("SIGTERM");
      await closed;
      expect(() => process.kill(groupId, 0)).toThrow();
      expect(() => process.kill(-groupId, 0)).not.toThrow();
      const interrupted = await harness.experimental_call("promoteBranch", {
        action: "inspect",
        intent,
      });
      expect(interrupted).toMatchObject({
        phase: "uncertain",
        branchName: "feature",
        commandTerminated: false,
      });
      expect(
        await harness.experimental_call("promoteBranch", {
          action: "resolve",
          intent,
          observation: interrupted.observation,
          resolution: "accept-current",
        }),
      ).toMatchObject({ phase: "uncertain", commandTerminated: false });
      await writeFile(gate, "release");
      await vi.waitFor(() => {
        expect(() => process.kill(-groupId, 0)).toThrow();
      });
      expect(
        await harness.experimental_call("promoteBranch", {
          action: "inspect",
          intent,
        }),
      ).toMatchObject({
        phase: "uncertain",
        branchName: "main",
        commandTerminated: true,
      });
    } finally {
      await writeFile(gate, "release");
      await closed;
      await harness.experimental_dispose();
    }
  });
});
