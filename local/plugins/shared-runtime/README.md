# bb-plugin-shared-runtime

One shared, write-confined container runtime per repository for every BB managed worktree.
Install the plugin once per host, then enable it in any repository by committing a
`.bb-runtime.json` manifest and running one install command from the primary checkout.

The plugin gives agent threads a small set of typed tools:

| Tool | Purpose |
|---|---|
| `runtime_container` | Run one operation declared by the project manifest inside the project's shared Docker stack, write-confined to the selected worktree by Landlock and seccomp. |
| `runtime_git` | Typed Git: status, diff, log, add, commit (with declared commit-preparation generators), rebase onto the primary branch, fast-forward the primary checkout. |
| `runtime_ops` | Lifecycle: status, diagnose, logs, ensure, recreate, stop, sync. |
| `runtime_search` | Workspace-confined literal search with ripgrep. |
| `runtime_thread` | Read bounded output from one same-project thread. |
| `runtime_skill_resource` | Read one file from an installed agent skill. |
| `codegraph_*` | Optional bridge to an operator-installed CodeGraph index bound to the current checkout. |

The legacy `platform_*` names remain registered as aliases so active threads can move from Platform Runtime without restarting or reinstalling the retired plugin.

Agents never receive Docker, a shell, or a host toolchain. Every command is an argument array
compiled from the manifest; targets are validated against a declared pattern or variant list.

## How it works

- **One Docker stack per primary checkout.** The repository's own Compose stack, started by the
  lifecycle script the manifest names, serves every BB worktree of that repository.
- **Worktrees are mounted into the stack** at `worktrees.containerRoot` (default `/bb-worktrees`).
  Containers that run Git also mount the worktree root and the primary checkout at their
  identical host paths so linked-worktree metadata stays valid.
- **Write confinement.** Quality operations run under `native/landlock-run.go`, built once per
  project into `<primary>/.bb-runtime/landlock-run` by the manifest's `isolation.builder`
  container. Writes are limited to the selected worktree and per-worktree scratch paths.
- **Trust anchors.** The manifest describes *what* a project can do. The host registry under
  `~/.bb/shared-runtime/projects/<projectId>.json` records *which* BB project, on *which* host,
  at *which* primary checkout is allowed to do it, and pins the manifest's SHA-256. A manifest
  edited after installation is refused until `bb-shared-runtime sync` re-pins it from the primary
  checkout, so a branch cannot grant itself new operations.

## Installing in a repository

1. Commit `.bb-runtime.json` at the repository root (schema below).
2. Make sure the repository's Compose stack mounts the BB worktree root into each container the
   manifest declares. `bb-shared-runtime compose-overlay` prints an overlay file you can commit
   and pass as a second `-f` to `docker compose`; `bb-shared-runtime env` prints the exports it
   needs.
3. From the primary checkout run:

   ```sh
   node /path/to/bb-plugin-shared-runtime/bin/bb-shared-runtime.mjs install
   ```

   This resolves the BB project and host from `bb project list`, derives container names from
   the Compose project, writes the registry entry, and installs or reloads the plugin.
   Pass `--manifest /absolute/path/to/manifest.json` when a trusted updater owns the manifest
   outside the repository, such as migration from the retired Platform Runtime plugin.
4. Run `bb-shared-runtime doctor` to verify the registration, manifest hash, containers, and
   mounts. Run `bb-shared-runtime validate` on any checkout to check a manifest without touching
   the registry.

Repeat step 3 on each host. Nothing else is per project. `bb-shared-runtime list` shows every
registered project; `bb-shared-runtime uninstall` removes one.

## Manifest reference (`.bb-runtime.json`, version 1)

```json
{
  "version": 1,
  "name": "Platform",
  "compose": { "envFile": "docker/dev/.env", "projectVariable": "PROJECT" },
  "lifecycle": {
    "ensure": ["bash", "scripts/dev.sh"],
    "recreate": ["bash", "scripts/dev.sh", "--override"],
    "stop": ["bash", "scripts/stop.sh"]
  },
  "worktrees": { "containerRoot": "/bb-worktrees" },
  "isolation": { "builder": "go", "probe": "symfony" },
  "search": { "defaultPath": "src" },
  "containers": {
    "symfony": {
      "service": "zts",
      "root": "src/symfony",
      "mounts": [
        { "host": ".", "container": "${primaryRoot}" },
        { "host": "src/symfony", "container": "/var/www/html" }
      ]
    }
  },
  "scratch": { "go-cache": { "env": ["GOCACHE"] } },
  "dependencies": [
    { "path": "src/symfony/vendor", "link": "/var/www/html/vendor" },
    { "path": "src/sveltekit/apps/*/node_modules", "mirror": "/app/apps/*/node_modules", "local": [".vite"] }
  ],
  "operations": {
    "symfony_static": { "container": "symfony", "argv": ["bin/stan"] },
    "symfony_unit": {
      "container": "symfony",
      "argv": ["bin/unit", "${target}"],
      "target": { "required": true, "pattern": "^[a-z][a-z0-9/_-]*$" }
    },
    "symfony_full": { "steps": ["symfony_static", "symfony_unit_all"] }
  },
  "git": {
    "prepareCommit": {
      "generators": [
        {
          "container": "symfony",
          "cwd": ".",
          "argv": ["php", "scripts/generate-components.php", "--modified"],
          "requires": "scripts/generate-components.php",
          "stages": [".github/deploy/components-modified.json"],
          "tolerateMissingExecutable": true
        }
      ],
      "hardlinks": [{ "source": "profile/public/README.md", "target": "profile/private/README.md" }]
    }
  },
  "codegraph": { "enabled": true }
}
```

Field notes:

- `containers.<role>.service` is the Compose service; the container name is
  `<composeProject>_<service>` unless `containerName` is given. `mounts` map repository-relative
  host paths to container paths; `"${primaryRoot}"` means the primary checkout is mounted at its
  own absolute host path. `root` is the default working directory for operations, relative to
  the repository.
- `isolation.builder` names the container with a Go toolchain that builds the launcher.
  `isolation.probe` (default: builder) names the container used for the built-in
  `isolation_self_test` operation; it needs Git.
- `scratch` declares extra per-worktree scratch directories under `/var/tmp`, exported under the
  listed environment variable names and available as `${scratch.<name>}`.
- `dependencies` prepare a fresh worktree before every operation: `link` symlinks a path to a
  shared in-container directory; `mirror` creates a directory of symlinks to the shared source
  with `local` entries kept as writable per-worktree directories. One `*` segment per path is
  expanded against the primary checkout.
- Operations are either a single step or a `steps` list referencing other single-step operations
  or inline steps. A step is a container step (`container`, `cwd`, `argv`, `env`,
  `failOnStdout`) or a host step (`kind: "host"`, an interpreter plus a primary-checkout script,
  `containers` it touches, `env`). `target` declares either an anchored `pattern` (used through
  `${target}`) or `variants` keyed by target value.
- Placeholders in `argv` and `env`: `${root}` (repository root inside the step's container),
  `${cwd}`, `${env}` (environment id), `${envSlug}` (environment id with underscores replaced
  by hyphens), `${tmp}`, `${runtime}` (the plugin's `assets/` copy
  inside the container, for preloads), `${launcher.<role>}`, `${root.<role>}`,
  `${runtime.<role>}`, `${scratch.<name>}`, `${primaryRoot}`, `${hostRoot}`, `${docker}`,
  and `${target}`. Unknown placeholders fail validation.
- `argv[0]` may not be a shell with `-c`, or a script interpreter with `-e`. Host steps must
  start with `bash` or `sh` followed by a repository-relative script that is read from the
  primary checkout, never from the worktree.

## Registry reference (`~/.bb/shared-runtime/projects/<projectId>.json`)

Written only by `bb-shared-runtime install` and `sync`, mode 0600 inside 0700 directories. The
plugin refuses entries with other permissions, symlinks, or hard links.

```json
{
  "projectId": "proj_97vy956k9w",
  "trustedHostId": "host_e7kdfsvum6",
  "primaryRoot": "/Users/me/workspace/platform",
  "worktreeRoot": "/Users/me/.bb/worktrees",
  "worktreeDirectoryName": "platform",
  "gitCommonDir": "/Users/me/workspace/platform/.git",
  "dockerPath": "/opt/homebrew/bin/docker",
  "dockerSocket": "/Users/me/.colima/default/docker.sock",
  "composeProject": "pform_dev",
  "containers": { "go": "pform_dev_tracigo_go", "sveltekit": "pform_dev_sveltekit", "symfony": "pform_dev_zts" },
  "manifestSha256": "…",
  "codegraphCommand": null,
  "codegraphRoot": null,
  "bbCli": "/Applications/bb.app/…/bb"
}
```

## Development

```sh
node --test test/
```

The suite covers workspace mapping, plan compilation from the Platform fixture manifest,
target validation, isolation probes, dependency preparation, the reader-writer project locks
(including the shell reload helper), agent configuration, registry loading, thread reads, the
CodeGraph bridge, and the CLI's registry-free commands.
