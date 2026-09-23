import { describe, expect, it, vi } from "vitest";
import * as domain from "@bb/domain";
import type * as serverContract from "@bb/server-contract";
import {
  setupCommandOutputTestEnvironment,
  collectLogLines,
  createClientMock,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import * as fixtures from "../helpers/command-output-fixtures.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

describe("bb thread show command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  function jsonResponse(status: number, body: object): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function stubThreadShowApi(
    handlers: Parameters<typeof stubServerApi>[0],
  ): void {
    stubServerApi({
      "v1.threads.:id.execution-profile.$get": async () =>
        jsonResponse(404, { code: "not_found", message: "Not found" }),
      ...handlers,
    });
  }

  function makePullRequest(
    overrides: Partial<domain.ThreadPullRequest> = {},
  ): domain.ThreadPullRequest {
    return {
      number: 42,
      title: "Review thread show",
      state: "open",
      url: "https://github.com/example/bb/pull/42",
      baseRefName: "main",
      headRefName: "bb/thread-show-pr",
      updatedAt: "2026-06-24T12:00:00.000Z",
      checks: {
        state: "passing",
        totalCount: 3,
        passedCount: 3,
        failedCount: 0,
        pendingCount: 0,
      },
      review: {
        state: "review_required",
        reviewRequestCount: 1,
      },
      mergeability: {
        state: "mergeable",
        mergeStateStatus: "CLEAN",
        mergeable: "MERGEABLE",
      },
      attention: "ready_to_merge",
      ...overrides,
    };
  }

  it("bb thread show prints archived timestamp for archived threads", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      promotionTarget: "branch",
      worktreePromotion: "armed",
      id: "thread-archived-1",
      projectId: "proj-1",
      providerId: "codex",
      status: "idle",
      archivedAt: 1_700_000_000_000,
      createdAt: 1,
      updatedAt: 2,
    });
    const get = vi.fn(async () => thread);
    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubThreadShowApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(["thread", "show", "thread-archived-1"], register);

    expect(get).toHaveBeenCalledWith({
      param: { id: "thread-archived-1" },
    });
    expect(timelineGet).toHaveBeenCalledWith({
      param: { id: "thread-archived-1" },
      query: { summaryOnly: "true" },
    });
    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines.some((line) => line.includes("Archived:"))).toBe(true);
    expect(lines).toContain("  Promotion target: branch");
    expect(lines).toContain("  Promotion state: armed");
  });

  it("bb thread show prints pinned timestamp for pinned threads", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-pinned-1",
      projectId: "proj-1",
      providerId: "codex",
      status: "idle",
      pinnedAt: 1_700_000_000_000,
      createdAt: 1,
      updatedAt: 2,
    });
    const get = vi.fn(async () => thread);
    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubThreadShowApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(["thread", "show", "thread-pinned-1"], register);

    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines.some((line) => line.includes("Pinned:"))).toBe(true);
  });

  it("bb thread show --self resolves from BB_THREAD_ID", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-show-self");
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-show-self",
      projectId: "proj-1",
      providerId: "codex",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    const get = vi.fn(async () => thread);
    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubThreadShowApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(["thread", "show", "--self"], register);

    expect(get).toHaveBeenCalledWith({
      param: { id: "thread-show-self" },
    });
    expect(collectLogLines(vi.mocked(console.error))).toEqual([]);
  });

  it("bb thread show --work-status prints non-git environment message", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-show-work-status",
      projectId: "proj-1",
      providerId: "codex",
      environmentId: "env-work-status",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    const environment = fixtures.makeEnvironment({
      id: "env-work-status",
      projectId: "proj-1",
      hostId: "host-1",
      isGitRepo: false,
      createdAt: 1,
      updatedAt: 2,
    });
    const get = vi.fn(async () => thread);
    const environmentGet = vi.fn(async () => environment);
    const statusGet = vi.fn(async () => ({
      outcome: "not_applicable",
      reason: "non_git_environment",
      message: "Workspace is not a Git repository.",
    }));
    const pullRequestGet = vi.fn(async () => ({ outcome: "absent" }));
    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubThreadShowApi({
      "v1.environments.:id.$get": environmentGet,
      "v1.environments.:id.pull-request.$get": pullRequestGet,
      "v1.environments.:id.status.$get": statusGet,
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(
      ["thread", "show", "thread-show-work-status", "--work-status"],
      register,
    );

    expect(statusGet).toHaveBeenCalledWith({
      param: { id: "env-work-status" },
      query: { mergeBaseBranch: "main" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Work status: Workspace is not a Git repository.",
    );
  });

  it("bb thread show rejects combining a thread id with --self", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-show-self");

    await expect(
      runCommand(["thread", "show", "thread-explicit", "--self"], register),
    ).rejects.toThrow("process.exit:1");

    expect(collectLogLines(vi.mocked(console.error))).toContain(
      "Error: Cannot combine a thread ID argument with --self.",
    );
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("bb thread show --git-diff uses the environment base branch before the repository default", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-show-diff-base",
      projectId: "proj-1",
      providerId: "codex",
      environmentId: "env-diff-base",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    const environment = fixtures.makeEnvironment({
      id: "env-diff-base",
      projectId: "proj-1",
      hostId: "host-1",
      baseBranch: "release",
      defaultBranch: "main",
      mergeBaseBranch: null,
      createdAt: 1,
      updatedAt: 2,
    });
    const gitDiff: domain.ThreadGitDiffResponse = {
      diff: "",
      files: "M\tsrc/file.ts\n",
      mergeBaseRef: "abc1234",
      shortstat: " 1 file changed, 1 insertion(+)",
      truncated: false,
    };
    const get = vi.fn(async () => thread);
    const environmentGet = vi.fn(async () => environment);
    const diffResponse: serverContract.EnvironmentDiffResponse = {
      outcome: "available",
      diff: gitDiff,
    };
    const diffGet = vi.fn(async () => diffResponse);
    const pullRequestGet = vi.fn(async () => ({ outcome: "absent" }));
    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubThreadShowApi({
      "v1.environments.:id.$get": environmentGet,
      "v1.environments.:id.diff.$get": diffGet,
      "v1.environments.:id.pull-request.$get": pullRequestGet,
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(
      ["thread", "show", "thread-show-diff-base", "--git-diff"],
      register,
    );

    expect(diffGet).toHaveBeenCalledWith({
      param: { id: "env-diff-base" },
      query: {
        mergeBaseBranch: "release",
        target: "all",
      },
    });
  });

  it("bb thread show --git-diff renders an available uncommitted diff response", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-show-uncommitted-diff",
      projectId: "proj-1",
      providerId: "codex",
      environmentId: "env-uncommitted-diff",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    const environment = fixtures.makeEnvironment({
      id: "env-uncommitted-diff",
      projectId: "proj-1",
      hostId: "host-1",
      createdAt: 1,
      updatedAt: 2,
    });
    const diffResponse: serverContract.EnvironmentDiffResponse = {
      outcome: "available",
      diff: {
        diff: "diff --git a/smoke.txt b/smoke.txt\nnew file mode 100644\n",
        files: "A\tsmoke.txt\n",
        mergeBaseRef: null,
        shortstat: "1 file changed\n",
        truncated: false,
      },
    };
    const get = vi.fn(async () => thread);
    const environmentGet = vi.fn(async () => environment);
    const diffGet = vi.fn(async () => diffResponse);
    const pullRequestGet = vi.fn(async () => ({ outcome: "absent" }));
    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubThreadShowApi({
      "v1.environments.:id.$get": environmentGet,
      "v1.environments.:id.diff.$get": diffGet,
      "v1.environments.:id.pull-request.$get": pullRequestGet,
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(
      [
        "thread",
        "show",
        "thread-show-uncommitted-diff",
        "--git-diff",
        "--diff-target",
        "uncommitted",
      ],
      register,
    );

    expect(diffGet).toHaveBeenCalledWith({
      param: { id: "env-uncommitted-diff" },
      query: {
        target: "uncommitted",
      },
    });
    const output = collectLogLines(vi.mocked(console.log)).join("\n");
    expect(output).toContain("Git diff:");
    expect(output).toContain("A\tsmoke.txt");
    expect(output).toContain("Summary: 1 file changed");
    expect(output).toContain("diff --git a/smoke.txt b/smoke.txt");
  });

  it("bb thread show prints pull request details for the thread environment", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-show-pr",
      projectId: "proj-1",
      providerId: "codex",
      environmentId: "env-show-pr",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    const environment = fixtures.makeEnvironment({
      id: "env-show-pr",
      projectId: "proj-1",
      hostId: "host-1",
      branchName: "bb/thread-show-pr",
      createdAt: 1,
      updatedAt: 2,
    });
    const pullRequest = makePullRequest({
      title: "Show pull requests in thread show",
      attention: "ready_to_merge",
    });
    const get = vi.fn(async () => thread);
    const environmentGet = vi.fn(async () => environment);
    const pullRequestGet = vi.fn(async () => ({
      outcome: "available",
      pullRequest,
    }));
    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubThreadShowApi({
      "v1.environments.:id.$get": environmentGet,
      "v1.environments.:id.pull-request.$get": pullRequestGet,
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(["thread", "show", "thread-show-pr"], register);

    expect(pullRequestGet).toHaveBeenCalledWith({
      param: { id: "env-show-pr" },
    });
    const output = collectLogLines(vi.mocked(console.log)).join("\n");
    expect(output.indexOf("Environment:")).toBeLessThan(
      output.indexOf("Pull request:"),
    );
    expect(output).toContain(
      "Pull request: #42 open - Show pull requests in thread show",
    );
    expect(output).toContain("#42 open - Show pull requests in thread show");
    expect(output).toContain("https://github.com/example/bb/pull/42");
    expect(output).toContain("Branch:       bb/thread-show-pr -> main");
    expect(output).toContain(
      "Checks:       passing (3 passed, 0 failed, 0 pending, 3 total)",
    );
    expect(output).toContain("Review:       review_required (1 requested)");
    expect(output).toContain("Merge:        mergeable");
  });

  it("bb thread show reports a failed pull request lookup distinctly from none", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-show-pr-down",
      projectId: "proj-1",
      providerId: "codex",
      environmentId: "env-show-pr-down",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    const environment = fixtures.makeEnvironment({
      id: "env-show-pr-down",
      projectId: "proj-1",
      hostId: "host-1",
      createdAt: 1,
      updatedAt: 2,
    });
    const get = vi.fn(async () => thread);
    const environmentGet = vi.fn(async () => environment);
    const pullRequestGet = vi.fn(async () => ({
      outcome: "unavailable",
      message: "gh pr view failed: authentication required",
    }));
    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubThreadShowApi({
      "v1.environments.:id.$get": environmentGet,
      "v1.environments.:id.pull-request.$get": pullRequestGet,
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(["thread", "show", "thread-show-pr-down"], register);

    const output = collectLogLines(vi.mocked(console.log)).join("\n");
    expect(output).toContain("Pull request: unavailable");
    expect(output).toContain("gh pr view failed: authentication required");
    expect(output).not.toContain("Pull request: none");
  });

  it("bb thread show --json includes pull request details", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-json-show-pr",
      projectId: "proj-1",
      providerId: "codex",
      environmentId: "env-json-show-pr",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    const environment = fixtures.makeEnvironment({
      id: "env-json-show-pr",
      projectId: "proj-1",
      hostId: "host-1",
      createdAt: 1,
      updatedAt: 2,
    });
    const pullRequest = makePullRequest();
    const get = vi.fn(async () => thread);
    const environmentGet = vi.fn(async () => environment);
    const pullRequestGet = vi.fn(async () => ({
      outcome: "available",
      pullRequest,
    }));
    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubThreadShowApi({
      "v1.environments.:id.$get": environmentGet,
      "v1.environments.:id.pull-request.$get": pullRequestGet,
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(
      ["thread", "show", "thread-json-show-pr", "--json"],
      register,
    );

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual({
      thread,
      environment: {
        ...environment,
        pullRequest: {
          status: "available",
          pullRequest,
        },
      },
      pendingTodos: null,
      execution: null,
    });
  });

  it("bb thread show --json prints the thread in status payload format", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-json-show",
      projectId: "proj-1",
      providerId: "codex",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    const get = vi.fn(async () => thread);
    const timelineGet = fixtures.makeEmptyTimelineGetMock();
    stubThreadShowApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.timeline.$get": timelineGet,
    });

    await runCommand(
      ["thread", "show", "thread-json-show", "--json"],
      register,
    );

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual({
      thread,
      environment: null,
      pendingTodos: null,
      execution: null,
    });
  });

  it("bb thread show prints the execution profile with the time the provider reported it", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-show-execution",
      projectId: "proj-1",
      providerId: "codex",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    const reportedAt = 1_760_000_000_000;
    const executionProfile = vi.fn(async () => ({
      lastRequested: null,
      overrides: { model: null, reasoningLevel: null },
      nextTurn: null,
      executed: {
        model: "gpt-5.5-mini",
        reasoningLevel: "medium",
        permissionMode: "auto",
        serviceTier: "fast",
        reportedAt,
      },
    }));
    stubThreadShowApi({
      "v1.threads.:id.$get": vi.fn(async () => thread),
      "v1.threads.:id.timeline.$get": fixtures.makeEmptyTimelineGetMock(),
      "v1.threads.:id.execution-profile.$get": executionProfile,
    });

    await runCommand(["thread", "show", "thread-show-execution"], register);

    expect(executionProfile).toHaveBeenCalledWith({
      param: { id: "thread-show-execution" },
    });
    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines).toContain("  Execution:");
    expect(lines).toContain(
      "    Executed:       gpt-5.5-mini · medium · auto · fast",
    );
    expect(lines).toContain(
      `    Reported:       ${new Date(reportedAt).toLocaleString()}`,
    );
  });

  it("bb thread show omits the execution profile when an older server has no such route", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-show-old-server",
      projectId: "proj-1",
      providerId: "codex",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    stubThreadShowApi({
      "v1.threads.:id.$get": vi.fn(async () => thread),
      "v1.threads.:id.timeline.$get": fixtures.makeEmptyTimelineGetMock(),
    });

    await runCommand(["thread", "show", "thread-show-old-server"], register);

    expect(collectLogLines(vi.mocked(console.log))).not.toContain(
      "  Execution:",
    );
    expect(collectLogLines(vi.mocked(console.error))).toEqual([]);
  });

  it("bb thread show fails instead of hiding a server error from the execution profile", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-show-profile-error",
      projectId: "proj-1",
      providerId: "codex",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    stubThreadShowApi({
      "v1.threads.:id.$get": vi.fn(async () => thread),
      "v1.threads.:id.timeline.$get": fixtures.makeEmptyTimelineGetMock(),
      "v1.threads.:id.execution-profile.$get": async () =>
        jsonResponse(500, { code: "internal", message: "database locked" }),
    });

    await expect(
      runCommand(["thread", "show", "thread-show-profile-error"], register),
    ).rejects.toThrow("process.exit:1");

    expect(
      collectLogLines(vi.mocked(console.error)).some((line) =>
        line.includes("database locked"),
      ),
    ).toBe(true);
  });
});
