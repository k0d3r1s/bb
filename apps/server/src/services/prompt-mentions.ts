import type { PromptInput } from "@bb/domain";

type PromptMentionResource = Extract<
  PromptInput,
  { type: "text" }
>["mentions"][number]["resource"];

export function collectPromptMentionResources<
  TResource extends PromptMentionResource,
>(
  input: readonly PromptInput[],
  matches: (resource: PromptMentionResource) => resource is TResource,
  keyFor: (resource: TResource) => string | null,
): TResource[] {
  const seen = new Set<string>();
  const resources: TResource[] = [];
  for (const item of input) {
    if (item.type !== "text") continue;
    for (const mention of item.mentions) {
      const resource = mention.resource;
      if (!matches(resource)) continue;
      const key = keyFor(resource);
      if (key === null || seen.has(key)) continue;
      seen.add(key);
      resources.push(resource);
    }
  }
  return resources;
}
