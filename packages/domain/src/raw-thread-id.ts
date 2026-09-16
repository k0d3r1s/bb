import { z } from "zod";
import type { PromptTextMention } from "./shared-types.js";

export const GENERATED_ID_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";

export const GENERATED_ID_SUFFIX_LENGTH = 10;

const THREAD_ID_PREFIX = "thr_";

export const RAW_THREAD_ID_PATTERN_SOURCE = `${THREAD_ID_PREFIX}[${GENERATED_ID_ALPHABET}]{${GENERATED_ID_SUFFIX_LENGTH}}`;

const rawThreadIdPattern = new RegExp(`^${RAW_THREAD_ID_PATTERN_SOURCE}$`, "u");

const serializedThreadMentionPattern = new RegExp(
  `@thread:(${RAW_THREAD_ID_PATTERN_SOURCE})(?![\\p{L}\\p{N}_.+\\/-])`,
  "gu",
);

export const rawThreadIdSchema = z.string().regex(rawThreadIdPattern);
type RawThreadId = z.infer<typeof rawThreadIdSchema>;

export function isRawThreadId(value: string): value is RawThreadId {
  return rawThreadIdPattern.test(value);
}

export function parseSerializedThreadMentions(
  text: string,
): PromptTextMention[] {
  const mentions: PromptTextMention[] = [];
  for (const match of text.matchAll(serializedThreadMentionPattern)) {
    const previous = text[match.index - 1];
    if (previous !== undefined && /[\p{L}\p{N}_.+-]/u.test(previous)) {
      continue;
    }
    const threadId = match[1]!;
    mentions.push({
      start: match.index,
      end: match.index + match[0].length,
      resource: { kind: "thread", threadId, label: threadId },
    });
  }
  return mentions;
}
