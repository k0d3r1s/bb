import { describe, expect, it } from "vitest";
import type { PromptInput } from "@bb/domain";
import {
  createConnection,
  createProject,
  createThread,
  markProjectDeleted,
  markThreadDeleted,
  migrate,
  noopNotifier,
  upsertThreadSearchSegments,
  upsertHost,
} from "@bb/db";
import {
  THREAD_MENTION_CONTEXT_MAX_CHARS,
  THREAD_MENTION_MAX_REFERENCES,
  THREAD_MENTION_SEGMENT_MAX_CHARS,
  THREAD_MENTION_TRANSCRIPT_MAX_CHARS,
  resolveThreadMentionContextInputs,
} from "../../src/services/threads/thread-mentions.js";

function createHarness() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    type: "persistent",
    name: "test-host",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/source" },
  });
  return { db, host, project };
}

function threadMentionInput(threadId: string, label: string): PromptInput[] {
  const prefix = "Continue from ";
  const mentionText = `@thread:${threadId}`;
  return [
    {
      type: "text",
      text: `${prefix}${mentionText}`,
      mentions: [
        {
          start: prefix.length,
          end: prefix.length + mentionText.length,
          resource: { kind: "thread", threadId, label },
        },
      ],
    },
  ];
}

describe("resolveThreadMentionContextInputs", () => {
  it("expands a thread mention into agent-only transcript context", () => {
    const { db, project } = createHarness();
    const source = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      title: "Fully implement issue #32",
    });
    upsertThreadSearchSegments(db, {
      segments: [
        {
          threadId: source.id,
          sourceKind: "user_message",
          sourceKey: "1",
          sourceSeq: 1,
          text: "see #32, need to create this",
        },
        {
          threadId: source.id,
          sourceKind: "assistant_message",
          sourceKey: "2",
          sourceSeq: 2,
          text: "Added the parser and wired it up.",
        },
      ],
    });

    const [context, ...rest] = resolveThreadMentionContextInputs(db, {
      input: threadMentionInput(source.id, "Fully implement issue #32"),
    });

    expect(rest).toHaveLength(0);
    expect(context).toBeDefined();
    expect(context!.type).toBe("text");
    const text = (context as Extract<PromptInput, { type: "text" }>).text;
    expect(text).toContain("Fully implement issue #32");
    expect(text).toContain("User: see #32, need to create this");
    expect(text).toContain("Assistant: Added the parser and wired it up.");
    expect(text.indexOf("User: see #32")).toBeLessThan(
      text.indexOf("Assistant: Added"),
    );
    expect((context as Extract<PromptInput, { type: "text" }>).visibility).toBe(
      "agent-only",
    );
  });

  it("returns nothing when there is no thread mention", () => {
    const { db } = createHarness();
    expect(
      resolveThreadMentionContextInputs(db, {
        input: [{ type: "text", text: "just do the thing", mentions: [] }],
      }),
    ).toEqual([]);
  });

  it("expands a plain-text mention without structured mention metadata", () => {
    const { db, project } = createHarness();
    const source = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      title: "Plain text source",
    });
    upsertThreadSearchSegments(db, {
      segments: [
        {
          threadId: source.id,
          sourceKind: "assistant_message",
          sourceKey: "1",
          sourceSeq: 1,
          text: "Recovered from an SDK prompt.",
        },
      ],
    });

    const [context] = resolveThreadMentionContextInputs(db, {
      input: [
        {
          type: "text",
          text: `Continue from @thread:${source.id}`,
          mentions: [],
        },
      ],
    });

    expect(context).toMatchObject({
      type: "text",
      visibility: "agent-only",
    });
    expect((context as Extract<PromptInput, { type: "text" }>).text).toContain(
      "Recovered from an SDK prompt.",
    );
  });

  it("skips a self-mention so a thread does not inline its own transcript", () => {
    const { db, project } = createHarness();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      title: "Self",
    });
    upsertThreadSearchSegments(db, {
      segments: [
        {
          threadId: thread.id,
          sourceKind: "user_message",
          sourceKey: "1",
          sourceSeq: 1,
          text: "earlier turn",
        },
      ],
    });

    expect(
      resolveThreadMentionContextInputs(db, {
        input: threadMentionInput(thread.id, "Self"),
        currentThreadId: thread.id,
      }),
    ).toEqual([]);
  });

  it("deduplicates repeated mentions of the same thread", () => {
    const { db, project } = createHarness();
    const source = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      title: "Source",
    });
    upsertThreadSearchSegments(db, {
      segments: [
        {
          threadId: source.id,
          sourceKind: "user_message",
          sourceKey: "1",
          sourceSeq: 1,
          text: "hello",
        },
      ],
    });
    const input = [
      ...threadMentionInput(source.id, "Source"),
      ...threadMentionInput(source.id, "Source"),
    ];

    expect(resolveThreadMentionContextInputs(db, { input })).toHaveLength(1);
  });

  it("ignores a mention of a thread that no longer exists", () => {
    const { db } = createHarness();
    expect(
      resolveThreadMentionContextInputs(db, {
        input: threadMentionInput("thr_missing", "Gone"),
      }),
    ).toEqual([]);
  });

  it("ignores mentions of deleted threads and threads in deleted projects", () => {
    const { db, host, project } = createHarness();
    const deletedThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      title: "Deleted thread",
    });
    markThreadDeleted(db, noopNotifier, { threadId: deletedThread.id });

    const { project: deletedProject } = createProject(db, noopNotifier, {
      name: "deleted-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/deleted-source",
      },
    });
    const projectThread = createThread(db, noopNotifier, {
      projectId: deletedProject.id,
      providerId: "codex",
      title: "Deleted project thread",
    });
    markProjectDeleted(db, noopNotifier, { projectId: deletedProject.id });

    expect(
      resolveThreadMentionContextInputs(db, {
        input: [
          ...threadMentionInput(deletedThread.id, "Deleted thread"),
          ...threadMentionInput(projectThread.id, "Deleted project thread"),
        ],
      }),
    ).toEqual([]);
  });

  it("keeps the newest turns and caps the rendered transcript", () => {
    const { db, project } = createHarness();
    const source = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      title: "Long",
    });
    upsertThreadSearchSegments(db, {
      segments: Array.from({ length: 30 }, (_, index) => ({
        threadId: source.id,
        sourceKind: "assistant_message" as const,
        sourceKey: String(index),
        sourceSeq: index,
        text: `${index}-${"x".repeat(1500)}`,
      })),
    });

    const [context] = resolveThreadMentionContextInputs(db, {
      input: threadMentionInput(source.id, "Long"),
    });
    const text = (context as Extract<PromptInput, { type: "text" }>).text;

    expect(text.length).toBeLessThan(THREAD_MENTION_TRANSCRIPT_MAX_CHARS * 2);
    expect(text).toContain("29-");
    expect(text).not.toContain("0-xxx");
  });

  it("does not split surrogate pairs when truncating transcript text", () => {
    const { db, project } = createHarness();
    const source = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      title: "Emoji",
    });
    upsertThreadSearchSegments(db, {
      segments: [
        {
          threadId: source.id,
          sourceKind: "assistant_message",
          sourceKey: "emoji",
          sourceSeq: 1,
          text: "😀".repeat(THREAD_MENTION_SEGMENT_MAX_CHARS),
        },
      ],
    });

    const [context] = resolveThreadMentionContextInputs(db, {
      input: threadMentionInput(source.id, "Emoji"),
    });
    const text = (context as Extract<PromptInput, { type: "text" }>).text;

    expect(/[\uD800-\uDFFF]/u.test(text)).toBe(false);
  });

  it("reports a thread that has no recorded conversation", () => {
    const { db, project } = createHarness();
    const source = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      title: "Empty",
    });

    const [context] = resolveThreadMentionContextInputs(db, {
      input: threadMentionInput(source.id, "Empty"),
    });
    const text = (context as Extract<PromptInput, { type: "text" }>).text;

    expect(text).toContain("no recorded conversation yet");
  });

  it("bounds the number and total size of referenced thread contexts", () => {
    const { db, project } = createHarness();
    const sources = Array.from(
      { length: THREAD_MENTION_MAX_REFERENCES + 2 },
      (_, index) => {
        const source = createThread(db, noopNotifier, {
          projectId: project.id,
          providerId: "codex",
          title: `Source ${index}`,
        });
        upsertThreadSearchSegments(db, {
          segments: [
            {
              threadId: source.id,
              sourceKind: "assistant_message",
              sourceKey: String(index),
              sourceSeq: index,
              text: `${index}-${"x".repeat(THREAD_MENTION_TRANSCRIPT_MAX_CHARS)}`,
            },
          ],
        });
        return source;
      },
    );

    const context = resolveThreadMentionContextInputs(db, {
      input: sources.flatMap((source) =>
        threadMentionInput(source.id, source.title ?? source.id),
      ),
    });

    expect(context.length).toBeLessThanOrEqual(THREAD_MENTION_MAX_REFERENCES);
    expect(
      context.reduce(
        (total, item) => total + (item.type === "text" ? item.text.length : 0),
        0,
      ),
    ).toBeLessThanOrEqual(THREAD_MENTION_CONTEXT_MAX_CHARS);
  });
});
