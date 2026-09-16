import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

interface Scope {
  name: string;
  paths: string[];
  patterns: RegExp[];
  patternSources: string[];
}

interface SkillInfo {
  name: string;
  dir: string;
  scopes: string[];
}

const PROJECT_REFRESH_MS = 60_000;

function pluginRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(here) === "dist" ? path.dirname(here) : here;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

function normalizeDir(p: string): string {
  const absolute = path.resolve(expandHome(p));
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function loadScopes(root: string): Scope[] {
  const file = path.join(root, "scopes.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (
    !raw ||
    typeof raw !== "object" ||
    !Array.isArray((raw as { scopes?: unknown }).scopes)
  ) {
    throw new Error(`${file}: expected { "scopes": [...] }`);
  }
  const scopes: Scope[] = [];
  const entries = (raw as { scopes: unknown[] }).scopes;
  entries.forEach((entry, index) => {
    const e = entry as { name?: unknown; paths?: unknown; skills?: unknown };
    const name =
      typeof e.name === "string" && e.name.trim() !== ""
        ? e.name.trim()
        : `scope-${index + 1}`;
    if (
      !Array.isArray(e.paths) ||
      e.paths.length === 0 ||
      !e.paths.every((p) => typeof p === "string" && p.trim() !== "")
    ) {
      throw new Error(
        `${file}: scope "${name}" needs a non-empty "paths" array of strings`,
      );
    }
    if (
      !Array.isArray(e.skills) ||
      e.skills.length === 0 ||
      !e.skills.every((s) => typeof s === "string" && s.trim() !== "")
    ) {
      throw new Error(
        `${file}: scope "${name}" needs a non-empty "skills" array of name patterns`,
      );
    }
    const patternSources = (e.skills as string[]).map((s) => s.trim());
    scopes.push({
      name,
      paths: (e.paths as string[]).map(normalizeDir),
      patterns: patternSources.map(globToRegExp),
      patternSources,
    });
  });
  return scopes;
}

function frontmatterName(skillFile: string): string | null {
  const text = readFileSync(skillFile, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^name:\s*(.+?)\s*$/.exec(line);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return null;
}

function loadSkills(root: string, scopes: Scope[]): SkillInfo[] {
  const skillsRoot = path.join(root, "skills");
  const skills: SkillInfo[] = [];
  for (const entry of readdirSync(skillsRoot).sort()) {
    const dir = path.join(skillsRoot, entry);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    const skillFile = path.join(dir, "SKILL.md");
    let name: string | null = null;
    try {
      name = frontmatterName(skillFile) ?? entry;
    } catch {
      continue;
    }
    const owners = scopes
      .filter((scope) => scope.patterns.some((re) => re.test(name as string)))
      .map((s) => s.name);
    skills.push({ name, dir, scopes: owners });
  }
  return skills;
}

function selectSkills(
  skills: SkillInfo[],
  scopes: Scope[],
  candidatePaths: string[],
): string[] {
  const dirs = candidatePaths.map(normalizeDir);
  const active = new Set(
    scopes
      .filter((scope) =>
        scope.paths.some((root) => dirs.some((dir) => isWithin(root, dir))),
      )
      .map((s) => s.name),
  );
  return skills
    .filter(
      (skill) =>
        skill.scopes.length === 0 ||
        skill.scopes.some((name) => active.has(name)),
    )
    .map((skill) => skill.name);
}

export default async function plugin(bb: BbPluginApi) {
  const root = pluginRoot();
  const scopes = loadScopes(root);
  const skills = loadSkills(root, scopes);
  bb.log.info(
    `loaded ${skills.length} skill(s), ${scopes.length} scope(s): ` +
      scopes.map((s) => `${s.name} -> ${s.paths.join(", ")}`).join("; "),
  );
  for (const scope of scopes) {
    if (!skills.some((skill) => skill.scopes.includes(scope.name))) {
      bb.log.warn(
        `scope "${scope.name}" matches no skill under skills/ (patterns: ${scope.patternSources.join(", ")})`,
      );
    }
  }

  const projectPaths = new Map<string, string[]>();
  async function refreshProjects(): Promise<void> {
    try {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      const next = new Map<string, string[]>();
      for (const project of projects) {
        const sources = (project.sources ?? []) as Array<{
          path?: string | null;
        }>;
        const paths = sources
          .map((source) => source.path)
          .filter((p): p is string => typeof p === "string" && p !== "");
        next.set(project.id, paths);
      }
      projectPaths.clear();
      for (const [id, paths] of next) projectPaths.set(id, paths);
    } catch (error) {
      bb.log.warn(
        `project list refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  await refreshProjects();

  bb.background.service("project-path-cache", {
    async start(signal) {
      while (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, PROJECT_REFRESH_MS);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        if (!signal.aborted) await refreshProjects();
      }
    },
  });
  bb.events.on("thread.created", () => {
    void refreshProjects();
  });

  function candidatesFor(
    environmentPath: string | null,
    projectId: string | null,
  ): string[] {
    const out: string[] = [];
    if (environmentPath) out.push(environmentPath);
    if (projectId) out.push(...(projectPaths.get(projectId) ?? []));
    return out;
  }

  bb.agents.configure((context) => {
    const candidates = candidatesFor(
      context.environment.path,
      context.project.id,
    );
    const selected = selectSkills(skills, scopes, candidates);
    bb.log.debug(
      `configure thread=${context.thread.id} provider=${context.provider.id} env=${context.environment.path ?? "null"} ` +
        `project=${context.project.id} -> [${selected.join(", ")}]`,
    );
    return { tools: [], skills: selected };
  });

  bb.cli.register({
    name: "dir-skills",
    summary: "Show directory-scoped skills and which ones apply to a path",
    commands: [
      {
        name: "status",
        summary: "List scopes and skills with their scope",
        usage: "bb dir-skills status [--json]",
      },
      {
        name: "check",
        summary: "Show the skills a thread rooted at a path would receive",
        usage: "bb dir-skills check [<path>] [--project <project-id>] [--json]",
      },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const args = argv.filter((a) => a !== "--json");
      const command = args[0] ?? "status";
      if (command === "status") {
        const payload = {
          root,
          scopes: scopes.map((s) => ({
            name: s.name,
            paths: s.paths,
            skills: s.patternSources,
          })),
          skills: skills.map((s) => ({ name: s.name, scopes: s.scopes })),
        };
        if (json)
          return {
            exitCode: 0,
            stdout: JSON.stringify(payload, null, 2) + "\n",
          };
        const lines = [`plugin root: ${root}`, "", "scopes:"];
        for (const s of scopes)
          lines.push(
            `  ${s.name}: ${s.paths.join(", ")}  ->  ${s.patternSources.join(", ")}`,
          );
        lines.push("", "skills:");
        for (const s of skills)
          lines.push(
            `  ${s.name}  [${s.scopes.length === 0 ? "global" : s.scopes.join(", ")}]`,
          );
        return { exitCode: 0, stdout: lines.join("\n") + "\n" };
      }
      if (command === "check") {
        let projectFlag: string | null = null;
        const rest: string[] = [];
        for (let i = 1; i < args.length; i += 1) {
          if (args[i] === "--project") {
            projectFlag = args[i + 1] ?? null;
            i += 1;
          } else {
            rest.push(args[i]);
          }
        }
        const target = rest[0] ?? ctx.cwd ?? null;
        if (!target)
          return {
            exitCode: 2,
            stderr: "check: give a path, or run from inside a bb thread\n",
          };
        const projectId =
          projectFlag ?? (rest[0] ? null : (ctx.projectId ?? null));
        const selected = selectSkills(
          skills,
          scopes,
          candidatesFor(target, projectId),
        );
        const payload = {
          path: normalizeDir(target),
          projectId,
          skills: selected,
        };
        if (json)
          return {
            exitCode: 0,
            stdout: JSON.stringify(payload, null, 2) + "\n",
          };
        return {
          exitCode: 0,
          stdout:
            `path: ${payload.path}${projectId ? `  (project ${projectId})` : ""}\n` +
            (selected.length === 0
              ? "skills: none\n"
              : `skills:\n${selected.map((s) => `  ${s}`).join("\n")}\n`),
        };
      }
      return {
        exitCode: 2,
        stderr: `unknown command "${command}"; try: bb dir-skills status | check [<path>]\n`,
      };
    },
  });
}
