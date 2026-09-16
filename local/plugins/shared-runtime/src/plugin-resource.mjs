import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const pluginResourceLimits = Object.freeze({
  maxBytes: 256 * 1024,
  maxPathLength: 4096,
});

function deny(message) {
  throw new Error(`Shared runtime plugin resource denied: ${message}`);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function defaultRoots(homeRoot) {
  return [
    { path: path.join(homeRoot, ".codex", "skills"), skillSegmentRequired: false },
    { path: path.join(homeRoot, ".agents", "skills"), skillSegmentRequired: false },
    { path: path.join(homeRoot, ".codex", "plugins", "cache"), skillSegmentRequired: false },
    { path: path.join(homeRoot, ".agents", "plugins", "cache"), skillSegmentRequired: false },
    { path: path.join(homeRoot, ".claude", "plugins", "cache"), skillSegmentRequired: false },
    {
      path: path.join(homeRoot, ".bb", "runtime", "global-skills"),
      skillSegmentRequired: false,
    },
  ];
}

async function resolvedRoots(options) {
  const configured = options.allowedRoots
    ? options.allowedRoots.map((root) => ({ path: root, skillSegmentRequired: false }))
    : defaultRoots(options.homeRoot ?? homedir());
  const roots = [];
  for (const configuredRoot of configured) {
    try {
      const resolved = await realpath(configuredRoot.path);
      const rootStat = await stat(resolved);
      if (rootStat.isDirectory()) {
        roots.push({ ...configuredRoot, path: resolved });
      }
    } catch {
    }
  }
  return roots;
}

function rootAcceptsTarget(root, target) {
  if (!isInside(root.path, target)) return false;
  if (!root.skillSegmentRequired) return true;
  const segments = path.relative(root.path, target).split(path.sep);
  return segments.includes("skills");
}

async function findSkillRoot(target, allowedRoot) {
  let current = path.dirname(target);
  while (isInside(allowedRoot.path, current)) {
    const marker = path.join(current, "SKILL.md");
    try {
      const resolvedMarker = await realpath(marker);
      const markerStat = await stat(resolvedMarker);
      if (
        markerStat.isFile() &&
        markerStat.nlink === 1 &&
        isInside(current, resolvedMarker) &&
        rootAcceptsTarget(allowedRoot, resolvedMarker)
      ) {
        return current;
      }
    } catch {
    }
    if (current === allowedRoot.path) break;
    current = path.dirname(current);
  }
  return null;
}

export async function readPluginResource(input, options = {}) {
  const requestedPath = input?.path;
  if (
    typeof requestedPath !== "string" ||
    !path.isAbsolute(requestedPath) ||
    requestedPath.length > pluginResourceLimits.maxPathLength ||
    requestedPath.includes("\0")
  ) {
    deny("path must be one bounded absolute path");
  }

  let target;
  try {
    target = await realpath(requestedPath);
  } catch {
    deny("resource does not exist");
  }

  const roots = await resolvedRoots(options);
  const allowedRoot = roots.find((root) => rootAcceptsTarget(root, target));
  if (!allowedRoot) {
    deny("resource is outside installed agent skill roots");
  }

  const skillRoot = await findSkillRoot(target, allowedRoot);
  if (!skillRoot) {
    deny("resource is not anchored by an installed SKILL.md");
  }

  const targetStat = await stat(target);
  if (
    !targetStat.isFile() ||
    targetStat.nlink !== 1 ||
    targetStat.size > pluginResourceLimits.maxBytes
  ) {
    deny("resource must be a bounded regular file");
  }

  const bytes = await readFile(target);
  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    deny("resource is not valid UTF-8 text");
  }

  return Object.freeze({
    path: target,
    skillRoot,
    content,
  });
}
