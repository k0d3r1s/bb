import { parseSerializedThreadMentions, type PromptInput } from "@bb/domain";
import { sliceUtf16HeadAndTail } from "@bb/domain/utf16";
import type { DbQueryConnection, ThreadTranscriptSegment } from "@bb/db";
import {
  listThreadMentionRowsByIds,
  listThreadTranscriptSegments,
} from "@bb/db";
import { collectPromptMentionResources } from "../prompt-mentions.js";

type ThreadMentionResource = Extract<
  Extract<PromptInput, { type: "text" }>["mentions"][number]["resource"],
  { kind: "thread" }
>;

export const THREAD_MENTION_SEGMENT_LIMIT = 40;
export const THREAD_MENTION_TRANSCRIPT_MAX_CHARS = 12000;
export const THREAD_MENTION_SEGMENT_MAX_CHARS = 2000;
export const THREAD_MENTION_CONTEXT_MAX_CHARS = 24000;
export const THREAD_MENTION_MAX_REFERENCES = 8;

const TRUNCATION_NOTICE = "[… truncated, use `bb thread log` for the full log]";

const SEGMENT_SPEAKER: Record<ThreadTranscriptSegment["sourceKind"], string> = {
  user_message: "User",
  assistant_message: "Assistant",
  system_message: "System",
};

function collectThreadMentionResources(
  input: readonly PromptInput[],
  excludeThreadId: string | null,
): ThreadMentionResource[] {
  const resources = collectPromptMentionResources(
    input,
    (resource): resource is ThreadMentionResource => resource.kind === "thread",
    (resource) =>
      resource.threadId === excludeThreadId ? null : resource.threadId,
  );
  const seen = new Set(resources.map((resource) => resource.threadId));
  for (const item of input) {
    if (item.type !== "text") continue;
    for (const mention of parseSerializedThreadMentions(item.text)) {
      if (mention.resource.kind !== "thread") continue;
      const resource = mention.resource;
      if (
        resource.threadId === excludeThreadId ||
        seen.has(resource.threadId)
      ) {
        continue;
      }
      seen.add(resource.threadId);
      resources.push(resource);
    }
  }
  return resources;
}

function truncateEnd(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATION_NOTICE.length) {
    return TRUNCATION_NOTICE.slice(0, maxChars);
  }
  const contentMaxChars = maxChars - TRUNCATION_NOTICE.length - 1;
  const { head } = sliceUtf16HeadAndTail(text, contentMaxChars, 0);
  return `${head.trimEnd()} ${TRUNCATION_NOTICE}`;
}

function renderTranscript(
  segments: readonly ThreadTranscriptSegment[],
): string {
  const rendered: string[] = [];
  let budget = THREAD_MENTION_TRANSCRIPT_MAX_CHARS;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    const body = truncateEnd(
      segment.text.trim(),
      THREAD_MENTION_SEGMENT_MAX_CHARS,
    );
    if (body.length === 0) continue;
    const line = `${SEGMENT_SPEAKER[segment.sourceKind]}: ${body}`;
    if (line.length > budget) {
      rendered.push(TRUNCATION_NOTICE);
      break;
    }
    budget -= line.length;
    rendered.push(line);
  }
  return rendered.reverse().join("\n\n");
}

export interface ResolveThreadMentionContextInputsArgs {
  input: readonly PromptInput[];
  currentThreadId?: string | null;
}

export function resolveThreadMentionContextInputs(
  db: DbQueryConnection,
  args: ResolveThreadMentionContextInputsArgs,
): PromptInput[] {
  const resources = collectThreadMentionResources(
    args.input,
    args.currentThreadId ?? null,
  ).slice(0, THREAD_MENTION_MAX_REFERENCES);
  if (resources.length === 0) return [];

  const threadsById = new Map(
    listThreadMentionRowsByIds(
      db,
      resources.map((resource) => resource.threadId),
    ).map((thread) => [thread.id, thread]),
  );
  const contextInputs: PromptInput[] = [];
  let remainingChars = THREAD_MENTION_CONTEXT_MAX_CHARS;
  for (const resource of resources) {
    const thread = threadsById.get(resource.threadId);
    if (!thread) continue;
    const segments = listThreadTranscriptSegments(db, {
      threadId: resource.threadId,
      limit: THREAD_MENTION_SEGMENT_LIMIT,
    });
    const transcript = renderTranscript(segments);
    const heading = `Context for @thread:${resource.threadId} ("${thread.title ?? resource.label}", status: ${thread.status})`;
    const body =
      transcript.length > 0
        ? transcript
        : "This thread has no recorded conversation yet.";
    const text = truncateEnd(`${heading}:\n\n${body}`, remainingChars);
    if (text.length === 0) break;
    contextInputs.push({
      type: "text",
      text,
      mentions: [],
      visibility: "agent-only",
    });
    remainingChars -= text.length;
    if (remainingChars === 0) break;
  }
  return contextInputs;
}
