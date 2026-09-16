import type { PromptInput } from "@bb/domain";
import { ApiError } from "../../errors.js";
import { collectPromptMentionResources } from "../prompt-mentions.js";
import { resolvePluginMention } from "./plugin-agent-contributions.js";

type PluginMentionResource = Extract<
  Extract<PromptInput, { type: "text" }>["mentions"][number]["resource"],
  { kind: "plugin" }
>;

export async function resolvePluginMentionContextInputs(
  input: readonly PromptInput[],
): Promise<PromptInput[]> {
  const resources = collectPromptMentionResources(
    input,
    (resource): resource is PluginMentionResource => resource.kind === "plugin",
    (resource) => `${resource.pluginId}::${resource.itemId}`,
  );
  if (resources.length === 0) return [];
  const contextInputs: PromptInput[] = [];
  for (const resource of resources) {
    const result = await resolvePluginMention({
      pluginId: resource.pluginId,
      itemId: resource.itemId,
    });
    if (!result.ok) {
      throw new ApiError(
        422,
        "plugin_mention_resolve_failed",
        `Could not resolve @${resource.label} (plugin "${resource.pluginId}"): ${result.error}`,
      );
    }
    contextInputs.push({
      type: "text",
      text: `Context for @${resource.label} (resolved by plugin "${resource.pluginId}"):\n\n${result.context}`,
      mentions: [],
      visibility: "agent-only",
    });
    for (const image of result.images) {
      if (image.context?.trim()) {
        contextInputs.push({
          type: "text",
          text: image.context,
          mentions: [],
          visibility: "agent-only",
        });
      }
      contextInputs.push({
        ...(image.type === "image"
          ? { type: "image" as const, url: image.url }
          : { type: "localImage" as const, path: image.path }),
        visibility: "agent-only",
      });
    }
  }
  return contextInputs;
}
