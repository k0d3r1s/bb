import {
  permissionModeSchema,
  promptTextMentionSchema,
  reasoningLevelSchema,
  serviceTierSchema,
  type PermissionMode,
  type PromptTextMention,
  type ReasoningLevel,
  type ServiceTier,
} from "@bb/domain";
import { uploadedPromptAttachmentSchema } from "@bb/server-contract";
import { z } from "zod";
import type { AppCreateThreadRequest } from "../api-types.js";
import {
  isPromptDraftEmpty,
  promptDraftToInput,
  type PromptDraftState,
} from "./prompt-draft.js";

export const THREAD_HANDOFF_COMPOSE_SEED_LOCATION_STATE_KEY =
  "threadHandoffComposeSeed";

export interface ThreadHandoffCreateSeed {
  environmentId: string | null;
  projectId: string;
  sourceThreadId: string;
  sourceThreadTitle: string;
}

export function buildThreadHandoffPromptDraft(
  seed: ThreadHandoffCreateSeed,
): PromptDraftState {
  const prefix = "Continue from ";
  const mentionText = `@thread:${seed.sourceThreadId}`;
  const text = `${prefix}${mentionText}`;
  const mention: PromptTextMention = {
    start: prefix.length,
    end: prefix.length + mentionText.length,
    resource: {
      kind: "thread",
      projectId: seed.projectId,
      threadId: seed.sourceThreadId,
      label: seed.sourceThreadTitle,
    },
  };

  return { text, mentions: [mention], attachments: [] };
}

const THREAD_HANDOFF_FOLLOW_UP_SEPARATOR = "\n\n";

export interface ThreadHandoffExecutionSelection {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  serviceTier: ServiceTier | undefined;
  supportsServiceTier: boolean;
  permissionMode: PermissionMode;
}

interface BuildThreadHandoffCreateRequestArgs {
  draft: PromptDraftState;
  execution: ThreadHandoffExecutionSelection;
  seed: ThreadHandoffCreateSeed;
  sendAt?: number;
}

function threadHandoffPrefixLength(
  seed: ThreadHandoffCreateSeed,
  draft: PromptDraftState,
): number | null {
  const handoff = buildThreadHandoffPromptDraft(seed);
  const [handoffMention] = handoff.mentions;
  const hasHandoffMention =
    handoffMention !== undefined &&
    draft.mentions.some(
      (mention) =>
        mention.start === handoffMention.start &&
        mention.end === handoffMention.end &&
        mention.resource.kind === "thread" &&
        mention.resource.threadId === seed.sourceThreadId,
    );
  if (!hasHandoffMention || !draft.text.startsWith(handoff.text)) {
    return null;
  }
  let prefixLength = handoff.text.length;
  if (prefixLength < draft.text.length && draft.text[prefixLength] !== "\n") {
    return null;
  }
  while (draft.text[prefixLength] === "\n") {
    prefixLength += 1;
  }
  return prefixLength;
}

export function buildThreadHandoffFollowUpDraft(
  seed: ThreadHandoffCreateSeed,
  draft: PromptDraftState,
): PromptDraftState {
  if (threadHandoffPrefixLength(seed, draft) !== null) {
    return draft;
  }
  return joinPromptDrafts(buildThreadHandoffPromptDraft(seed), draft);
}

function joinPromptDrafts(
  head: PromptDraftState,
  tail: PromptDraftState,
): PromptDraftState {
  const offset = head.text.length + THREAD_HANDOFF_FOLLOW_UP_SEPARATOR.length;
  return {
    text: `${head.text}${THREAD_HANDOFF_FOLLOW_UP_SEPARATOR}${tail.text}`,
    mentions: [
      ...head.mentions,
      ...tail.mentions.map((mention) => ({
        ...mention,
        start: mention.start + offset,
        end: mention.end + offset,
      })),
    ],
    attachments: [...head.attachments, ...tail.attachments],
  };
}

export function mergeThreadHandoffComposeDraft(
  handoffDraft: PromptDraftState,
  existingDraft: PromptDraftState,
): PromptDraftState {
  return isPromptDraftEmpty(existingDraft)
    ? handoffDraft
    : joinPromptDrafts(handoffDraft, existingDraft);
}

export function stripThreadHandoffPrefix(
  seed: ThreadHandoffCreateSeed,
  draft: PromptDraftState,
): PromptDraftState | null {
  const prefixLength = threadHandoffPrefixLength(seed, draft);
  if (prefixLength === null) {
    return null;
  }
  return {
    text: draft.text.slice(prefixLength),
    mentions: draft.mentions
      .filter((mention) => mention.start >= prefixLength)
      .map((mention) => ({
        ...mention,
        start: mention.start - prefixLength,
        end: mention.end - prefixLength,
      })),
    attachments: draft.attachments,
  };
}

export function buildThreadHandoffCreateRequest({
  draft,
  execution,
  seed,
  sendAt,
}: BuildThreadHandoffCreateRequestArgs): AppCreateThreadRequest | null {
  const input = promptDraftToInput(draft);
  if (execution.model.length === 0 || input.length === 0) {
    return null;
  }

  return {
    environment:
      seed.environmentId === null
        ? { type: "project-default" }
        : { type: "reuse", environmentId: seed.environmentId },
    executionInputSources: {
      providerId: "explicit",
      model: "explicit",
      reasoningLevel: "explicit",
      permissionMode: "explicit",
      ...(execution.supportsServiceTier && execution.serviceTier
        ? { serviceTier: "explicit" as const }
        : {}),
    },
    input,
    model: execution.model,
    permissionMode: execution.permissionMode,
    projectId: seed.projectId,
    providerId: execution.providerId,
    reasoningLevel: execution.reasoningLevel,
    ...(execution.supportsServiceTier && execution.serviceTier
      ? { serviceTier: execution.serviceTier }
      : {}),
    ...(sendAt === undefined ? {} : { sendAt }),
    startedOnBehalfOf: null,
  };
}

export interface ThreadHandoffComposeSeed {
  draft: PromptDraftState;
  environmentId: string | null;
  model: string;
  permissionMode: PermissionMode;
  projectId: string;
  providerId: string;
  reasoningLevel: ReasoningLevel;
  serviceTier: ServiceTier | undefined;
  sourceThreadId: string;
  sourceThreadTitle: string;
}

const nonEmptyStringSchema = z.string().min(1);

const threadHandoffComposeSeedSchema = z.object({
  draft: z.object({
    text: nonEmptyStringSchema,
    mentions: z.array(promptTextMentionSchema),
    attachments: z.array(uploadedPromptAttachmentSchema),
  }),
  environmentId: nonEmptyStringSchema.nullable(),
  model: nonEmptyStringSchema,
  permissionMode: permissionModeSchema,
  projectId: nonEmptyStringSchema,
  providerId: nonEmptyStringSchema,
  reasoningLevel: reasoningLevelSchema,
  serviceTier: serviceTierSchema.optional(),
  sourceThreadId: nonEmptyStringSchema,
  sourceThreadTitle: z.string().trim().min(1),
});

export function readThreadHandoffComposeSeedFromLocationState(
  state: unknown,
): ThreadHandoffComposeSeed | null {
  if (!state || typeof state !== "object") return null;
  const candidate = (state as Record<string, unknown>)[
    THREAD_HANDOFF_COMPOSE_SEED_LOCATION_STATE_KEY
  ];
  const result = threadHandoffComposeSeedSchema.safeParse(candidate);
  if (!result.success) return null;
  const { serviceTier, ...seed } = result.data;
  return { ...seed, serviceTier };
}
