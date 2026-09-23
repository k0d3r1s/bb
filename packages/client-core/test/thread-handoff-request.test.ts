import { describe, expect, it } from "vitest";
import {
  buildThreadHandoffCreateRequest,
  buildThreadHandoffFollowUpDraft,
  mergeThreadHandoffComposeDraft,
  readThreadHandoffComposeSeedFromLocationState,
  stripThreadHandoffPrefix,
  THREAD_HANDOFF_COMPOSE_SEED_LOCATION_STATE_KEY,
  type ThreadHandoffComposeSeed,
  type ThreadHandoffCreateSeed,
  type ThreadHandoffExecutionSelection,
} from "../src/prompt/thread-handoff-request.js";

const SEED: ThreadHandoffCreateSeed = {
  environmentId: "env_source",
  projectId: "proj_source",
  sourceThreadId: "thr_source",
  sourceThreadTitle: "Source thread",
};

const EXECUTION: ThreadHandoffExecutionSelection = {
  providerId: "claude-code",
  model: "claude-opus-5",
  reasoningLevel: "high",
  serviceTier: "fast",
  supportsServiceTier: true,
  permissionMode: "auto",
};

const SOURCE_MENTION = {
  start: 14,
  end: 32,
  resource: {
    kind: "thread" as const,
    projectId: "proj_source",
    threadId: "thr_source",
    label: "Source thread",
  },
};

describe("buildThreadHandoffFollowUpDraft", () => {
  it("keeps follow-up mentions anchored after the source thread mention", () => {
    const draft = buildThreadHandoffFollowUpDraft(SEED, {
      text: "Also see @thread:thr_other next",
      mentions: [
        {
          start: 9,
          end: 26,
          resource: {
            kind: "thread",
            projectId: "proj_source",
            threadId: "thr_other",
            label: "Other thread",
          },
        },
      ],
      attachments: [],
    });

    expect(draft.text).toBe(
      "Continue from @thread:thr_source\n\nAlso see @thread:thr_other next",
    );
    expect(draft.mentions).toHaveLength(2);
    expect(draft.mentions[0]).toEqual(SOURCE_MENTION);
    expect(
      draft.text.slice(draft.mentions[1]!.start, draft.mentions[1]!.end),
    ).toBe("@thread:thr_other");
  });

  it("leaves a draft alone when it already starts with the source reference", () => {
    const draft = {
      text: "Continue from @thread:thr_source\n\nKeep going",
      mentions: [SOURCE_MENTION],
      attachments: [],
    };

    expect(buildThreadHandoffFollowUpDraft(SEED, draft)).toBe(draft);
  });
});

describe("stripThreadHandoffPrefix", () => {
  it("removes the inserted reference and re-anchors later mentions", () => {
    expect(
      stripThreadHandoffPrefix(SEED, {
        text: "Continue from @thread:thr_source\n\nSee @thread:thr_other",
        mentions: [
          SOURCE_MENTION,
          {
            start: 38,
            end: 55,
            resource: {
              kind: "thread",
              projectId: "proj_source",
              threadId: "thr_other",
              label: "Other thread",
            },
          },
        ],
        attachments: [],
      }),
    ).toEqual({
      text: "See @thread:thr_other",
      mentions: [
        {
          start: 4,
          end: 21,
          resource: {
            kind: "thread",
            projectId: "proj_source",
            threadId: "thr_other",
            label: "Other thread",
          },
        },
      ],
      attachments: [],
    });
    expect(
      stripThreadHandoffPrefix(SEED, {
        text: "Continue from @thread:thr_source",
        mentions: [SOURCE_MENTION],
        attachments: [],
      }),
    ).toEqual({ text: "", mentions: [], attachments: [] });
  });

  it("tolerates the editor collapsing the blank line after the reference", () => {
    expect(
      stripThreadHandoffPrefix(SEED, {
        text: "Continue from @thread:thr_source\nKeep going\n",
        mentions: [SOURCE_MENTION],
        attachments: [],
      }),
    ).toEqual({ text: "Keep going\n", mentions: [], attachments: [] });
    expect(
      buildThreadHandoffFollowUpDraft(SEED, {
        text: "Continue from @thread:thr_source\nKeep going",
        mentions: [SOURCE_MENTION],
        attachments: [],
      }).text,
    ).toBe("Continue from @thread:thr_source\nKeep going");
  });

  it("returns null once the user has changed the reference", () => {
    expect(
      stripThreadHandoffPrefix(SEED, {
        text: "Continue from @thread:thr_source please",
        mentions: [SOURCE_MENTION],
        attachments: [],
      }),
    ).toBeNull();
    expect(
      stripThreadHandoffPrefix(SEED, {
        text: "Continue from @thread:thr_source\n\nKeep going",
        mentions: [],
        attachments: [],
      }),
    ).toBeNull();
  });
});

describe("buildThreadHandoffCreateRequest", () => {
  it("creates a thread on the selected provider from the draft as typed", () => {
    const request = buildThreadHandoffCreateRequest({
      draft: {
        text: "Continue from @thread:thr_source\n\nRefactor the tests",
        mentions: [SOURCE_MENTION],
        attachments: [],
      },
      execution: EXECUTION,
      seed: SEED,
    });

    expect(request).toEqual({
      environment: { type: "reuse", environmentId: "env_source" },
      executionInputSources: {
        providerId: "explicit",
        model: "explicit",
        reasoningLevel: "explicit",
        serviceTier: "explicit",
        permissionMode: "explicit",
      },
      input: [
        {
          type: "text",
          text: "Continue from @thread:thr_source\n\nRefactor the tests",
          mentions: [SOURCE_MENTION],
        },
      ],
      model: "claude-opus-5",
      permissionMode: "auto",
      projectId: "proj_source",
      providerId: "claude-code",
      reasoningLevel: "high",
      serviceTier: "fast",
      startedOnBehalfOf: null,
    });
  });

  it("falls back to the project default environment and drops unsupported service tiers", () => {
    const request = buildThreadHandoffCreateRequest({
      draft: { text: "Keep going", mentions: [], attachments: [] },
      execution: { ...EXECUTION, supportsServiceTier: false },
      seed: { ...SEED, environmentId: null },
      sendAt: 1_700_000_000_000,
    });

    expect(request?.environment).toEqual({ type: "project-default" });
    expect(request).not.toHaveProperty("serviceTier");
    expect(request?.executionInputSources).toEqual({
      providerId: "explicit",
      model: "explicit",
      reasoningLevel: "explicit",
      permissionMode: "explicit",
    });
    expect(request?.sendAt).toBe(1_700_000_000_000);
  });

  it("marks unchanged visible handoff execution as explicit", () => {
    const request = buildThreadHandoffCreateRequest({
      draft: { text: "Keep going", mentions: [], attachments: [] },
      execution: {
        ...EXECUTION,
        providerId: "codex",
        model: "gpt-5.6-sol",
        serviceTier: "default",
        permissionMode: "full",
      },
      seed: SEED,
    });

    expect(request?.executionInputSources).toEqual({
      providerId: "explicit",
      model: "explicit",
      reasoningLevel: "explicit",
      serviceTier: "explicit",
      permissionMode: "explicit",
    });
  });

  it("marks changed handoff execution as explicit", () => {
    const request = buildThreadHandoffCreateRequest({
      draft: { text: "Keep going", mentions: [], attachments: [] },
      execution: {
        ...EXECUTION,
        model: "claude-sonnet-5",
        reasoningLevel: "medium",
        permissionMode: "full",
      },
      seed: SEED,
    });

    expect(request?.executionInputSources).toEqual({
      providerId: "explicit",
      model: "explicit",
      reasoningLevel: "explicit",
      serviceTier: "explicit",
      permissionMode: "explicit",
    });
  });

  it("returns null without follow-up input or a resolved model", () => {
    expect(
      buildThreadHandoffCreateRequest({
        draft: { text: "   ", mentions: [], attachments: [] },
        execution: EXECUTION,
        seed: SEED,
      }),
    ).toBeNull();
    expect(
      buildThreadHandoffCreateRequest({
        draft: { text: "Keep going", mentions: [], attachments: [] },
        execution: { ...EXECUTION, model: "" },
        seed: SEED,
      }),
    ).toBeNull();
  });
});

describe("readThreadHandoffComposeSeedFromLocationState", () => {
  const COMPOSE_SEED: ThreadHandoffComposeSeed = {
    draft: {
      text: "Continue from @thread:thr_source",
      mentions: [SOURCE_MENTION],
      attachments: [],
    },
    environmentId: "env_source",
    model: "claude-opus-5",
    permissionMode: "auto",
    projectId: "proj_source",
    providerId: "claude-code",
    reasoningLevel: "high",
    serviceTier: "fast",
    sourceThreadId: "thr_source",
    sourceThreadTitle: "Source thread",
  };
  const stateWith = (seed: unknown) => ({
    focusPrompt: true,
    [THREAD_HANDOFF_COMPOSE_SEED_LOCATION_STATE_KEY]: seed,
  });

  it("round-trips a seed carried through location state", () => {
    expect(
      readThreadHandoffComposeSeedFromLocationState(stateWith(COMPOSE_SEED)),
    ).toEqual(COMPOSE_SEED);
  });

  it("accepts a source thread without an environment or service tier", () => {
    const { serviceTier: _serviceTier, ...withoutTier } = COMPOSE_SEED;
    expect(
      readThreadHandoffComposeSeedFromLocationState(
        stateWith({ ...withoutTier, environmentId: null }),
      ),
    ).toEqual({ ...COMPOSE_SEED, environmentId: null, serviceTier: undefined });
  });

  it.each([
    ["missing state", null],
    ["no seed", { focusPrompt: true }],
    [
      "an empty draft",
      stateWith({
        ...COMPOSE_SEED,
        draft: { text: "", mentions: [], attachments: [] },
      }),
    ],
    ["an empty model", stateWith({ ...COMPOSE_SEED, model: "" })],
    [
      "an unknown permission mode",
      stateWith({ ...COMPOSE_SEED, permissionMode: "yolo" }),
    ],
    [
      "a blank source title",
      stateWith({ ...COMPOSE_SEED, sourceThreadTitle: "  " }),
    ],
    [
      "a malformed mention",
      stateWith({
        ...COMPOSE_SEED,
        draft: { ...COMPOSE_SEED.draft, mentions: [{ start: 0 }] },
      }),
    ],
  ])("rejects %s", (_label, state) => {
    expect(readThreadHandoffComposeSeedFromLocationState(state)).toBeNull();
  });
});

describe("mergeThreadHandoffComposeDraft", () => {
  const handoffDraft = {
    text: "Continue from @thread:thr_source",
    mentions: [SOURCE_MENTION],
    attachments: [],
  };

  it("uses the handoff draft when the composer draft is empty", () => {
    expect(
      mergeThreadHandoffComposeDraft(handoffDraft, {
        text: "",
        mentions: [],
        attachments: [],
      }),
    ).toBe(handoffDraft);
  });

  it("keeps an unsent composer draft after the handoff, re-anchoring its mentions", () => {
    const existingMention = {
      start: 4,
      end: 21,
      resource: {
        kind: "thread" as const,
        projectId: "proj_other",
        threadId: "thr_other",
        label: "Other",
      },
    };
    const merged = mergeThreadHandoffComposeDraft(handoffDraft, {
      text: "See @thread:thr_other",
      mentions: [existingMention],
      attachments: [],
    });

    expect(merged.text).toBe(
      "Continue from @thread:thr_source\n\nSee @thread:thr_other",
    );
    const offset = handoffDraft.text.length + 2;
    expect(merged.mentions).toEqual([
      SOURCE_MENTION,
      { ...existingMention, start: 4 + offset, end: 21 + offset },
    ]);
    const shifted = merged.mentions[1]!;
    expect(merged.text.slice(shifted.start, shifted.end)).toBe(
      "@thread:thr_other",
    );
  });
});
