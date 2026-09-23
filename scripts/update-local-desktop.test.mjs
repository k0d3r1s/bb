import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
const localUpdateEnvironment = Object.entries(process.env).filter(([key]) =>
  key.startsWith("BB_LOCAL_"),
);
for (const [key] of localUpdateEnvironment) delete process.env[key];
const {
  backupAppPath,
  collectionEntryNames,
  collectionManifestUrl,
  collectionSourceKey,
  ensurePluginServerAvailable,
  externalPluginSyncAction,
  resolveExternalPlugins,
  unlistedCollectionPluginIds,
  installAndActivateLocalApp,
  npmEnvironment,
  parseLocalUpdateArgs,
  pushArguments,
  resolveBbCli,
  resolveForkRemote,
  remoteSlug,
  resolveRemoteNames,
} = await import("./update-local-desktop.mjs");
for (const [key, value] of localUpdateEnvironment) process.env[key] = value;

test("installs the local app before stopping bb and starts the replacement", async () => {
  const events = [];
  await installAndActivateLocalApp({
    install: async () => events.push("install"),
    startLocal: async () => events.push("start-local"),
    stopOfficial: async () => events.push("stop-official"),
  });
  assert.deepEqual(events, ["install", "stop-official", "start-local"]);

  await assert.rejects(
    installAndActivateLocalApp({
      install: async () => {
        throw new Error("install failed");
      },
      startLocal: async () => events.push("unexpected-start"),
      stopOfficial: async () => events.push("unexpected-stop"),
    }),
    /install failed/u,
  );
  assert.deepEqual(events, ["install", "stop-official", "start-local"]);
});

test("starts the official app when plugin synchronization has no server", async () => {
  const events = [];
  let attempts = 0;
  await ensurePluginServerAvailable({
    readSource: () => {
      attempts += 1;
      events.push(`read-${attempts}`);
      if (attempts === 1) throw new Error("Cannot connect to BB server");
    },
    startOfficial: async () => events.push("start-official"),
  });
  assert.deepEqual(events, ["read-1", "start-official", "read-2"]);

  await assert.rejects(
    ensurePluginServerAvailable({
      readSource: () => {
        throw new Error("still unavailable");
      },
      startOfficial: async () => {},
    }),
    /cannot connect to the official BB server after starting it.*still unavailable/su,
  );
});

test("resolves the CLI from an installed desktop app when bb is not on PATH", async () => {
  const applicationsRoot = await mkdtemp(
    path.join(os.tmpdir(), "bb-local-updater-applications-"),
  );
  const cli = path.join(
    applicationsRoot,
    "bb.app",
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "bb-app",
    "host-daemon",
    "dist",
    "bb",
  );
  try {
    await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(cli, "#!/bin/sh\n", { mode: 0o755 });

    assert.equal(
      await resolveBbCli({ PATH: "" }, { applicationsRoot }),
      await realpath(cli),
    );
  } finally {
    await rm(applicationsRoot, { recursive: true, force: true });
  }
});

test("parses updater modes", () => {
  assert.deepEqual(parseLocalUpdateArgs([]), {
    check: false,
    current: false,
    install: true,
    plugins: true,
    push: true,
  });
  assert.deepEqual(
    parseLocalUpdateArgs([
      "--",
      "--check",
      "--current",
      "--skip-install",
      "--skip-plugins",
      "--skip-push",
    ]),
    {
      check: true,
      current: true,
      install: false,
      plugins: false,
      push: false,
    },
  );
  assert.throws(() => parseLocalUpdateArgs(["--wat"]), /unknown argument/u);
});

async function createCurrentUpdaterFixture({
  branch = "main",
  forkHead = "fork123",
  pushUrl = "https://github.com/lettland/bb.git",
} = {}) {
  const binDirectory = await mkdtemp(
    path.join(os.tmpdir(), "bb-local-updater-current-bin-"),
  );
  const commandLog = path.join(binDirectory, "commands.log");
  const fakeGit = path.join(binDirectory, "git");
  await writeFile(commandLog, "");
  await writeFile(
    fakeGit,
    `#!/bin/sh
printf 'git %s\n' "$*" >> "$BB_TEST_COMMAND_LOG"
case "$*" in
  "rev-parse --show-toplevel") /bin/pwd ;;
  "branch --show-current") printf '%s\n' "$BB_TEST_BRANCH" ;;
  "status --porcelain=v1 --untracked-files=all") ;;
  "rev-parse --short HEAD") printf '%s\n' abc1234 ;;
  "remote -v") printf '%s\n' 'origin https://github.com/lettland/bb.git (fetch)' ;;
  "remote get-url --push --all origin") printf '%s\n' "$BB_TEST_PUSH_URL" ;;
  "rev-parse --verify refs/remotes/origin/main")
    if [ -n "$BB_TEST_FORK_HEAD" ]; then printf '%s\n' "$BB_TEST_FORK_HEAD"; else exit 1; fi
    ;;
  "push --force-with-lease=refs/heads/main:"*" origin HEAD:main") ;;
  *) printf '%s\n' "unexpected git command: $*" >&2; exit 97 ;;
esac
`,
    { mode: 0o755 },
  );
  const fakeTool = `#!/bin/sh
tool=\${0##*/}
printf '%s %s\n' "$tool" "$*" >> "$BB_TEST_COMMAND_LOG"
`;
  await Promise.all(
    ["node", "pnpm", "npm", "codesign"].map((tool) =>
      writeFile(path.join(binDirectory, tool), fakeTool, { mode: 0o755 }),
    ),
  );
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("BB_LOCAL_")) delete environment[key];
  }
  return {
    binDirectory,
    commandLog,
    env: {
      ...environment,
      BB_TEST_BRANCH: branch,
      BB_TEST_COMMAND_LOG: commandLog,
      BB_TEST_FORK_HEAD: forkHead,
      BB_TEST_PUSH_URL: pushUrl,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  };
}

function runCurrentUpdater(fixture, ...args) {
  return spawnSync(
    process.execPath,
    [
      path.join(process.cwd(), "scripts", "update-local-desktop.mjs"),
      "--current",
      "--skip-install",
      "--skip-plugins",
      ...args,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: fixture.env,
    },
  );
}

test("current checkout mode completes without fetch or rebase", async () => {
  const fixture = await createCurrentUpdaterFixture();
  try {
    const result = runCurrentUpdater(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /current checkout abc1234/u);
    assert.match(result.stdout, /updated from current checkout abc1234/u);
    const commands = await readFile(fixture.commandLog, "utf8");
    assert.doesNotMatch(commands, /^git (?:fetch|rebase)\b/mu);
    assert.match(
      commands,
      /^node --test --test-concurrency=1 scripts\/update-local-desktop\.test\.mjs$/mu,
    );
    assert.match(commands, /^pnpm desktop:local:package$/mu);
    assert.match(
      commands,
      /^git push --force-with-lease=refs\/heads\/main:fork123 origin HEAD:main$/mu,
    );
  } finally {
    await rm(fixture.binDirectory, { recursive: true, force: true });
  }
});

test("current checkout mode refuses to push without a tracking head", async () => {
  const fixture = await createCurrentUpdaterFixture({ forkHead: "" });
  try {
    const result = runCurrentUpdater(fixture);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /cannot safely push.*fetch the fork first or use --skip-push/su,
    );
    const commands = await readFile(fixture.commandLog, "utf8");
    assert.doesNotMatch(commands, /^(?:pnpm|npm|codesign)\b/mu);
    assert.doesNotMatch(commands, /^git push\b/mu);
  } finally {
    await rm(fixture.binDirectory, { recursive: true, force: true });
  }
});

test("current checkout mode refuses to push a different branch", async () => {
  const fixture = await createCurrentUpdaterFixture({
    branch: "feature/current",
  });
  try {
    const result = runCurrentUpdater(fixture);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /branch feature\/current does not match push target main.*--skip-push/su,
    );
    const commands = await readFile(fixture.commandLog, "utf8");
    assert.doesNotMatch(commands, /^git remote -v$/mu);
    assert.doesNotMatch(commands, /^(?:pnpm|npm|codesign)\b/mu);
  } finally {
    await rm(fixture.binDirectory, { recursive: true, force: true });
  }
});

test("current checkout mode refuses a fork remote that pushes upstream", async () => {
  const fixture = await createCurrentUpdaterFixture({
    pushUrl: "https://github.com/get-bb/bb.git",
  });
  try {
    const result = runCurrentUpdater(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing to force-push to upstream/u);
    const commands = await readFile(fixture.commandLog, "utf8");
    assert.doesNotMatch(commands, /^git push\b/mu);
    assert.doesNotMatch(commands, /^(?:node|pnpm|npm|codesign)\b/mu);
  } finally {
    await rm(fixture.binDirectory, { recursive: true, force: true });
  }
});

test("installs, updates, or reinstalls an external plugin by current source", () => {
  assert.equal(externalPluginSyncAction(null), "install");
  assert.equal(
    externalPluginSyncAction(
      "git:https://github.com/lettland/bb-plugins.git@main",
    ),
    "update",
  );
  assert.equal(externalPluginSyncAction("builtin:auto-review"), "reinstall");
  assert.equal(externalPluginSyncAction("path:/some/dir"), "reinstall");
});

test("reinstalls a git plugin whose collection repository moved", () => {
  assert.equal(
    externalPluginSyncAction(
      "git:https://github.com/k0d3r1s/bb-plugins.git@master",
      "git:https://github.com/lettland/bb-plugins.git@master",
    ),
    "reinstall",
  );
  assert.equal(
    externalPluginSyncAction(
      "git:https://github.com/lettland/bb-plugins.git@master",
      "git:https://github.com/lettland/bb-plugins.git@master",
    ),
    "update",
  );
  assert.equal(
    externalPluginSyncAction(
      "git:https://github.com/lettland/bb-plugins.git@30f91fd977ba1ce60532af27a68534464fb62516",
      "git:https://github.com/lettland/bb-plugins.git@master",
    ),
    "update",
  );
  assert.equal(
    externalPluginSyncAction(
      "git:https://git.example.com/lettland/bb-plugins.git@master",
      "git:https://github.com/lettland/bb-plugins.git@master",
    ),
    "update",
  );
});

test("derives the raw collection manifest URL from a git source", () => {
  assert.equal(
    collectionManifestUrl(
      "git:https://github.com/lettland/bb-plugins.git@master",
    ),
    "https://raw.githubusercontent.com/lettland/bb-plugins/master/.bb/plugins.json",
  );
  assert.equal(
    collectionManifestUrl("git:https://github.com/lettland/bb-plugins@main"),
    "https://raw.githubusercontent.com/lettland/bb-plugins/main/.bb/plugins.json",
  );
  assert.equal(
    collectionManifestUrl(
      "git:https://github.com/lettland/bb-plugins.git@release/1.2",
    ),
    "https://raw.githubusercontent.com/lettland/bb-plugins/release/1.2/.bb/plugins.json",
  );
  assert.throws(
    () => collectionManifestUrl("npm:@lettland/bb-plugin-k0d3"),
    /collection manifest URL/u,
  );
});

test("reads plugin names from a collection manifest", () => {
  assert.deepEqual(
    collectionEntryNames({
      schemaVersion: 1,
      name: "lettland-plugins",
      plugins: [
        { name: "auto-review", source: "./plugins/auto-review" },
        { name: "k0d3", source: "./plugins/k0d3" },
      ],
    }),
    ["auto-review", "k0d3"],
  );
  assert.throws(
    () => collectionEntryNames({ schemaVersion: 2, plugins: [] }),
    /not a valid/u,
  );
  assert.throws(
    () =>
      collectionEntryNames({
        schemaVersion: 1,
        plugins: [{ source: "./plugins/x" }],
      }),
    /entry 0 has an invalid plugin name/u,
  );
  assert.throws(
    () =>
      collectionEntryNames({
        schemaVersion: 1,
        plugins: [{ name: "Bad Name", source: "./plugins/x" }],
      }),
    /invalid plugin name/u,
  );
  assert.throws(
    () =>
      collectionEntryNames({
        schemaVersion: 1,
        plugins: [
          { name: "dup", source: "./plugins/dup" },
          { name: "dup", source: "./plugins/dup2" },
        ],
      }),
    /more than once/u,
  );
});

test("expands a collection into one install spec per plugin", async () => {
  const requested = [];
  const plugins = await resolveExternalPlugins(
    [{ source: "git:https://github.com/lettland/bb-plugins.git@master" }],
    async (url) => {
      requested.push(url);
      return {
        ok: true,
        json: async () => ({
          schemaVersion: 1,
          name: "lettland-plugins",
          plugins: [
            { name: "auto-review", source: "./plugins/auto-review" },
            { name: "k0d3", source: "./plugins/k0d3" },
          ],
        }),
      };
    },
  );
  assert.deepEqual(requested, [
    "https://raw.githubusercontent.com/lettland/bb-plugins/master/.bb/plugins.json",
  ]);
  assert.deepEqual(plugins, [
    {
      id: "auto-review",
      plugin: "auto-review",
      source: "git:https://github.com/lettland/bb-plugins.git@master",
    },
    {
      id: "k0d3",
      plugin: "k0d3",
      source: "git:https://github.com/lettland/bb-plugins.git@master",
    },
  ]);
});

test("fails loudly when a collection manifest is unreachable", async () => {
  await assert.rejects(
    resolveExternalPlugins(
      [{ source: "git:https://github.com/lettland/bb-plugins.git@master" }],
      async () => ({ ok: false, status: 404, json: async () => ({}) }),
    ),
    /HTTP 404/u,
  );
});

test("labels a network failure with the manifest URL", async () => {
  await assert.rejects(
    resolveExternalPlugins(
      [{ source: "git:https://github.com/lettland/bb-plugins.git@master" }],
      async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    ),
    /cannot fetch collection manifest at https:\/\/raw\.githubusercontent\.com\/.*getaddrinfo ENOTFOUND/u,
  );
});

test("labels a non-JSON manifest body with the manifest URL", async () => {
  await assert.rejects(
    resolveExternalPlugins(
      [{ source: "git:https://github.com/lettland/bb-plugins.git@master" }],
      async () => ({
        ok: true,
        json: async () => {
          throw new Error("Unexpected token <");
        },
      }),
    ),
    /is not valid JSON/u,
  );
});

test("keys a collection source by owner, repo, and ref, ignoring .git", () => {
  assert.equal(
    collectionSourceKey(
      "git:https://github.com/lettland/bb-plugins.git@master",
    ),
    "lettland/bb-plugins@master",
  );
  assert.equal(
    collectionSourceKey("git:https://github.com/lettland/bb-plugins@master"),
    "lettland/bb-plugins@master",
  );
  assert.equal(collectionSourceKey("builtin:auto-review"), null);
});

test("flags installed collection plugins that left the manifest", () => {
  const collections = [
    { source: "git:https://github.com/lettland/bb-plugins.git@master" },
  ];
  const desired = [
    {
      id: "k0d3",
      plugin: "k0d3",
      source: "git:https://github.com/lettland/bb-plugins.git@master",
    },
  ];
  const installed = [
    {
      id: "auto-review",
      source: "git:https://github.com/lettland/bb-plugins.git@master",
    },
    {
      id: "k0d3",
      source: "git:https://github.com/lettland/bb-plugins.git@master",
    },
    { id: "advisor", source: "git:https://github.com/salemsayed/x.git@main" },
    { id: "connect", source: "builtin:connect" },
  ];
  assert.deepEqual(
    unlistedCollectionPluginIds(installed, collections, desired),
    ["auto-review"],
  );
});

test("never removes plugins from another repo or a different ref", () => {
  const collections = [
    { source: "git:https://github.com/lettland/bb-plugins.git@master" },
  ];
  const installed = [
    {
      id: "same-repo-other-ref",
      source: "git:https://github.com/lettland/bb-plugins.git@next",
    },
    {
      id: "other-repo",
      source: "git:https://github.com/someone/else.git@main",
    },
  ];
  assert.deepEqual(unlistedCollectionPluginIds(installed, collections, []), []);
});

test("flags every collection plugin when the desired set is empty", () => {
  const collections = [
    { source: "git:https://github.com/lettland/bb-plugins.git@master" },
  ];
  const installed = [
    {
      id: "auto-review",
      source: "git:https://github.com/lettland/bb-plugins.git@master",
    },
    { id: "connect", source: "builtin:connect" },
  ];
  assert.deepEqual(unlistedCollectionPluginIds(installed, collections, []), [
    "auto-review",
  ]);
});

test("scopes desired ids per collection source, not as a flat union", () => {
  const collections = [
    { source: "git:https://github.com/lettland/bb-plugins.git@master" },
    { source: "git:https://github.com/lettland/other-plugins.git@master" },
  ];
  const desired = [
    {
      id: "shared",
      plugin: "shared",
      source: "git:https://github.com/lettland/bb-plugins.git@master",
    },
  ];
  const installed = [
    {
      id: "shared",
      source: "git:https://github.com/lettland/other-plugins.git@master",
    },
  ];
  assert.deepEqual(
    unlistedCollectionPluginIds(installed, collections, desired),
    ["shared"],
  );
});

test("throws instead of mass-removing when desired and collections are swapped", () => {
  const collections = [
    { source: "git:https://github.com/lettland/bb-plugins.git@master" },
  ];
  const desired = [
    {
      id: "k0d3",
      plugin: "k0d3",
      source: "git:https://github.com/lettland/bb-plugins.git@master",
    },
  ];
  const installed = [
    {
      id: "k0d3",
      source: "git:https://github.com/lettland/bb-plugins.git@master",
    },
  ];
  assert.deepEqual(
    unlistedCollectionPluginIds(installed, collections, desired),
    [],
  );
  assert.throws(
    () => unlistedCollectionPluginIds(installed, desired, collections),
    /missing a string id/u,
  );
});

test("pins a rewritten fork push to the fetched remote head", () => {
  assert.deepEqual(pushArguments("abc123", "fork"), [
    "push",
    "--force-with-lease=refs/heads/main:abc123",
    "fork",
    "HEAD:main",
  ]);
  assert.deepEqual(pushArguments(null, "fork"), ["push", "fork", "HEAD:main"]);
  assert.deepEqual(pushArguments(null, "origin"), [
    "push",
    "origin",
    "HEAD:main",
  ]);
});

test("reads the repository slug from either remote URL form", () => {
  assert.equal(remoteSlug("https://github.com/get-bb/bb.git"), "get-bb/bb");
  assert.equal(remoteSlug("git@github.com:lettland/bb.git"), "lettland/bb");
  assert.equal(remoteSlug("https://token@github.com/GET-BB/BB"), "get-bb/bb");
});

test("classifies remotes by URL rather than by name", () => {
  assert.deepEqual(
    resolveRemoteNames([
      { name: "origin", url: "https://github.com/get-bb/bb.git" },
      { name: "fork", url: "https://github.com/lettland/bb.git" },
    ]),
    { fork: "fork", upstream: "origin" },
  );
  assert.deepEqual(
    resolveRemoteNames([
      { name: "_get-bb", url: "https://github.com/get-bb/bb.git" },
      { name: "origin", url: "https://github.com/lettland/bb.git" },
    ]),
    { fork: "origin", upstream: "_get-bb" },
  );
});

test("resolves a fork without requiring an upstream remote", () => {
  assert.equal(
    resolveForkRemote([
      { name: "origin", url: "https://github.com/lettland/bb.git" },
    ]),
    "origin",
  );
  assert.throws(
    () =>
      resolveForkRemote([
        { name: "origin", url: "https://github.com/get-bb/bb.git" },
      ]),
    /no fork remote found/u,
  );
  assert.throws(
    () =>
      resolveForkRemote([
        {
          name: "origin",
          pushUrls: ["https://github.com/get-bb/bb.git"],
          url: "https://github.com/lettland/bb.git",
        },
      ]),
    /refusing to force-push to upstream/u,
  );
});

test("lets the environment override remote discovery", () => {
  assert.deepEqual(
    resolveRemoteNames(
      [
        { name: "_get-bb", url: "https://github.com/get-bb/bb.git" },
        { name: "origin", url: "https://github.com/lettland/bb.git" },
        { name: "mirror", url: "https://github.com/lettland/bb-mirror.git" },
      ],
      { fork: "mirror" },
    ),
    { fork: "mirror", upstream: "_get-bb" },
  );
});

test("refuses to guess a fork remote when only upstream is configured", () => {
  assert.throws(
    () =>
      resolveRemoteNames([
        { name: "origin", url: "https://github.com/get-bb/bb.git" },
      ]),
    /no fork remote found/u,
  );
});

test("refuses to guess upstream when no remote matches the slug", () => {
  assert.throws(
    () =>
      resolveRemoteNames([
        { name: "origin", url: "https://github.com/lettland/bb.git" },
        { name: "_get-bb", url: "https://ghe.example.com/mirror/bb.git" },
      ]),
    /no remote matches get-bb\/bb/u,
  );
  assert.deepEqual(
    resolveRemoteNames(
      [
        { name: "origin", url: "https://github.com/lettland/bb.git" },
        { name: "_get-bb", url: "https://ghe.example.com/mirror/bb.git" },
      ],
      { upstream: "_get-bb" },
    ),
    { fork: "origin", upstream: "_get-bb" },
  );
});

test("refuses overrides that collapse fork and upstream onto one remote", () => {
  assert.throws(
    () =>
      resolveRemoteNames(
        [
          { name: "_get-bb", url: "https://github.com/get-bb/bb.git" },
          { name: "mirror", url: "https://github.com/lettland/bb-mirror.git" },
        ],
        { fork: "mirror", upstream: "mirror" },
      ),
    /both resolve to mirror/u,
  );
});

test("refuses a fork override that points at upstream", () => {
  assert.throws(
    () =>
      resolveRemoteNames(
        [
          { name: "_get-bb", url: "https://github.com/get-bb/bb.git" },
          { name: "origin", url: "https://github.com/lettland/bb.git" },
        ],
        { fork: "_get-bb" },
      ),
    /refusing to force-push to upstream/u,
  );
});

test("places unique app backups in Trash", () => {
  assert.equal(
    backupAppPath(new Date("2026-09-08T12:34:56.789Z")),
    path.join(
      os.homedir(),
      ".Trash",
      "bb-local-backup-2026-09-08T12-34-56-789Z.app",
    ),
  );
});

test("removes inherited npm script policy from nested npm commands", () => {
  assert.deepEqual(
    npmEnvironment({
      PATH: "/bin",
      npm_config_allow_scripts: "better-sqlite3",
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      npm_config_foreground_scripts: "true",
    }),
    { PATH: "/bin" },
  );
});
