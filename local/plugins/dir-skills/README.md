# bb-plugin-dir-skills

Directory-scoped skills for bb, for every provider (Claude Code, Codex, Pi, ACP
providers). bb injects a plugin's `skills/<name>/SKILL.md` into every thread;
this plugin narrows that to threads whose workspace lives under a configured
directory.

## Layout

```
scopes.json            directory trees -> skill-name patterns
skills/<name>/SKILL.md ordinary bb skills (frontmatter: name, description)
```

`scopes.json`:

```json
{
  "scopes": [
    { "name": "aerones", "paths": ["~/workspace/aerones"], "skills": ["aerones-*"] }
  ]
}
```

- A skill whose name matches a scope pattern is injected only when the thread's
  environment path, or the checkout path of the thread's project, is inside one
  of that scope's directories. Managed worktrees therefore still count.
- A skill that no scope claims is injected everywhere.
- Paths are compared after symlink resolution on both sides.
- Project checkout paths are cached at load, every minute, and on thread
  creation. The very first thread of a managed worktree in a project created
  seconds earlier can miss a scoped skill until the next refresh; unmanaged and
  personal environments match by their own path and are unaffected.
- `*` in a pattern matches any characters. A skill may belong to several scopes.

## Adding a work skill

1. Create `skills/aerones-<topic>/SKILL.md` with `name: aerones-<topic>` and a
   `description`. A Claude skill directory works unchanged; copy it in.
2. Run `bb plugin reload dir-skills`. Threads pick up the new catalog when
   their provider session is next started.
3. `bb dir-skills status` lists every skill and its scope. `bb dir-skills check
   ~/workspace/aerones/some-repo` shows what a thread there would receive.
4. Each thread start writes a debug log line with the environment path and the
   selected skills: `bb plugin logs dir-skills`.

Skills land in the agent under bb's plugin-skill namespace, e.g. Claude Code
sees `bb-global-skills:aerones-conventions`.

## Install

```
bb plugin install ~/workspace/bb-plugin-dir-skills
```
