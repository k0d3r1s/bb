import assert from "node:assert/strict";
import { execFile, spawn as spawnChild } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readFileSync } from "node:fs";

import {
  _testing,
  buildContainerPlan,
  buildFastForwardPrimaryPlan,
  buildGitInvocation,
  buildIsolationSelfTestInvocation,
  buildPrecommitGenerationPlan,
  buildRebasePrimaryInvocation,
  buildRebasePrimaryPreflightPlan,
  buildRebaseRecoveryInvocation,
  buildSearchInvocation,
  ensureContainerSymlink,
  executeGit,
  formatResults,
  hostPathInContainer,
  ISOLATION_SELF_TEST_OPERATION,
  prepareWorktreeDependencies,
  runInvocation,
  validateWorkspace,
  withProjectLock,
} from "../src/runtime.mjs";
import {
  buildAgentConfiguration,
  buildAgentInstructions,
  CODEGRAPH_TOOL_NAMES,
  rehydrateAgentContext,
  RUNTIME_TOOL_ALIASES,
} from "../src/configuration.mjs";
import {
  CODEGRAPH_TOOL_NAMES as BRIDGED_CODEGRAPH_TOOL_NAMES,
  executeCodeGraphTool,
} from "../src/codegraph.mjs";
import { readPluginResource } from "../src/plugin-resource.mjs";
import { buildRuntimeGitTool, gitOperations } from "../src/git-tool.mjs";
import {
  buildRuntimeOpsTool,
  buildRuntimeLogInvocation,
  buildRuntimeInvocation,
  executeRuntimeOperation,
  runtimeOperations,
  schedulePluginReload,
} from "../src/runtime-tool.mjs";
import { readProjectThread, threadReadLimits } from "../src/thread-read.mjs";
import {
  describeOperations,
  manifestDigest,
  validateManifest,
} from "../src/manifest.mjs";
import {
  loadPolicy,
  loadRegistry,
  validatePolicyDocument,
} from "../src/registry.mjs";

const fixtureManifestPath = new URL(
  "./fixtures/platform.bb-runtime.json",
  import.meta.url,
);
const fixtureManifestContent = readFileSync(fixtureManifestPath);
const fixtureManifestDigest = manifestDigest(fixtureManifestContent);
const manifest = validateManifest(
  JSON.parse(fixtureManifestContent.toString("utf8")),
);
const productionManifestPath = new URL(
  "../manifests/platform.bb-runtime.json",
  import.meta.url,
);
const productionManifestContent = readFileSync(productionManifestPath);
const productionManifestDigest = manifestDigest(productionManifestContent);
const productionManifest = validateManifest(
  JSON.parse(productionManifestContent.toString("utf8")),
);

const policy = Object.freeze({
  projectId: "proj_platform",
  trustedHostId: "host_vairogs",
  primaryRoot: "/workspace/platform",
  worktreeRoot: "/bb/worktrees",
  worktreeDirectoryName: "platform",
  gitCommonDir: "/workspace/platform/.git",
  containers: Object.freeze({
    go: "pform_dev_tracigo_go",
    sveltekit: "pform_dev_sveltekit",
    symfony: "pform_dev_zts",
  }),
  dockerPath: "/usr/local/bin/docker",
  manifestSha256: fixtureManifestDigest,
  manifest,
  manifestDigest: fixtureManifestDigest,
  manifestStale: false,
  manifestError: null,
});
const productionPolicy = Object.freeze({
  ...policy,
  manifestSha256: productionManifestDigest,
  manifest: productionManifest,
  manifestDigest: productionManifestDigest,
});

function registryFor(...policies) {
  const map = new Map(policies.map((entry) => [entry.projectId, entry]));
  return { policyFor: (id) => map.get(id) ?? null };
}
const registry = registryFor(policy);

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const execFileAsync = promisify(execFile);

async function waitForFixturePath(filePath) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      await lstat(filePath);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fixture path did not appear: ${filePath}`);
}

async function waitForFixturePathRemoval(filePath) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      await lstat(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fixture path was not removed: ${filePath}`);
}

async function waitForClaimReplacement(filePath, previousId) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      const owner = JSON.parse(await readFile(filePath, "utf8"));
      if (owner.id !== previousId) {
        return;
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fixture claim was not replaced: ${filePath}`);
}

async function waitForFixtureSignal(signal, label) {
  let timeout;
  try {
    await Promise.race([
      signal,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`fixture signal timed out: ${label}`)),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function retireFixtureDirectory(directory) {
  const retiredDirectory = `${directory}.released`;
  await rename(directory, retiredDirectory);
  await rm(retiredDirectory, { recursive: true, force: true });
}

async function removeFixtureDirectory(directory) {
  await rm(directory, {
    force: true,
    maxRetries: 10,
    recursive: true,
    retryDelay: 25,
  });
}

async function prepareReloadInterleavingFixture(prefix) {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), `${prefix}-`));
  const projectId = `${prefix}-${process.pid}-${Date.now()}`;
  const helper = path.join(fixtureRoot, "scripts", "reload.sh");
  const runtimeHelper = path.join(fixtureRoot, "scripts", "plugin-reload.sh");
  const runtimeRoot = path.join(fixtureRoot, "home", ".bb", "shared-runtime");
  const lockRoot = path.join(runtimeRoot, "locks");
  const lockPath = path.join(lockRoot, `${projectId}.lock`);
  const reloadLog = path.join(fixtureRoot, "reload.log");
  const commandRoot = path.join(fixtureRoot, "bin");
  const readyPath = path.join(fixtureRoot, "mkdir.ready");
  const releasePath = path.join(fixtureRoot, "mkdir.release");
  const shellWaitPath = path.join(fixtureRoot, "shell.waiting");

  await mkdir(path.dirname(helper), { recursive: true });
  await mkdir(commandRoot, { recursive: true });
  await writeFile(
    helper,
    await readFile(path.join(pluginRoot, "scripts", "reload.sh"), "utf8"),
    { mode: 0o755 },
  );
  await writeFile(
    runtimeHelper,
    [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      'printf "reload\\n" >>"${RELOAD_LOG:?}"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await writeFile(
    path.join(commandRoot, "mkdir"),
    [
      "#!/bin/sh",
      "set -eu",
      "last_argument=",
      'for argument in "$@"; do',
      "    last_argument=$argument",
      "done",
      'if [ "$last_argument" = "${BLOCK_MKDIR_PATH:-}" ]; then',
      '    : >"${BLOCK_READY_PATH:?}"',
      '    while [ ! -f "${BLOCK_RELEASE_PATH:?}" ]; do',
      "        sleep 0.01",
      "    done",
      "fi",
      'exec /bin/mkdir "$@"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await writeFile(path.join(commandRoot, "chmod"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  await writeFile(
    path.join(commandRoot, "mv"),
    [
      "#!/bin/sh",
      "set -eu",
      "last_argument=",
      'for argument in "$@"; do',
      "    last_argument=$argument",
      "done",
      'if [ "$last_argument" = "${BLOCK_MV_PATH:-}" ]; then',
      '    : >"${BLOCK_READY_PATH:?}"',
      '    while [ ! -f "${BLOCK_RELEASE_PATH:?}" ]; do',
      "        sleep 0.01",
      "    done",
      "fi",
      'exec /bin/mv "$@"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await writeFile(
    path.join(commandRoot, "ln"),
    [
      "#!/bin/sh",
      "last_argument=",
      'for argument in "$@"; do',
      "    last_argument=$argument",
      "done",
      'if [ "${FAIL_RECOVERY_LINK:-}" = 1 ] && echo "$last_argument" | /usr/bin/grep -q "\\.recover-"; then',
      '    echo "simulated recovery link failure" >&2',
      "    exit 5",
      "fi",
      "status=0",
      '/bin/ln "$@" || status=$?',
      'if [ "$status" -ne 0 ] && [ "$last_argument" = "${WATCH_CLAIM_PATH:-}" ]; then',
      '    : >"${SHELL_WAIT_PATH:?}"',
      "fi",
      'exit "$status"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await writeFile(
    path.join(commandRoot, "cat"),
    [
      "#!/bin/sh",
      "set -eu",
      "last_argument=",
      'for argument in "$@"; do',
      "    last_argument=$argument",
      "done",
      'if [ "$last_argument" = "${FAIL_READ_PATH:-}" ]; then',
      '    echo "simulated owner metadata read failure" >&2',
      "    exit 5",
      "fi",
      'exec /bin/cat "$@"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  return {
    commandRoot,
    fixtureRoot,
    helper,
    lockPath,
    lockRoot,
    projectId,
    readyPath,
    releasePath,
    reloadLog,
    runtimeRoot,
    shellWaitPath,
  };
}

const gitSafetyArgs = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgSign=false",
];

function isolatedArgs(
  workdir,
  container,
  launcher,
  executable,
  args = [],
  environment = {},
) {
  return [
    "exec",
    "--env",
    "TMP=/tmp/bb-runtime-env_abc123",
    "--env",
    "TEMP=/tmp/bb-runtime-env_abc123",
    "--env",
    "TMPDIR=/tmp/bb-runtime-env_abc123",
    "--env",
    "GOCACHE=/var/tmp/bb-runtime-go-cache-env_abc123",
    ...Object.entries(environment).flatMap(([name, value]) => [
      "--env",
      `${name}=${value}`,
    ]),
    "--workdir",
    workdir,
    container,
    launcher,
    "--workspace",
    "/bb-worktrees/env_abc123/platform",
    "--scratch",
    "/var/tmp/bb-runtime-go-cache-env_abc123",
    "--scratch",
    "/var/tmp/bb-runtime-go-mod-env_abc123",
    "--scratch",
    "/var/tmp/bb-runtime-ttsc-cache-env_abc123",
    "--scratch",
    "/tmp/bb-runtime-env_abc123",
    "--scratch",
    "/var/tmp/bb-runtime-env_abc123",
    "--scratch",
    "/dev/shm/bb-runtime-env_abc123",
    "--",
    executable,
    ...args,
  ];
}

function context(overrides = {}) {
  return {
    projectId: "proj_platform",
    hostId: "host_vairogs",
    environmentId: "env_abc123",
    environmentPath: "/bb/worktrees/env_abc123/platform",
    workspaceProvisionType: "managed-worktree",
    branchName: "bb/example",
    ...overrides,
  };
}

test("maps one direct BB worktree into the shared container mount", () => {
  assert.deepEqual(
    validateWorkspace({
      policy,
      context: context(),
      resolvedEnvironmentPath: "/bb/worktrees/env_abc123/platform",
      resolvedGitCommonDir: "/workspace/platform/.git",
    }),
    {
      branchName: "bb/example",
      containerRoot: "/bb-worktrees/env_abc123/platform",
      environmentId: "env_abc123",
      hostRoot: "/bb/worktrees/env_abc123/platform",
      kind: "managed-worktree",
    },
  );
});

test("maps the primary checkout without pretending it is a worktree", () => {
  const workspace = validateWorkspace({
    policy,
    context: context({
      environmentId: "env_primary",
      environmentPath: "/workspace/platform",
      workspaceProvisionType: "unmanaged",
      branchName: "master",
    }),
    resolvedEnvironmentPath: "/workspace/platform",
    resolvedGitCommonDir: "/workspace/platform/.git",
  });
  assert.equal(workspace.containerRoot, null);
  assert.throws(
    () => buildContainerPlan(policy, workspace, "svelte_format"),
    /isolated managed worktree/i,
  );
});

for (const [name, overrides, resolvedPath, commonDir] of [
  [
    "wrong project",
    { projectId: "proj_other" },
    "/bb/worktrees/env_abc123/platform",
    "/workspace/platform/.git",
  ],
  [
    "wrong host",
    { hostId: "host_other" },
    "/bb/worktrees/env_abc123/platform",
    "/workspace/platform/.git",
  ],
  [
    "missing environment",
    { environmentPath: null },
    "",
    "/workspace/platform/.git",
  ],
  [
    "nested checkout",
    {},
    "/bb/worktrees/env_abc123/platform/nested",
    "/workspace/platform/.git",
  ],
  [
    "sibling checkout",
    {},
    "/bb/worktrees/env_other/platform",
    "/workspace/platform/.git",
  ],
  ["symlink escape", {}, "/private/tmp/platform", "/workspace/platform/.git"],
  [
    "foreign repository",
    {},
    "/bb/worktrees/env_abc123/platform",
    "/private/tmp/other/.git",
  ],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(
      () =>
        validateWorkspace({
          policy,
          context: context(overrides),
          resolvedEnvironmentPath: resolvedPath,
          resolvedGitCommonDir: commonDir,
        }),
      /denied|invalid|missing|mismatch|outside|repository/i,
    );
  });
}

test("builds only fixed Docker exec plans", () => {
  const workspace = validateWorkspace({
    policy,
    context: context(),
    resolvedEnvironmentPath: "/bb/worktrees/env_abc123/platform",
    resolvedGitCommonDir: "/workspace/platform/.git",
  });
  assert.deepEqual(buildContainerPlan(policy, workspace, "symfony_tests"), [
    {
      command: "/usr/local/bin/docker",
      args: isolatedArgs(
        "/bb-worktrees/env_abc123/platform/src/symfony",
        "pform_dev_zts",
        "/workspace/platform/.bb-runtime/landlock-run",
        "bin/run-all",
        [],
        { TEST_TOKEN: "_env_abc123" },
      ),
      rejectNonEmptyStdout: false,
    },
  ]);
  assert.deepEqual(
    buildContainerPlan(policy, workspace, "symfony_unit", {
      target: "valksor/src/Valksor/Component/Redis",
    }),
    [
      {
        command: "/usr/local/bin/docker",
        args: isolatedArgs(
          "/bb-worktrees/env_abc123/platform/src/symfony",
          "pform_dev_zts",
          "/workspace/platform/.bb-runtime/landlock-run",
          "bin/unit",
          ["valksor/src/Valksor/Component/Redis"],
          { TEST_TOKEN: "_env_abc123" },
        ),
        rejectNonEmptyStdout: false,
      },
    ],
  );
  assert.throws(
    () => buildContainerPlan(policy, workspace, "symfony_unit"),
    /symfony_unit requires a target/i,
  );
  assert.throws(
    () =>
      buildContainerPlan(policy, workspace, "symfony_unit", {
        target: "../primary/src/symfony",
      }),
    /target does not match/i,
  );
  assert.throws(
    () =>
      buildContainerPlan(policy, workspace, "go_tests", { target: "valksor" }),
    /go_tests target must be one of/i,
  );
  assert.deepEqual(
    buildContainerPlan(policy, workspace, "go_tests", {
      target: "tracigo_timeline_context_postgres",
    }),
    [
      {
        command: "/bin/bash",
        args: [
          "/workspace/platform/scripts/test-tracigo-integration-postgres.sh",
        ],
        containers: ["go", "symfony"],
        cwd: "/bb/worktrees/env_abc123/platform",
        environment: {
          PRODUCT_E2E_DOCKER_BIN: "/usr/local/bin/docker",
          PRODUCT_E2E_GO_CACHE: "/var/tmp/bb-runtime-go-cache-env_abc123",
          PRODUCT_E2E_GO_ISOLATION_LAUNCHER: "/app/.bb-runtime/landlock-run",
          PRODUCT_E2E_GO_WORKDIR: "/bb-worktrees/env_abc123/platform/src/go",
          PRODUCT_E2E_ISOLATION_WORKSPACE: "/bb-worktrees/env_abc123/platform",
          PRODUCT_E2E_ROOT: "/bb/worktrees/env_abc123/platform",
          PRODUCT_E2E_TMP: "/tmp/bb-runtime-env_abc123",
          PRODUCT_E2E_ZTS_ISOLATION_LAUNCHER:
            "/workspace/platform/.bb-runtime/landlock-run",
          PRODUCT_E2E_ZTS_WORKDIR:
            "/bb-worktrees/env_abc123/platform/src/symfony",
          TRACIGO_IT_PACKAGES:
            "./apps/tracigo.com/internal/features/content/narrativetimeline",
          TRACIGO_IT_PARALLEL: "1",
          TRACIGO_IT_RUN: "^TestListContextEvents",
          TRACIGO_IT_TIMEOUT: "120s",
        },
        rejectNonEmptyStdout: false,
      },
    ],
  );
  const [postgresPlan] = buildContainerPlan(
    productionPolicy,
    workspace,
    "go_tests",
    {
      target: "tracigo_write_through_postgres",
    },
  );
  assert.deepEqual(postgresPlan.containers, ["go", "symfony"]);
  assert.equal(
    postgresPlan.environment.TRACIGO_IT_PACKAGES,
    "./apps/tracigo.com/internal/server ./apps/tracigo.com/internal/writethrough/publication ./apps/tracigo.com/internal/writethrough/reconcile ./apps/tracigo.com/internal/writethrough/typedrepo ./apps/tracigo.com/internal/features/platform/cachepublications ./apps/tracigo.com/internal/features/knowledge/core",
  );
  assert.equal(
    postgresPlan.environment.TRACIGO_IT_RUN,
    "^(TestExecute|TestWriteThrough|TestPostgres|TestRepositoryReadInsideProjectTransaction|TestRepositoryWriteInsideProjectTransaction|TestFactoryRefusesKeyRetirement|TestPublicationSetMigration|TestReconciliationMigration)",
  );
  assert.equal(
    postgresPlan.environment.TRACIGO_REDIS_TEST_PREFIX,
    "bb:env-abc123:write-through:v2",
  );
  assert.throws(
    () => buildContainerPlan(policy, workspace, "docker_run"),
    /unsupported operation/i,
  );
  const shellSyntaxPlan = buildContainerPlan(policy, workspace, "shell_syntax");
  assert.equal(shellSyntaxPlan.length, 5);
  assert.deepEqual(
    shellSyntaxPlan.map((invocation) => invocation.args.at(-3)),
    ["bash", "bash", "bash", "bash", "bash"],
  );
  assert.deepEqual(
    shellSyntaxPlan.map((invocation) => invocation.args.at(-2)),
    ["-n", "-n", "-n", "-n", "-n"],
  );
  assert.deepEqual(
    shellSyntaxPlan.map((invocation) => invocation.args.at(-1)),
    [
      "scripts/dev.sh",
      "scripts/stop.sh",
      "scripts/lib/primary-checkout.sh",
      "scripts/test-tracigo-integration-postgres.sh",
      "scripts/tests/test-extracted-products-absent.sh",
    ],
  );
  assert.throws(
    () =>
      buildContainerPlan(policy, workspace, "shell_syntax", { target: "x" }),
    /does not accept a target/i,
  );
  assert.throws(
    () =>
      buildContainerPlan(policy, workspace, "symfony_tests", { target: "x" }),
    /does not accept a target/i,
  );
});

test("applies fixed invocation environment without a shell", async () => {
  const result = await runInvocation({
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write(process.env.BB_RUNTIME_TEST_VALUE ?? '')",
    ],
    environment: { BB_RUNTIME_TEST_VALUE: "fixed" },
  });
  assert.equal(result.stdout, "fixed");
});

test("builds malicious isolation probes without accepting commands or refs", () => {
  const workspace = validateWorkspace({
    policy,
    context: context(),
    resolvedEnvironmentPath: "/bb/worktrees/env_abc123/platform",
    resolvedGitCommonDir: "/workspace/platform/.git",
  });
  assert.deepEqual(
    buildIsolationSelfTestInvocation(
      policy,
      workspace,
      "/bb-worktrees/env_abc123/platform/.selected/probe",
      "/workspace/platform/.bb-runtime/primary/probe",
      "/bb-worktrees/.sibling/probe",
      "/tmp/bb-runtime-env_other/unchanged.txt",
    ),
    {
      command: "/usr/local/bin/docker",
      args: [
        "exec",
        "--env",
        "TMP=/tmp/bb-runtime-env_abc123",
        "--env",
        "TEMP=/tmp/bb-runtime-env_abc123",
        "--env",
        "TMPDIR=/tmp/bb-runtime-env_abc123",
        "--env",
        "GOCACHE=/var/tmp/bb-runtime-go-cache-env_abc123",
        "--workdir",
        "/bb-worktrees/env_abc123/platform",
        "pform_dev_zts",
        "/workspace/platform/.bb-runtime/landlock-run",
        "--workspace",
        "/bb-worktrees/env_abc123/platform",
        "--scratch",
        "/var/tmp/bb-runtime-go-cache-env_abc123",
        "--scratch",
        "/var/tmp/bb-runtime-go-mod-env_abc123",
        "--scratch",
        "/var/tmp/bb-runtime-ttsc-cache-env_abc123",
        "--scratch",
        "/tmp/bb-runtime-env_abc123",
        "--scratch",
        "/var/tmp/bb-runtime-env_abc123",
        "--scratch",
        "/dev/shm/bb-runtime-env_abc123",
        "--self-test",
        "--allow-write",
        "/bb-worktrees/env_abc123/platform/.selected/probe",
        "--deny-write",
        "/workspace/platform/.bb-runtime/primary/probe",
        "--deny-write",
        "/bb-worktrees/.sibling/probe",
        "--deny-write",
        "/tmp/bb-runtime-env_other/unchanged.txt",
        "--git-workspace",
        "/bb-worktrees/env_abc123/platform",
        "--git-ref",
        "refs/heads/bb/example",
      ],
      rejectNonEmptyStdout: false,
    },
  );
  assert.throws(
    () =>
      buildIsolationSelfTestInvocation(
        policy,
        workspace,
        "relative",
        "/workspace/platform/probe",
        "/bb-worktrees/sibling/probe",
        "/tmp/bb-runtime-env_other/probe",
      ),
    /absolute container path/i,
  );
});

test("pre-commit generators are isolated and fixed", () => {
  const workspace = validateWorkspace({
    policy,
    context: context(),
    resolvedEnvironmentPath: "/bb/worktrees/env_abc123/platform",
    resolvedGitCommonDir: "/workspace/platform/.git",
  });
  const plan = buildPrecommitGenerationPlan(policy, workspace);
  assert.equal(plan.length, 2);
  assert.deepEqual(
    plan.map((entry) => entry.generator.stages.length),
    [1, 7],
  );
  assert.deepEqual(
    buildPrecommitGenerationPlan(policy, workspace, {
      available: new Set(["scripts/generate-components.php"]),
    }).length,
    1,
  );
  assert.deepEqual(
    plan.map(({ invocation }) => invocation.args),
    [
      isolatedArgs(
        "/bb-worktrees/env_abc123/platform",
        "pform_dev_zts",
        "/workspace/platform/.bb-runtime/landlock-run",
        "php",
        ["scripts/generate-components.php", "--modified"],
      ),
      isolatedArgs(
        "/bb-worktrees/env_abc123/platform",
        "pform_dev_zts",
        "/workspace/platform/.bb-runtime/landlock-run",
        "php",
        ["scripts/generate-platform-registry.php"],
      ),
    ],
  );
});

test("full operations are explicit sequences, never shell strings", () => {
  const workspace = validateWorkspace({
    policy,
    context: context(),
    resolvedEnvironmentPath: "/bb/worktrees/env_abc123/platform",
    resolvedGitCommonDir: "/workspace/platform/.git",
  });
  const plan = buildContainerPlan(policy, workspace, "go_full");
  assert.equal(plan.length, 3);
  for (const invocation of plan) {
    assert.equal(typeof invocation.command, "string");
    assert.ok(Array.isArray(invocation.args));
    assert.ok(!invocation.args.includes("sh"));
    assert.ok(!invocation.args.includes("-c"));
  }
  for (const operation of [
    "svelte_format_check",
    "svelte_format",
    "svelte_full",
  ]) {
    const formatter = buildContainerPlan(policy, workspace, operation)[0];
    assert.equal(
      formatter.args.at(-3),
      "/bb-worktrees/env_abc123/platform/src/sveltekit/packages/config/node_modules/.bin/prettier",
    );
    assert.deepEqual(formatter.args.slice(-2), [
      operation === "svelte_format" ? "--write" : "--check",
      ".",
    ]);
    assert.equal(formatter.args.includes("pnpm"), false);
  }
});

test("ttsc checks load the scratch-confined Node copy compatibility", () => {
  const workspace = validateWorkspace({
    policy,
    context: context(),
    resolvedEnvironmentPath: "/bb/worktrees/env_abc123/platform",
    resolvedGitCommonDir: "/workspace/platform/.git",
  });
  for (const operation of ["svelte_check", "svelte_full"]) {
    const invocation = buildContainerPlan(policy, workspace, operation).find(
      (item) => item.args.includes("check"),
    );
    assert.ok(invocation, `${operation} must include a check invocation`);
    assert.ok(
      invocation.args.includes(
        "NODE_OPTIONS=--require=/platform-primary/.bb-runtime/assets/ttsc-isolation-preload.cjs",
      ),
      `${operation} must load the ttsc isolation compatibility preload`,
    );
    assert.ok(
      invocation.args.includes("GOPATH=/var/tmp/bb-runtime-go-mod-env_abc123"),
      `${operation} must keep the ttsc Go module and checksum state in per-worktree scratch`,
    );
    assert.ok(
      invocation.args.includes(
        "TTSC_CACHE_DIR=/var/tmp/bb-runtime-ttsc-cache-env_abc123/ttsc",
      ),
      `${operation} must publish the ttsc plugin cache inside per-worktree scratch`,
    );
    for (const name of ["TEMP", "TMP", "TMPDIR"]) {
      assert.ok(
        invocation.args.includes(
          `${name}=/var/tmp/bb-runtime-ttsc-cache-env_abc123`,
        ),
        `${operation} must keep ttsc temporary files beside its isolated cache`,
      );
    }
  }
});

test("ttsc isolation preload copies source trees into scratch without chmod", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "ttsc-isolation-preload-"));
  const preload = path.join(pluginRoot, "assets/ttsc-isolation-preload.cjs");
  const source = path.join(pluginRoot, "test");
  const destination = path.join(scratch, "copied-test");
  try {
    await execFileAsync(
      process.execPath,
      [
        "--require",
        preload,
        "-e",
        "const fs=require('node:fs');fs.cpSync(process.argv[1],process.argv[2],{recursive:true,filter:(value)=>!value.endsWith('runtime.test.mjs')});fs.chmodSync(process.argv[2],0o700);fs.promises.copyFile(process.argv[3],process.argv[4]).catch((error)=>{console.error(error);process.exitCode=1})",
        source,
        destination,
        path.join(pluginRoot, "src/runtime.mjs"),
        path.join(scratch, "runtime-copy.mjs"),
      ],
      {
        env: {
          ...process.env,
          BB_TTSC_COPY_COMPAT_FORCE: "1",
          TEMP: scratch,
          TMP: scratch,
          TMPDIR: scratch,
        },
      },
    );
    assert.equal((await stat(destination)).isDirectory(), true);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("ttsc isolation preload leaves other Node tools unchanged", async () => {
  const preload = path.join(pluginRoot, "assets/ttsc-isolation-preload.cjs");
  const { stdout } = await execFileAsync(process.execPath, [
    "--require",
    preload,
    "-e",
    "process.stdout.write(require('node:fs').chmodSync.name)",
  ]);
  assert.equal(stdout, "chmodSync");
});

test("Svelte tests confine Node copy compatibility to the selected worktree", () => {
  const workspace = validateWorkspace({
    policy,
    context: context(),
    resolvedEnvironmentPath: "/bb/worktrees/env_abc123/platform",
    resolvedGitCommonDir: "/workspace/platform/.git",
  });
  for (const operation of ["svelte_tests", "svelte_full"]) {
    const invocation = buildContainerPlan(policy, workspace, operation).find(
      (item) => item.args.includes("test"),
    );
    assert.ok(invocation, `${operation} must include a test invocation`);
    assert.ok(
      invocation.args.includes(
        "BB_NODE_COPY_ROOTS=/bb-worktrees/env_abc123/platform/src/sveltekit",
      ),
      `${operation} must limit compatibility copies to the selected Svelte worktree`,
    );
    assert.ok(
      invocation.args.includes("BB_TTSC_COPY_COMPAT_FORCE=1"),
      `${operation} must explicitly enable compatibility for its artifact copier`,
    );
    assert.ok(
      invocation.args.includes(
        "NODE_OPTIONS=--require=/platform-primary/.bb-runtime/assets/ttsc-isolation-preload.cjs",
      ),
      `${operation} must load the Node copy compatibility preload`,
    );
  }
});

test("Go test operations finish within the tool request boundary", () => {
  const testWorkspace = Object.freeze({
    branchName: "bb/example",
    containerRoot: "/bb-worktrees/env_abc123/platform",
    environmentId: "env_abc123",
    hostRoot: "/bb/worktrees/env_abc123/platform",
    kind: "managed-worktree",
  });
  for (const operation of ["go_tests", "go_full"]) {
    const testInvocation = buildContainerPlan(
      policy,
      testWorkspace,
      operation,
    ).find(
      (invocation) =>
        invocation.args.slice(-4).join("\0") ===
        ["go", "test", "-timeout=120s", "./..."].join("\0"),
    );

    assert.ok(
      testInvocation,
      `${operation} must use the bounded Go test command`,
    );
  }
});

test("search accepts ripgrep no-match without weakening other invocations", () => {
  const search = buildSearchInvocation("/tmp/platform-worktree", {
    query: "cowriting.chapter_generate",
  });

  assert.equal(_testing.invocationExitIsAccepted(search, 0, null), true);
  assert.equal(_testing.invocationExitIsAccepted(search, 1, null), true);
  assert.equal(_testing.invocationExitIsAccepted(search, 2, null), false);
  assert.equal(
    _testing.invocationExitIsAccepted(search, null, "SIGTERM"),
    false,
  );
  assert.equal(
    _testing.invocationExitIsAccepted(
      { command: "/usr/bin/false", args: [], cwd: "/tmp" },
      1,
      null,
    ),
    false,
  );
});

test("search treats blank paths as the default source root", () => {
  for (const path of ["", " \t "]) {
    const invocation = buildSearchInvocation(
      "/workspace/platform",
      {
        query: "type Router struct",
        path,
      },
      "src",
    );

    assert.equal(invocation.args.at(-1), "src");
    assert.equal(
      buildSearchInvocation("/workspace/platform", {
        query: "x",
        path,
      }).args.at(-1),
      ".",
    );
  }
});

test("search keeps metacharacters literal and confines paths", () => {
  assert.deepEqual(
    buildSearchInvocation("/workspace/platform", {
      query: "needle; docker run --privileged",
      path: "src/symfony",
    }),
    {
      acceptedExitCodes: [0, 1],
      command: "rg",
      args: [
        "--color=never",
        "--line-number",
        "--fixed-strings",
        "--",
        "needle; docker run --privileged",
        "src/symfony",
      ],
      cwd: "/workspace/platform",
    },
  );
  for (const path of ["../outside", "/etc", "src/../../etc", "src\0bad"]) {
    assert.throws(
      () => buildSearchInvocation("/workspace/platform", { query: "x", path }),
      /path/i,
    );
  }
});

test("git operations cannot inject options, paths, or commit control text", () => {
  assert.deepEqual(
    buildGitInvocation("/workspace/platform", { operation: "status" }),
    {
      command: "git",
      args: [...gitSafetyArgs, "status", "--short", "--branch"],
      cwd: "/workspace/platform",
    },
  );
  assert.deepEqual(
    buildGitInvocation("/workspace/platform", {
      operation: "add",
      paths: ["src/go/a.go", "src/symfony/a.php"],
    }).args,
    [...gitSafetyArgs, "add", "--", "src/go/a.go", "src/symfony/a.php"],
  );
  for (const paths of [["--all"], ["../outside"], ["src/a\0b"]]) {
    assert.throws(
      () =>
        buildGitInvocation("/workspace/platform", { operation: "add", paths }),
      /path/i,
    );
  }
  for (const message of [
    "",
    "skip\n[skip ci]",
    "x\0y",
    "Co-Authored-By: bot",
  ]) {
    assert.throws(
      () =>
        buildGitInvocation("/workspace/platform", {
          operation: "commit",
          message,
        }),
      /commit message/i,
    );
  }
});

test("git operations use the host-side fixed executor", () => {
  const workspace = validateWorkspace({
    policy,
    context: context(),
    resolvedEnvironmentPath: "/bb/worktrees/env_abc123/platform",
    resolvedGitCommonDir: "/workspace/platform/.git",
  });
  assert.deepEqual(
    buildGitInvocation(workspace.hostRoot, { operation: "status" }),
    {
      command: "git",
      args: [...gitSafetyArgs, "status", "--short", "--branch"],
      cwd: workspace.hostRoot,
    },
  );
});

test("primary landing is a fixed fast-forward of the authorized worktree branch", () => {
  const workspace = validateWorkspace({
    policy,
    context: context(),
    resolvedEnvironmentPath: "/bb/worktrees/env_abc123/platform",
    resolvedGitCommonDir: "/workspace/platform/.git",
  });
  assert.deepEqual(buildFastForwardPrimaryPlan(policy, workspace), [
    {
      command: "git",
      args: [...gitSafetyArgs, "symbolic-ref", "--quiet", "--short", "HEAD"],
      cwd: "/workspace/platform",
    },
    {
      command: "git",
      args: [...gitSafetyArgs, "merge", "--ff-only", "refs/heads/bb/example"],
      cwd: "/workspace/platform",
    },
  ]);
  for (const deniedWorkspace of [
    { ...workspace, kind: "primary" },
    { ...workspace, branchName: "--upload-pack=evil" },
    { ...workspace, branchName: "feature/untrusted" },
    { ...workspace, branchName: "bb/../main" },
  ]) {
    assert.throws(
      () => buildFastForwardPrimaryPlan(policy, deniedWorkspace),
      /denied|managed worktree|branch/i,
    );
  }
});

test("dependency links must resolve to the exact shared-container target", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bb-platform-runtime-test-"));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) =>
      rm(root, { recursive: true, force: true }),
    );
  });

  const accepted = path.join(root, "accepted");
  await ensureContainerSymlink(accepted, "/app/node_modules");
  await ensureContainerSymlink(accepted, "/app/node_modules");

  const wrong = path.join(root, "wrong");
  await symlink("/etc", wrong, "dir");
  await assert.rejects(
    ensureContainerSymlink(wrong, "/app/node_modules"),
    /unexpected target/i,
  );

  const directory = path.join(root, "directory");
  await mkdir(directory);
  await assert.rejects(
    ensureContainerSymlink(directory, "/app/node_modules"),
    /not a symbolic link/i,
  );
});

test("worktree dependency prep keeps root tool caches off the shared install", async (t) => {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "platform-dependency-mirror-"),
  );
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const primaryRoot = path.join(fixtureRoot, "primary");
  const worktreeRoot = path.join(fixtureRoot, "worktree");
  const primaryModules = path.join(primaryRoot, "src/sveltekit/node_modules");
  const worktreeModules = path.join(worktreeRoot, "src/sveltekit/node_modules");
  await mkdir(path.join(primaryModules, "@playwright"), { recursive: true });
  await mkdir(path.join(primaryRoot, "src/sveltekit/apps"), {
    recursive: true,
  });
  await mkdir(path.join(primaryRoot, "src/sveltekit/packages"), {
    recursive: true,
  });
  await mkdir(path.dirname(worktreeModules), { recursive: true });
  await symlink("/app/node_modules", worktreeModules, "dir");

  await prepareWorktreeDependencies(
    { ...policy, primaryRoot },
    { ...context(), hostRoot: worktreeRoot, kind: "managed-worktree" },
  );

  assert.equal((await lstat(worktreeModules)).isDirectory(), true);
  assert.equal(
    await readlink(path.join(worktreeModules, "@playwright")),
    "/app/node_modules/@playwright",
  );
  const taskState = path.join(worktreeModules, ".pnpm-task-run-state-v1");
  await mkdir(taskState, { recursive: true });
  await writeFile(path.join(taskState, "latest.json"), "{}\n");
  assert.equal(
    await readFile(path.join(taskState, "latest.json"), "utf8"),
    "{}\n",
  );

  const toolCache = path.join(worktreeModules, ".cache");
  assert.equal((await lstat(toolCache)).isDirectory(), true);
  assert.equal((await lstat(toolCache)).isSymbolicLink(), false);
  await writeFile(
    path.join(toolCache, "ttsc-lint-config.mjs"),
    "export default {}\n",
  );
});

test("worktree package dependency mirrors keep Vite caches writable and dependencies shared", async (t) => {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "platform-package-mirror-"),
  );
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const primaryRoot = path.join(fixtureRoot, "primary");
  const worktreeRoot = path.join(fixtureRoot, "worktree");
  const primaryModules = path.join(primaryRoot, "src/sveltekit/node_modules");
  const primaryPackageModules = path.join(
    primaryRoot,
    "src/sveltekit/packages/api-client/node_modules",
  );
  const worktreePackageModules = path.join(
    worktreeRoot,
    "src/sveltekit/packages/api-client/node_modules",
  );

  await mkdir(primaryModules, { recursive: true });
  await mkdir(path.join(primaryPackageModules, "vitest"), { recursive: true });
  await mkdir(path.join(primaryPackageModules, ".vite"), { recursive: true });
  await mkdir(path.join(primaryPackageModules, ".vite-temp"), {
    recursive: true,
  });
  await mkdir(path.join(primaryRoot, "src/sveltekit/apps"), {
    recursive: true,
  });
  await mkdir(path.dirname(worktreePackageModules), { recursive: true });
  await symlink(
    "/app/packages/api-client/node_modules",
    worktreePackageModules,
    "dir",
  );

  await prepareWorktreeDependencies(
    { ...policy, primaryRoot },
    { ...context(), hostRoot: worktreeRoot, kind: "managed-worktree" },
  );

  assert.equal((await lstat(worktreePackageModules)).isDirectory(), true);
  assert.equal(
    await readlink(path.join(worktreePackageModules, "vitest")),
    "/app/packages/api-client/node_modules/vitest",
  );
  for (const cacheName of [".vite", ".vite-temp"]) {
    const cachePath = path.join(worktreePackageModules, cacheName);
    assert.equal((await lstat(cachePath)).isDirectory(), true);
    assert.equal((await lstat(cachePath)).isSymbolicLink(), false);
    await writeFile(path.join(cachePath, "config.mjs"), "export default {}\n");
  }
});

test("worktree app dependency mirrors keep the generated SvelteKit package writable", async (t) => {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "platform-app-mirror-"),
  );
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const primaryRoot = path.join(fixtureRoot, "primary");
  const worktreeRoot = path.join(fixtureRoot, "worktree");
  const primaryModules = path.join(primaryRoot, "src/sveltekit/node_modules");
  const primaryAppModules = path.join(
    primaryRoot,
    "src/sveltekit/apps/tracigo.com/node_modules",
  );
  const worktreeAppModules = path.join(
    worktreeRoot,
    "src/sveltekit/apps/tracigo.com/node_modules",
  );

  await mkdir(primaryModules, { recursive: true });
  await mkdir(path.join(primaryAppModules, "svelte"), { recursive: true });
  await mkdir(path.join(primaryAppModules, "$app"), { recursive: true });
  await mkdir(path.join(primaryRoot, "src/sveltekit/packages"), {
    recursive: true,
  });
  await mkdir(path.dirname(worktreeAppModules), { recursive: true });
  await symlink(
    "/app/apps/tracigo.com/node_modules",
    worktreeAppModules,
    "dir",
  );

  await prepareWorktreeDependencies(
    { ...policy, primaryRoot },
    { ...context(), hostRoot: worktreeRoot, kind: "managed-worktree" },
  );

  assert.equal(
    await readlink(path.join(worktreeAppModules, "svelte")),
    "/app/apps/tracigo.com/node_modules/svelte",
  );
  const generatedPackage = path.join(worktreeAppModules, "$app");
  assert.equal((await lstat(generatedPackage)).isDirectory(), true);
  assert.equal((await lstat(generatedPackage)).isSymbolicLink(), false);
  await writeFile(path.join(generatedPackage, "tsconfig.json"), "{}\n");
});

test("exclusive project locks serialize overlapping operations", async () => {
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const lockAdapter = new Map();

  const first = withProjectLock(
    "platform",
    async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    },
    { lockAdapter },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const second = withProjectLock(
    "platform",
    async () => {
      events.push("second:start");
      events.push("second:end");
    },
    { lockAdapter },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
});

test("shared project locks overlap while a queued writer blocks later readers", async () => {
  const events = [];
  let releaseFirst;
  let releaseWriter;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const writerGate = new Promise((resolve) => {
    releaseWriter = resolve;
  });
  const lockAdapter = new Map();
  const waits = [];

  const first = withProjectLock(
    "platform",
    async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    },
    {
      lockAdapter,
      mode: "shared",
      owner: { environmentId: "env_first", operation: "go_tests" },
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const overlapping = withProjectLock(
    "platform",
    async () => {
      events.push("overlapping:start");
      events.push("overlapping:end");
    },
    {
      lockAdapter,
      mode: "shared",
      owner: { environmentId: "env_second", operation: "svelte_tests" },
    },
  );
  await overlapping;
  const writer = withProjectLock(
    "platform",
    async () => {
      events.push("writer:start");
      await writerGate;
      events.push("writer:end");
    },
    {
      label: "shared dependency lock",
      lockAdapter,
      mode: "exclusive",
      onWait: (message) => waits.push(message),
      owner: { environmentId: "env_primary", operation: "ensure" },
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const laterReader = withProjectLock(
    "platform",
    async () => {
      events.push("later:start");
      events.push("later:end");
    },
    {
      lockAdapter,
      mode: "shared",
      owner: { environmentId: "env_third", operation: "go_vet" },
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    "first:start",
    "overlapping:start",
    "overlapping:end",
  ]);
  assert.match(waits[0], /env_first running go_tests since 20/);

  releaseFirst();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.at(-1), "writer:start");
  assert.equal(events.includes("later:start"), false);

  releaseWriter();
  await Promise.all([writer, laterReader]);
  assert.deepEqual(events.slice(-4), [
    "writer:start",
    "writer:end",
    "later:start",
    "later:end",
  ]);
});

test("filesystem project locks allow readers and make lifecycle contention visible", async (t) => {
  const lockRoot = await mkdtemp(path.join(tmpdir(), "platform-rw-lock-"));
  t.after(() => rm(lockRoot, { recursive: true, force: true }));
  const events = [];
  let markFirstStarted;
  let releaseFirst;
  let markWaitReported;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const waitReported = new Promise((resolve) => {
    markWaitReported = resolve;
  });

  const first = withProjectLock(
    "filesystem-rw",
    async () => {
      events.push("first:start");
      markFirstStarted();
      await firstGate;
      events.push("first:end");
    },
    {
      lockRoot,
      mode: "shared",
      owner: { environmentId: "env_reader", operation: "go_tests" },
    },
  );
  await firstStarted;
  const readerDirectory = path.join(lockRoot, "filesystem-rw.lock", "readers");
  const readerNames = await readdir(readerDirectory);
  assert.equal(readerNames.length, 1);
  const readerOwner = JSON.parse(
    await readFile(path.join(readerDirectory, readerNames[0]), "utf8"),
  );
  assert.equal(
    readerOwner.processIdentity,
    await _testing.readProcessIdentity(readerOwner.pid),
  );
  await withProjectLock(
    "filesystem-rw",
    async () => {
      events.push("second:start");
      events.push("second:end");
    },
    {
      lockRoot,
      mode: "shared",
      owner: { environmentId: "env_second", operation: "svelte_tests" },
    },
  );
  const writer = withProjectLock(
    "filesystem-rw",
    async () => {
      events.push("writer");
    },
    {
      label: "shared dependency lock",
      lockRoot,
      mode: "exclusive",
      onWait: (message) => markWaitReported(message),
      owner: { environmentId: "primary", operation: "ensure" },
    },
  );
  const waitMessage = await waitReported;
  assert.match(waitMessage, /env_reader running go_tests since 20/);
  assert.equal(events.includes("writer"), false);

  releaseFirst();
  await Promise.all([first, writer]);
  assert.deepEqual(events, [
    "first:start",
    "second:start",
    "second:end",
    "first:end",
    "writer",
  ]);
  await assert.rejects(
    lstat(path.join(lockRoot, "filesystem-rw.lock")),
    (error) => error?.code === "ENOENT",
  );
});

test("filesystem project locks replace an ownerless state directory", async (t) => {
  const lockRoot = await mkdtemp(
    path.join(tmpdir(), "platform-ownerless-state-"),
  );
  const lockPath = path.join(lockRoot, "ownerless-state.lock");
  t.after(() => rm(lockRoot, { recursive: true, force: true }));
  await mkdir(lockPath);

  let executed = false;
  await withProjectLock(
    "ownerless-state",
    async () => {
      executed = true;
    },
    {
      lockRoot,
      owner: { environmentId: "env_recovery", operation: "runtime_tests" },
      signal: AbortSignal.timeout(10_000),
    },
  );

  assert.equal(executed, true);
  await assert.rejects(lstat(lockPath), (error) => error?.code === "ENOENT");
});

test("filesystem project locks replace an ownerless state gate", async (t) => {
  const lockRoot = await mkdtemp(
    path.join(tmpdir(), "platform-ownerless-gate-"),
  );
  const lockPath = path.join(lockRoot, "ownerless-gate.lock");
  t.after(() => rm(lockRoot, { recursive: true, force: true }));
  await mkdir(path.join(lockPath, "readers"), { recursive: true });
  await mkdir(path.join(lockPath, "writers"));
  await writeFile(path.join(lockPath, "rw.json"), '{"version":1}\n');
  await mkdir(path.join(lockPath, "gate.lock"));

  let executed = false;
  await withProjectLock(
    "ownerless-gate",
    async () => {
      executed = true;
    },
    {
      lockRoot,
      owner: { environmentId: "env_recovery", operation: "runtime_tests" },
      signal: AbortSignal.timeout(10_000),
    },
  );

  assert.equal(executed, true);
  await assert.rejects(lstat(lockPath), (error) => error?.code === "ENOENT");
});

test("stale claim recovery cannot unlink an ABA replacement", async (t) => {
  const lockRoot = await mkdtemp(path.join(tmpdir(), "platform-claim-aba-"));
  const claimPath = path.join(lockRoot, "state.lock.owner.json");
  t.after(() => rm(lockRoot, { recursive: true, force: true }));
  await writeFile(
    claimPath,
    `${JSON.stringify({
      createdAt: 1,
      id: "stale-claim",
      pid: 2_147_483_647,
      processIdentity: "stale",
    })}\n`,
  );
  const stale = await _testing.inspectOwnerClaim(claimPath);
  let releaseRecovery;
  let markStaleRemoved;
  const holdRecovery = new Promise((resolve) => {
    releaseRecovery = resolve;
  });
  const staleRemoved = new Promise((resolve) => {
    markStaleRemoved = resolve;
  });
  const recovery = _testing.recoverOwnerClaim(claimPath, stale, {
    async afterRemove() {
      markStaleRemoved();
      await holdRecovery;
    },
  });
  await staleRemoved;

  const replacement = await _testing.installOwnerClaim(claimPath);
  assert.notEqual(replacement, null);
  assert.equal(await _testing.recoverOwnerClaim(claimPath, stale), false);
  releaseRecovery();
  assert.equal(await recovery, true);

  const current = await _testing.inspectOwnerClaim(claimPath);
  assert.deepEqual(current.identity, replacement.identity);
  assert.equal(await _testing.recoverOwnerClaim(claimPath, replacement), true);
});

test("stale claim recovery discards an abandoned recovery contender", async (t) => {
  const lockRoot = await mkdtemp(
    path.join(tmpdir(), "platform-claim-recovery-"),
  );
  const claimPath = path.join(lockRoot, "state.lock.owner.json");
  t.after(() => rm(lockRoot, { recursive: true, force: true }));
  await writeFile(
    claimPath,
    `${JSON.stringify({
      createdAt: 1,
      id: "abandoned-recovery",
      pid: 2_147_483_647,
      processIdentity: "stale",
    })}\n`,
  );
  const stale = await _testing.inspectOwnerClaim(claimPath);
  const recoveryPath = `${claimPath}.recover-${stale.identity.device}-${stale.identity.inode}-abandoned`;
  await writeFile(
    recoveryPath,
    `${JSON.stringify({
      createdAt: 1,
      id: "dead-recoverer",
      pid: 2_147_483_647,
      processIdentity: "stale",
    })}\n`,
  );

  assert.equal(await _testing.recoverOwnerClaim(claimPath, stale), true);
  await assert.rejects(
    lstat(recoveryPath),
    (error) => error?.code === "ENOENT",
  );
  await assert.rejects(lstat(claimPath), (error) => error?.code === "ENOENT");
});

test("stale claim recovery preserves a live recovery contender", async (t) => {
  const lockRoot = await mkdtemp(
    path.join(tmpdir(), "platform-live-recovery-"),
  );
  const claimPath = path.join(lockRoot, "state.lock.owner.json");
  t.after(() => rm(lockRoot, { recursive: true, force: true }));
  await writeFile(
    claimPath,
    `${JSON.stringify({
      createdAt: 1,
      id: "stale-claim",
      pid: 2_147_483_647,
      processIdentity: "stale",
    })}\n`,
  );
  const stale = await _testing.inspectOwnerClaim(claimPath);
  const recoveryPath = `${claimPath}.recover-${stale.identity.device}-${stale.identity.inode}-live`;
  await writeFile(
    recoveryPath,
    `${JSON.stringify({
      createdAt: 1,
      id: "live-recoverer",
      pid: process.pid,
      processIdentity: await _testing.readProcessIdentity(process.pid),
    })}\n`,
  );

  await _testing.scavengeInitializationDebris(lockRoot, Date.now() + 1_000);
  await lstat(recoveryPath);
  assert.equal(await _testing.recoverOwnerClaim(claimPath, stale), false);
  await lstat(claimPath);
  await lstat(recoveryPath);

  await rm(recoveryPath);
  assert.equal(await _testing.recoverOwnerClaim(claimPath, stale), true);
});

test("concurrent stale claim recovery elects one remover", async (t) => {
  const lockRoot = await mkdtemp(
    path.join(tmpdir(), "platform-recovery-election-"),
  );
  const claimPath = path.join(lockRoot, "state.lock.owner.json");
  t.after(() => rm(lockRoot, { recursive: true, force: true }));
  await writeFile(
    claimPath,
    `${JSON.stringify({
      createdAt: 1,
      id: "stale-election",
      pid: 2_147_483_647,
      processIdentity: "stale",
    })}\n`,
  );
  const stale = await _testing.inspectOwnerClaim(claimPath);

  const results = await Promise.all([
    _testing.recoverOwnerClaim(claimPath, stale),
    _testing.recoverOwnerClaim(claimPath, stale),
  ]);

  assert.deepEqual(results.toSorted(), [false, true]);
  await assert.rejects(lstat(claimPath), (error) => error?.code === "ENOENT");
});

test("claim recovery rejects a reused live pid", async (t) => {
  const lockRoot = await mkdtemp(path.join(tmpdir(), "platform-reused-pid-"));
  const claimPath = path.join(lockRoot, "reused-pid.lock.owner.json");
  t.after(() => rm(lockRoot, { recursive: true, force: true }));
  await writeFile(
    claimPath,
    `${JSON.stringify({ createdAt: 1, id: "pre-restart", pid: process.pid })}\n`,
  );

  let executed = false;
  await withProjectLock(
    "reused-pid",
    async () => {
      executed = true;
    },
    {
      lockRoot,
      signal: AbortSignal.timeout(10_000),
    },
  );

  assert.equal(executed, true);
});

test("filesystem lock setup scavenges abandoned initialization debris", async (t) => {
  const lockRoot = await mkdtemp(path.join(tmpdir(), "platform-init-debris-"));
  const debrisPath = path.join(lockRoot, ".orphan.lock.init-abandoned");
  const retiredPath = path.join(lockRoot, "orphan.lock.retired-abandoned");
  t.after(() => rm(lockRoot, { recursive: true, force: true }));
  await mkdir(debrisPath);
  await mkdir(retiredPath);

  await _testing.scavengeInitializationDebris(lockRoot, Date.now() + 1_000);

  await assert.rejects(lstat(debrisPath), (error) => error?.code === "ENOENT");
  await assert.rejects(lstat(retiredPath), (error) => error?.code === "ENOENT");
});

test("new state setup waits for a live legacy ownerless publisher", async (t) => {
  const lockRoot = await mkdtemp(path.join(tmpdir(), "platform-legacy-state-"));
  const lockPath = path.join(lockRoot, "legacy-state.lock");
  const claimPath = `${lockPath}.owner.json`;
  t.after(() => rm(lockRoot, { recursive: true, force: true }));
  await mkdir(lockPath);

  let executed = false;
  const operation = withProjectLock(
    "legacy-state",
    async () => {
      executed = true;
    },
    {
      lockRoot,
      signal: AbortSignal.timeout(10_000),
    },
  );
  await waitForFixturePath(claimPath);
  await writeFile(path.join(lockPath, "owner.json"), "{\n");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(executed, false);
  await writeFile(
    path.join(lockPath, "owner.json"),
    `${JSON.stringify({ createdAt: Date.now(), pid: process.pid })}\n`,
  );
  await waitForFixturePathRemoval(claimPath);

  assert.equal(executed, false);
  await retireFixtureDirectory(lockPath);
  await operation;
  assert.equal(executed, true);
});

test("new gate setup waits for a live legacy ownerless publisher", async (t) => {
  const lockRoot = await mkdtemp(path.join(tmpdir(), "platform-legacy-gate-"));
  const lockPath = path.join(lockRoot, "legacy-gate.lock");
  const gatePath = path.join(lockPath, "gate.lock");
  const claimPath = `${gatePath}.owner.json`;
  t.after(() => rm(lockRoot, { recursive: true, force: true }));
  await mkdir(path.join(lockPath, "readers"), { recursive: true });
  await mkdir(path.join(lockPath, "writers"));
  await writeFile(path.join(lockPath, "rw.json"), '{"version":1}\n');
  await mkdir(gatePath);

  let executed = false;
  const operation = withProjectLock(
    "legacy-gate",
    async () => {
      executed = true;
    },
    {
      lockRoot,
      signal: AbortSignal.timeout(10_000),
    },
  );
  await waitForFixturePath(claimPath);
  await writeFile(path.join(gatePath, "owner.json"), "{\n");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(executed, false);
  await writeFile(
    path.join(gatePath, "owner.json"),
    `${JSON.stringify({ createdAt: Date.now(), pid: process.pid })}\n`,
  );
  await waitForFixturePathRemoval(claimPath);

  assert.equal(executed, false);
  await retireFixtureDirectory(gatePath);
  await operation;
  assert.equal(executed, true);
});

test("stale state claim recovery preserves a live legacy owner", async (t) => {
  const lockRoot = await mkdtemp(
    path.join(tmpdir(), "platform-stale-state-claim-"),
  );
  const lockPath = path.join(lockRoot, "stale-state-claim.lock");
  t.after(() => rm(lockRoot, { recursive: true, force: true }));
  await mkdir(lockPath);
  await writeFile(
    path.join(lockPath, "owner.json"),
    `${JSON.stringify({ createdAt: Date.now(), pid: process.pid })}\n`,
  );
  await writeFile(
    `${lockPath}.owner.json`,
    `${JSON.stringify({ createdAt: 1, id: "stale", pid: 2_147_483_647 })}\n`,
  );
  let reportWait;
  const waitReported = new Promise((resolve) => {
    reportWait = resolve;
  });
  let executed = false;
  const operation = withProjectLock(
    "stale-state-claim",
    async () => {
      executed = true;
    },
    {
      lockRoot,
      onWait: reportWait,
      signal: AbortSignal.timeout(10_000),
    },
  );

  await waitForFixtureSignal(waitReported, "live legacy state owner wait");
  assert.equal(executed, false);
  await retireFixtureDirectory(lockPath);
  await operation;
  assert.equal(executed, true);
});

test("stale gate claim recovery preserves a live legacy owner", async (t) => {
  const lockRoot = await mkdtemp(
    path.join(tmpdir(), "platform-stale-gate-claim-"),
  );
  const lockPath = path.join(lockRoot, "stale-gate-claim.lock");
  const gatePath = path.join(lockPath, "gate.lock");
  t.after(() => rm(lockRoot, { recursive: true, force: true }));
  await mkdir(path.join(lockPath, "readers"), { recursive: true });
  await mkdir(path.join(lockPath, "writers"));
  await writeFile(path.join(lockPath, "rw.json"), '{"version":1}\n');
  await mkdir(gatePath);
  await writeFile(
    path.join(gatePath, "owner.json"),
    `${JSON.stringify({ createdAt: Date.now(), pid: process.pid })}\n`,
  );
  await writeFile(
    `${gatePath}.owner.json`,
    `${JSON.stringify({ createdAt: 1, id: "stale", pid: 2_147_483_647 })}\n`,
  );
  let executed = false;
  const operation = withProjectLock(
    "stale-gate-claim",
    async () => {
      executed = true;
    },
    {
      lockRoot,
      signal: AbortSignal.timeout(20_000),
    },
  );

  await waitForClaimReplacement(`${gatePath}.owner.json`, "stale");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(executed, false);
  await lstat(path.join(gatePath, "owner.json"));
  await retireFixtureDirectory(gatePath);
  await operation;
  assert.equal(executed, true);
});

test("JavaScript retries when the gate parent retires after claiming", async (t) => {
  const lockRoot = await mkdtemp(
    path.join(tmpdir(), "platform-retired-gate-parent-"),
  );
  const lockPath = path.join(lockRoot, "retired-gate-parent.lock");
  const gatePath = path.join(lockPath, "gate.lock");
  t.after(() => rm(lockRoot, { recursive: true, force: true }));
  await mkdir(path.join(lockPath, "readers"), { recursive: true });
  await mkdir(path.join(lockPath, "writers"));
  await writeFile(path.join(lockPath, "rw.json"), '{"version":1}\n');
  await mkdir(gatePath);
  let executed = false;
  const operation = withProjectLock(
    "retired-gate-parent",
    async () => {
      executed = true;
    },
    {
      lockRoot,
      signal: AbortSignal.timeout(10_000),
    },
  );

  await waitForFixturePath(`${gatePath}.owner.json`);
  await retireFixtureDirectory(lockPath);
  await operation;

  assert.equal(executed, true);
});

test("quality operations overlap across worktrees but serialize within one worktree", async () => {
  const lockAdapter = new Map();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const workspaceA = {
    containerRoot: "/bb-worktrees/env_a/platform",
    environmentId: "env_a",
    hostRoot: "/bb/worktrees/env_a/platform",
    kind: "managed-worktree",
  };
  const workspaceB = {
    ...workspaceA,
    containerRoot: "/bb-worktrees/env_b/platform",
    environmentId: "env_b",
    hostRoot: "/bb/worktrees/env_b/platform",
  };
  const first = _testing.withQualityOperationLocks(
    policy,
    workspaceA,
    "go_tests",
    async () => {
      events.push("a:first:start");
      await firstGate;
      events.push("a:first:end");
    },
    { lockAdapter },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const otherWorktree = _testing.withQualityOperationLocks(
    policy,
    workspaceB,
    "svelte_check",
    async () => {
      events.push("b:start");
      events.push("b:end");
    },
    { lockAdapter },
  );
  const sameWorktree = _testing.withQualityOperationLocks(
    policy,
    workspaceA,
    "go_vet",
    async () => {
      events.push("a:second:start");
      events.push("a:second:end");
    },
    { lockAdapter, onLockWait: () => {} },
  );
  await otherWorktree;
  assert.deepEqual(events, ["a:first:start", "b:start", "b:end"]);

  releaseFirst();
  await Promise.all([first, sameWorktree]);
  assert.deepEqual(events.slice(-3), [
    "a:first:end",
    "a:second:start",
    "a:second:end",
  ]);
});

test("lifecycle writers wait for quality readers while runtime status stays lock-free", async () => {
  const lockAdapter = new Map();
  const events = [];
  const waits = [];
  let releaseQuality;
  const qualityGate = new Promise((resolve) => {
    releaseQuality = resolve;
  });
  const workspace = {
    containerRoot: "/bb-worktrees/env_quality/platform",
    environmentId: "env_quality",
    hostRoot: "/bb/worktrees/env_quality/platform",
    kind: "managed-worktree",
  };
  const quality = _testing.withQualityOperationLocks(
    policy,
    workspace,
    "svelte_check",
    async () => {
      events.push("quality:start");
      await qualityGate;
      events.push("quality:end");
    },
    { lockAdapter },
  );
  await new Promise((resolve) => setImmediate(resolve));

  await executeRuntimeOperation(policy, workspace, "status", {
    lockAdapter,
    readFile: async () => {
      const error = new Error("missing reload status");
      error.code = "ENOENT";
      throw error;
    },
    run: async () => {
      events.push("status");
      return { stdout: "healthy\n", stderr: "" };
    },
  });
  const ensure = executeRuntimeOperation(policy, workspace, "ensure", {
    lockAdapter,
    onLockWait: (message) => waits.push(message),
    run: async () => {
      events.push("ensure");
      return { stdout: "ensured\n", stderr: "" };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["quality:start", "status"]);
  assert.match(waits[0], /env_quality running svelte_check since 20/);

  releaseQuality();
  const [, ensureResults] = await Promise.all([quality, ensure]);
  assert.deepEqual(events, [
    "quality:start",
    "status",
    "quality:end",
    "ensure",
  ]);
  assert.match(
    formatResults(ensureResults),
    /env_quality running svelte_check since 20/,
  );
});

test("git operations serialize within one worktree", async () => {
  const workspace = validateWorkspace({
    policy,
    context: context(),
    resolvedEnvironmentPath: "/bb/worktrees/env_abc123/platform",
    resolvedGitCommonDir: "/workspace/platform/.git",
  });
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const lockAdapter = new Map();
  let invocation = 0;
  const invocations = [];
  const run = async (gitInvocation) => {
    invocations.push(gitInvocation);
    invocation += 1;
    const current = invocation;
    events.push(`${current}:start`);
    if (current === 1) {
      await firstGate;
    }
    events.push(`${current}:end`);
    return { code: 0, signal: null, stdout: "", stderr: "", overflow: false };
  };

  const first = executeGit(
    policy,
    workspace,
    { operation: "status" },
    { run, lockAdapter },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const second = executeGit(
    policy,
    workspace,
    { operation: "status" },
    {
      run,
      lockAdapter,
      onLockWait: () => {},
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["1:start"]);
  releaseFirst();
  const [, secondResults] = await Promise.all([first, second]);
  assert.deepEqual(events, ["1:start", "1:end", "2:start", "2:end"]);
  assert.match(
    formatResults(secondResults),
    /worktree operation lock held by env_abc123/,
  );
  assert.deepEqual(
    invocations.map(({ command }) => command),
    ["git", "git"],
  );
  assert.deepEqual(
    invocations.map(({ cwd }) => cwd),
    [workspace.hostRoot, workspace.hostRoot],
  );
});

test("agent tools are selected only for the authorized project and machine", () => {
  const allowed = buildAgentConfiguration(registry, {
    thread: { id: "thr_allowed" },
    project: { id: "proj_platform" },
    host: { id: "host_vairogs" },
    environment: {
      id: "env_abc123",
      path: "/bb/worktrees/env_abc123/platform",
      workspaceProvisionType: "managed-worktree",
      branchName: "bb/example",
    },
  });
  assert.deepEqual(allowed.tools, [
    "runtime_container",
    "runtime_git",
    "runtime_skill_resource",
    "runtime_ops",
    "runtime_search",
    "runtime_thread",
    "platform_container",
    "platform_git",
    "platform_plugin_resource",
    "platform_runtime",
    "platform_search",
    "platform_thread",
  ]);
  assert.deepEqual(Object.values(RUNTIME_TOOL_ALIASES), allowed.tools.slice(6));
  assert.equal(allowed.context.projectId, "proj_platform");

  const instructions = buildAgentInstructions(policy);
  assert.match(instructions, /Provider lifecycle hooks/);
  assert.match(instructions, /configured MCP or plugin servers/);
  assert.match(instructions, /may spawn host child processes/);
  assert.match(instructions, /ordinary capability model/);
  assert.match(instructions, /Normal Git and the host bb CLI remain available/);
  assert.match(instructions, /Never push, tag, force-update, reset, delete/);
  assert.match(instructions, /Installed agent skills are agent-wide/);
  assert.match(instructions, /runtime_skill_resource/);
  assert.match(instructions, /symfony_unit \(requires target matching/);
  assert.match(instructions, /isolation_self_test/);
  assert.match(instructions, /optional bounded reader/);
  assert.match(instructions, /runtime_ops/);
  assert.match(
    buildAgentInstructions({ ...policy, manifestStale: true }),
    /manifest changed after installation/,
  );
  assert.doesNotMatch(
    instructions,
    /direct Git.*prohibit|host bb CLI.*restrict/i,
  );
  assert.doesNotMatch(instructions, /docker run/);

  const withCodeGraph = buildAgentConfiguration(
    registryFor({
      ...policy,
      codegraphCommand: "/opt/codegraph/bin/codegraph",
    }),
    {
      thread: { id: "thr_codegraph" },
      project: { id: "proj_platform" },
      host: { id: "host_vairogs" },
      environment: {
        id: "env_abc123",
        path: "/bb/worktrees/env_abc123/platform",
        workspaceProvisionType: "managed-worktree",
        branchName: "bb/example",
      },
    },
  );
  assert.deepEqual(withCodeGraph.tools.slice(-CODEGRAPH_TOOL_NAMES.length), [
    ...CODEGRAPH_TOOL_NAMES,
  ]);
  assert.deepEqual(CODEGRAPH_TOOL_NAMES, BRIDGED_CODEGRAPH_TOOL_NAMES);

  for (const [projectId, hostId] of [
    ["proj_other", "host_vairogs"],
    ["proj_platform", "host_other"],
  ]) {
    const denied = buildAgentConfiguration(registry, {
      thread: { id: "thr_denied" },
      project: { id: projectId },
      host: { id: hostId },
      environment: {
        id: "env_abc123",
        path: "/bb/worktrees/env_abc123/platform",
        workspaceProvisionType: "managed-worktree",
        branchName: "bb/example",
      },
    });
    assert.deepEqual(denied.tools, []);
    assert.equal(denied.context, null);
  }
});

test("agent context is rehydrated after a plugin reload", async () => {
  const calls = [];
  const sdk = {
    threads: {
      async get(input) {
        calls.push(["thread", input]);
        return {
          id: input.threadId,
          projectId: "proj_platform",
          environmentId: "env_abc123",
        };
      },
    },
    environments: {
      async get(input) {
        calls.push(["environment", input]);
        return {
          id: input.environmentId,
          projectId: "proj_platform",
          hostId: "host_vairogs",
          path: "/bb/worktrees/env_abc123/platform",
          workspaceProvisionType: "managed-worktree",
          branchName: "bb/example",
        };
      },
    },
  };

  assert.deepEqual(
    await rehydrateAgentContext(registry, sdk, "thr_allowed"),
    context(),
  );
  assert.deepEqual(calls, [
    ["thread", { threadId: "thr_allowed" }],
    ["environment", { environmentId: "env_abc123" }],
  ]);
});

test("agent context rehydration preserves project and host authorization", async () => {
  const sdk = {
    threads: {
      async get() {
        return {
          projectId: "proj_platform",
          environmentId: "env_abc123",
        };
      },
    },
    environments: {
      async get() {
        return {
          id: "env_abc123",
          projectId: "proj_platform",
          hostId: "host_other",
        };
      },
    },
  };

  assert.equal(await rehydrateAgentContext(registry, sdk, "thr_denied"), null);
  assert.equal(await rehydrateAgentContext(registry, sdk, "invalid"), null);
});

test("installed skill resources are readable only below an anchored skill root", async (t) => {
  const fixtureRoot = await realpath(
    await mkdtemp(path.join(tmpdir(), "platform-plugin-resource-")),
  );
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) =>
      rm(fixtureRoot, { recursive: true, force: true }),
    );
  });
  const allowedRoot = path.join(fixtureRoot, "skills");
  const skillRoot = path.join(allowedRoot, "k0d3", "system-design");
  const reference = path.join(skillRoot, "references", "topology.md");
  await mkdir(path.dirname(reference), { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), "# System design\n");
  await writeFile(reference, "trusted topology\n");

  const resource = await readPluginResource(
    { path: reference },
    { allowedRoots: [allowedRoot] },
  );
  assert.equal(resource.content, "trusted topology\n");
  assert.equal(resource.skillRoot, skillRoot);

  const catalogSkill = path.join(
    fixtureRoot,
    ".codex",
    "plugins",
    "cache",
    "valksor-k0d3",
    "k0d3",
    "1.0.0",
    "skills",
    "architecture-essentials",
    "SKILL.md",
  );
  await mkdir(path.dirname(catalogSkill), { recursive: true });
  await writeFile(catalogSkill, "# Architecture essentials\n");
  assert.equal(
    (
      await readPluginResource(
        { path: catalogSkill },
        { homeRoot: fixtureRoot },
      )
    ).content,
    "# Architecture essentials\n",
  );

  const pluginRootSkill = path.join(
    fixtureRoot,
    ".codex",
    "plugins",
    "cache",
    "vendor",
    "plugin",
    "1.0.0",
    "SKILL.md",
  );
  await mkdir(path.dirname(pluginRootSkill), { recursive: true });
  await writeFile(pluginRootSkill, "# Root skill\n");
  assert.equal(
    (
      await readPluginResource(
        { path: pluginRootSkill },
        { homeRoot: fixtureRoot },
      )
    ).content,
    "# Root skill\n",
  );

  const unanchored = path.join(allowedRoot, "not-a-skill", "notes.md");
  await mkdir(path.dirname(unanchored), { recursive: true });
  await writeFile(unanchored, "no marker\n");
  await assert.rejects(
    readPluginResource({ path: unanchored }, { allowedRoots: [allowedRoot] }),
    /not anchored/i,
  );

  const outside = path.join(fixtureRoot, "outside.md");
  await writeFile(outside, "secret\n");
  const escape = path.join(skillRoot, "references", "escape.md");
  await symlink(outside, escape);
  await assert.rejects(
    readPluginResource({ path: escape }, { allowedRoots: [allowedRoot] }),
    /outside installed agent skill roots/i,
  );

  const invalid = path.join(skillRoot, "references", "invalid.txt");
  await writeFile(invalid, Buffer.from([0xff]));
  await assert.rejects(
    readPluginResource({ path: invalid }, { allowedRoots: [allowedRoot] }),
    /valid UTF-8/i,
  );

  const hardLinked = path.join(skillRoot, "references", "hard-linked.md");
  await link(outside, hardLinked);
  await assert.rejects(
    readPluginResource({ path: hardLinked }, { allowedRoots: [allowedRoot] }),
    /bounded regular file/i,
  );
});

test("CodeGraph bridge binds MCP calls to the authorized worktree", async (t) => {
  const fixtureRoot = await realpath(
    await mkdtemp(path.join(tmpdir(), "platform-codegraph-")),
  );
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) =>
      rm(fixtureRoot, { recursive: true, force: true }),
    );
  });
  const codegraphRoot = path.join(fixtureRoot, "codegraph");
  const command = path.join(codegraphRoot, "codegraph.mjs");
  const workspaceRoot = path.join(fixtureRoot, "workspace");
  await mkdir(codegraphRoot, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(
    command,
    `#!/usr/bin/env node
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }) + "\\n");
  } else if (message.method === "tools/call") {
    const result = message.params.name === "codegraph_context"
      ? { isError: true, content: [{ type: "text", text: "Unknown tool codegraph_context" }] }
      : { content: [{ type: "text", text: JSON.stringify(message.params) }] };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
}
`,
    { mode: 0o755 },
  );

  let childEnvironment;
  process.env.BB_PLATFORM_TEST_SECRET = "must-not-reach-codegraph";
  const output = await executeCodeGraphTool(
    { codegraphCommand: command, codegraphRoot },
    { hostRoot: workspaceRoot },
    "codegraph_search",
    { query: "Router", projectPath: "/untrusted" },
    {
      timeoutMs: 5000,
      spawn(...args) {
        childEnvironment = args[2].env;
        return spawnChild(...args);
      },
    },
  );
  delete process.env.BB_PLATFORM_TEST_SECRET;
  const forwarded = JSON.parse(output);
  assert.equal(forwarded.name, "codegraph_search");
  assert.equal(forwarded.arguments.query, "Router");
  assert.equal(forwarded.arguments.projectPath, workspaceRoot);
  assert.equal(childEnvironment.BB_PLATFORM_TEST_SECRET, undefined);
  assert.equal(childEnvironment.CODEGRAPH_MCP_TOOLS.includes("explore"), true);
  assert.equal(childEnvironment.CODEGRAPH_MCP_TOOLS.includes("context"), true);

  const contextOutput = await executeCodeGraphTool(
    { codegraphCommand: command, codegraphRoot },
    { hostRoot: workspaceRoot },
    "codegraph_context",
    { task: "trace router construction", maxNodes: 30 },
    { timeoutMs: 5000 },
  );
  const contextForwarded = JSON.parse(contextOutput);
  assert.equal(contextForwarded.name, "codegraph_explore");
  assert.equal(contextForwarded.arguments.query, "trace router construction");
  assert.equal(contextForwarded.arguments.maxFiles, 3);
  assert.equal(contextForwarded.arguments.projectPath, workspaceRoot);

  await assert.rejects(
    executeCodeGraphTool(
      { codegraphCommand: command, codegraphRoot },
      { hostRoot: workspaceRoot },
      "codegraph_node",
      { file: "../outside" },
      { timeoutMs: 5000 },
    ),
    /escapes the authorized workspace/i,
  );

  await assert.rejects(
    executeCodeGraphTool(
      { codegraphCommand: command, codegraphRoot: workspaceRoot },
      { hostRoot: workspaceRoot },
      "codegraph_search",
      { query: "Router" },
      { timeoutMs: 5000 },
    ),
    /paths changed|denied/i,
  );
});

test("thread read returns bounded same-project output", async () => {
  const calls = [];
  const sdk = {
    threads: {
      async get(input) {
        calls.push(["get", input]);
        return {
          id: input.threadId,
          projectId: "proj_platform",
          title: "Strict chapter plan",
          status: "idle",
          providerId: "codex",
          environmentId: "env_old",
          parentThreadId: null,
          sourceThreadId: null,
          visibility: "visible",
          archivedAt: null,
          updatedAt: 123,
        };
      },
      async output(input) {
        calls.push(["output", input]);
        return { output: "Use strict primary routing." };
      },
    },
  };

  const result = JSON.parse(
    await readProjectThread(policy, sdk, { threadId: "thr_plan123" }),
  );
  assert.deepEqual(calls, [
    ["get", { threadId: "thr_plan123" }],
    ["output", { threadId: "thr_plan123" }],
  ]);
  assert.equal(result.thread.id, "thr_plan123");
  assert.equal(result.thread.providerId, "codex");
  assert.equal(result.output, "Use strict primary routing.");
  assert.equal(result.outputTruncated, false);
});

test("thread read rejects invalid ids and cross-project targets", async () => {
  let outputCalls = 0;
  const sdk = {
    threads: {
      async get({ threadId }) {
        return { id: threadId, projectId: "proj_other" };
      },
      async output() {
        outputCalls += 1;
        return { output: "secret" };
      },
    },
  };

  for (const threadId of [
    "",
    "thr_ok;bb thread list",
    `thr_${"a".repeat(101)}`,
    "other_123",
    null,
  ]) {
    await assert.rejects(
      readProjectThread(policy, sdk, { threadId }),
      /thread id is missing or invalid/i,
    );
  }
  await assert.rejects(
    readProjectThread(policy, sdk, { threadId: "thr_foreign" }),
    /not an authorized visible project thread/i,
  );
  assert.equal(outputCalls, 0);
});

test("thread read rejects hidden same-project targets before reading output", async () => {
  let outputCalls = 0;
  const sdk = {
    threads: {
      async get({ threadId }) {
        return {
          id: threadId,
          projectId: "proj_platform",
          visibility: "hidden",
        };
      },
      async output() {
        outputCalls += 1;
        return { output: "background worker details" };
      },
    },
  };

  await assert.rejects(
    readProjectThread(policy, sdk, { threadId: "thr_hidden" }),
    /not an authorized visible project thread/i,
  );
  assert.equal(outputCalls, 0);
});

test("thread read bounds the serialized result without splitting a code point", async () => {
  const output = "🦄".repeat(threadReadLimits.resultBytes);
  const sdk = {
    threads: {
      async get({ threadId }) {
        return {
          id: threadId,
          projectId: "proj_platform",
          visibility: "visible",
        };
      },
      async output() {
        return { output };
      },
    },
  };

  const serialized = await readProjectThread(policy, sdk, {
    threadId: "thr_large",
  });
  const result = JSON.parse(serialized);
  assert.ok(
    Buffer.byteLength(serialized, "utf8") <= threadReadLimits.resultBytes,
  );
  assert.ok(result.output.length < output.length);
  assert.equal(result.output.endsWith("🦄"), true);
  assert.equal(result.output.includes("�"), false);
  assert.equal(result.outputTruncated, true);
});

test("thread read result limit includes JSON escaping expansion", async () => {
  const sdk = {
    threads: {
      async get({ threadId }) {
        return {
          id: threadId,
          projectId: "proj_platform",
          visibility: "visible",
        };
      },
      async output() {
        return { output: "\u0000".repeat(threadReadLimits.resultBytes) };
      },
    },
  };

  const serialized = await readProjectThread(policy, sdk, {
    threadId: "thr_escaped",
  });
  const result = JSON.parse(serialized);
  assert.ok(
    Buffer.byteLength(serialized, "utf8") <= threadReadLimits.resultBytes,
  );
  assert.equal(result.outputTruncated, true);
  assert.ok(result.output.length < threadReadLimits.resultBytes);
});

test("thread read preserves an explicit no-output result", async () => {
  const sdk = {
    threads: {
      async get({ threadId }) {
        return {
          id: threadId,
          projectId: "proj_platform",
          visibility: "visible",
        };
      },
      async output() {
        return { output: null };
      },
    },
  };

  const result = JSON.parse(
    await readProjectThread(policy, sdk, { threadId: "thr_nooutput" }),
  );
  assert.equal(result.output, null);
  assert.equal(result.outputTruncated, false);
});

test("thread read preserves a small escaped lone surrogate", async () => {
  const output = "before\ud800after";
  const sdk = {
    threads: {
      async get({ threadId }) {
        return {
          id: threadId,
          projectId: "proj_platform",
          visibility: "visible",
        };
      },
      async output() {
        return { output };
      },
    },
  };

  const result = JSON.parse(
    await readProjectThread(policy, sdk, { threadId: "thr_surrogate" }),
  );
  assert.equal(result.output, output);
  assert.equal(result.outputTruncated, false);
});

test("thread read normalizes lookup failures to authorization denial", async () => {
  const sdk = {
    threads: {
      async get() {
        throw new Error("thread does not exist");
      },
      async output() {
        assert.fail("output must not be read after a lookup failure");
      },
    },
  };

  await assert.rejects(
    readProjectThread(policy, sdk, { threadId: "thr_missing" }),
    /not an authorized visible project thread/i,
  );
});

test("policy loading verifies the protected policy descriptor", async () => {
  const fixtureRoot = await realpath(
    await mkdtemp(path.join(tmpdir(), "shared-runtime-policy-")),
  );
  const runtimeRoot = path.join(fixtureRoot, "runtime");
  const projectsRoot = path.join(runtimeRoot, "projects");
  const policyPath = path.join(projectsRoot, "proj_platform.json");
  await mkdir(projectsRoot, { recursive: true, mode: 0o700 });
  const policyDocument = {
    projectId: "proj_platform",
    trustedHostId: "host_vairogs",
    primaryRoot: path.join(fixtureRoot, "primary"),
    worktreeRoot: path.join(fixtureRoot, "worktrees"),
    worktreeDirectoryName: "platform",
    gitCommonDir: path.join(fixtureRoot, "primary", ".git"),
    dockerPath: path.join(fixtureRoot, "docker"),
    dockerSocket: path.join(fixtureRoot, "docker.sock"),
    manifestPath: fixtureManifestPath.pathname,
    manifestSha256: fixtureManifestDigest,
    containers: {
      go: "pform_dev_tracigo_go",
      sveltekit: "pform_dev_sveltekit",
      symfony: "pform_dev_zts",
    },
  };
  await writeFile(policyPath, `${JSON.stringify(policyDocument)}\n`, {
    mode: 0o600,
  });

  const loaded = await loadPolicy(policyPath);
  assert.equal(loaded.dockerSocket, path.join(fixtureRoot, "docker.sock"));
  assert.equal(loaded.manifestPath, fixtureManifestPath.pathname);
  assert.equal(loaded.runtimeRoot, runtimeRoot);
  assert.equal((await stat(policyPath)).mode & 0o777, 0o600);

  policyDocument.codegraphCommand = path.join(
    fixtureRoot,
    "codegraph",
    "bin",
    "codegraph",
  );
  await writeFile(policyPath, `${JSON.stringify(policyDocument)}\n`);
  await assert.rejects(
    loadPolicy(policyPath),
    /CodeGraph command and root must be configured together/i,
  );
  delete policyDocument.codegraphCommand;

  policyDocument.composeProject = "null";
  await writeFile(policyPath, `${JSON.stringify(policyDocument)}\n`);
  await assert.rejects(
    loadPolicy(policyPath),
    /policy Compose project is invalid/i,
  );
  delete policyDocument.composeProject;

  policyDocument.dockerPath = "relative/docker";
  await writeFile(policyPath, `${JSON.stringify(policyDocument)}\n`);
  await assert.rejects(
    loadPolicy(policyPath),
    /policy executable and repository paths must be absolute/i,
  );
  policyDocument.dockerPath = path.join(fixtureRoot, "docker");

  policyDocument.manifestPath = "relative/manifest.json";
  assert.throws(
    () => validatePolicyDocument(policyDocument),
    /policy manifest path must be absolute/i,
  );
  policyDocument.manifestPath = fixtureManifestPath.pathname;

  policyDocument.manifestSha256 = "not-a-digest";
  assert.throws(
    () => validatePolicyDocument(policyDocument),
    /manifestSha256 is invalid/,
  );
  policyDocument.manifestSha256 = fixtureManifestDigest;
  assert.throws(
    () =>
      validatePolicyDocument({
        ...policyDocument,
        worktreeDirectoryName: "a/b",
      }),
    /worktreeDirectoryName is invalid/,
  );
  assert.throws(
    () => validatePolicyDocument({ ...policyDocument, containers: {} }),
    /containers must map roles/,
  );

  await writeFile(policyPath, `${JSON.stringify(policyDocument)}\n`);
  const misnamed = path.join(projectsRoot, "proj_other.json");
  await writeFile(misnamed, `${JSON.stringify(policyDocument)}\n`, {
    mode: 0o600,
  });
  await assert.rejects(
    loadPolicy(misnamed),
    /policy file name must be proj_platform.json/,
  );

  let configuredManifestPath;
  const readConfiguredManifest = async (_primaryRoot, manifestPath) => {
    configuredManifestPath = manifestPath;
    return { manifest, digest: fixtureManifestDigest };
  };
  const registry = await loadRegistry(runtimeRoot, {
    readManifestFile: readConfiguredManifest,
  });
  assert.deepEqual([...registry.policies.keys()], ["proj_platform"]);
  assert.equal(configuredManifestPath, fixtureManifestPath.pathname);
  assert.equal(registry.policies.get("proj_platform").manifestStale, false);
  assert.equal(registry.problems.length, 1);
  assert.match(registry.problems[0].message, /policy file name/);

  const stale = await loadRegistry(runtimeRoot, {
    readManifestFile: async () => ({ manifest, digest: "0".repeat(64) }),
  });
  assert.equal(stale.policies.get("proj_platform").manifestStale, true);
  const missing = await loadRegistry(runtimeRoot, {
    readManifestFile: async () => {
      throw new Error("manifest missing");
    },
  });
  assert.equal(missing.policies.get("proj_platform").manifest, null);
  assert.match(
    missing.policies.get("proj_platform").manifestError,
    /manifest missing/,
  );
  assert.deepEqual(
    (await loadRegistry(path.join(fixtureRoot, "absent"))).policies.size,
    0,
  );
});

test("policy loading rejects symlinked and hard-linked trust anchors", async () => {
  for (const linkType of ["symlink", "hardlink"]) {
    const fixtureRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), `shared-runtime-policy-${linkType}-`)),
    );
    const runtimeRoot = path.join(fixtureRoot, "runtime");
    const projectsRoot = path.join(runtimeRoot, "projects");
    const outsidePolicy = path.join(fixtureRoot, "outside-policy.json");
    const policyPath = path.join(projectsRoot, "proj_platform.json");
    await mkdir(projectsRoot, { recursive: true, mode: 0o700 });
    await writeFile(outsidePolicy, "{}\n", { mode: 0o600 });
    if (linkType === "symlink") {
      await symlink(outsidePolicy, policyPath);
    } else {
      await link(outsidePolicy, policyPath);
    }

    await assert.rejects(
      loadPolicy(policyPath),
      /policy file is missing or not a regular file|policy file has unsafe identity, links, or permissions/i,
    );
    assert.equal(await readFile(outsidePolicy, "utf8"), "{}\n");
  }
  const looseRoot = await realpath(
    await mkdtemp(path.join(tmpdir(), "shared-runtime-policy-loose-")),
  );
  const looseProjects = path.join(looseRoot, "projects");
  await mkdir(looseProjects, { recursive: true, mode: 0o755 });
  await chmod(looseProjects, 0o755);
  await writeFile(path.join(looseProjects, "proj_platform.json"), "{}\n", {
    mode: 0o600,
  });
  await assert.rejects(
    loadPolicy(path.join(looseProjects, "proj_platform.json")),
    /unsafe identity or permissions/,
  );
});

test("primary rebase is fixed to the clean managed branch and mainline ref", () => {
  const workspace = {
    branchName: "bb/example",
    environmentId: "env_abc123",
    hostRoot: "/bb/worktrees/env_abc123/platform",
    kind: "managed-worktree",
  };
  assert.deepEqual(buildRebasePrimaryInvocation(policy, workspace, "master"), {
    command: "git",
    args: [...gitSafetyArgs, "rebase", "refs/heads/master"],
    cwd: "/bb/worktrees/env_abc123/platform",
  });
  const { branchName, invocations } = buildRebasePrimaryPreflightPlan(
    policy,
    workspace,
  );
  const [primaryBranch, worktreeBranch, status] = invocations;
  assert.deepEqual(
    invocations.map(({ command }) => command),
    ["git", "git", "git"],
  );
  assert.equal(branchName, "bb/example");
  assert.deepEqual(primaryBranch.args.slice(-4), [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  assert.deepEqual(worktreeBranch.args.slice(-4), [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  assert.equal(worktreeBranch.cwd, "/bb/worktrees/env_abc123/platform");
  assert.deepEqual(status.args.slice(-2), ["status", "--porcelain"]);
  assert.throws(
    () => buildRebasePrimaryInvocation(policy, workspace, "release"),
    /non-mainline branch/i,
  );
  assert.throws(
    () =>
      buildRebasePrimaryInvocation(
        policy,
        { ...workspace, branchName: "feature/untrusted" },
        "master",
      ),
    /managed BB namespace/i,
  );
  assert.deepEqual(
    buildRebaseRecoveryInvocation(workspace, "rebase_continue"),
    {
      command: "git",
      args: [
        ...gitSafetyArgs,
        "-c",
        "core.editor=true",
        "rebase",
        "--continue",
      ],
      cwd: workspace.hostRoot,
    },
  );
  assert.deepEqual(buildRebaseRecoveryInvocation(workspace, "rebase_abort"), {
    command: "git",
    args: [...gitSafetyArgs, "rebase", "--abort"],
    cwd: workspace.hostRoot,
  });
});

test("primary rebase preflights branch identity and cleanliness", async () => {
  const workspace = {
    branchName: "bb/example",
    environmentId: "env_abc123",
    hostRoot: "/bb/worktrees/env_abc123/platform",
    kind: "managed-worktree",
  };
  const calls = [];
  const run = async (invocation) => {
    calls.push(invocation);
    if (invocation.args.at(-4) === "symbolic-ref") {
      return {
        code: 0,
        signal: null,
        stdout:
          invocation.cwd === "/workspace/platform"
            ? "master\n"
            : "bb/example\n",
        stderr: "",
        overflow: false,
      };
    }
    return { code: 0, signal: null, stdout: "", stderr: "", overflow: false };
  };
  const results = await executeGit(
    policy,
    workspace,
    { operation: "rebase_primary" },
    { run, lockAdapter: new Map() },
  );
  assert.equal(results.length, 4);
  assert.deepEqual(
    calls.map(({ command }) => command),
    ["git", "git", "git", "git"],
  );
  assert.deepEqual(calls.at(-1).args.slice(-2), [
    "rebase",
    "refs/heads/master",
  ]);

  await assert.rejects(
    executeGit(
      policy,
      workspace,
      { operation: "rebase_primary" },
      {
        lockAdapter: new Map(),
        run: async (invocation) => {
          if (invocation.args.at(-4) === "symbolic-ref") {
            return {
              code: 0,
              signal: null,
              stdout:
                invocation.cwd === "/workspace/platform"
                  ? "master\n"
                  : "bb/example\n",
              stderr: "",
              overflow: false,
            };
          }
          return {
            code: 0,
            signal: null,
            stdout: " M changed\n",
            stderr: "",
            overflow: false,
          };
        },
      },
    ),
    /requires a clean managed worktree/i,
  );
});

test("rebase recovery operations dispatch without a primary-checkout preflight", async () => {
  const workspace = {
    branchName: "bb/example",
    environmentId: "env_abc123",
    hostRoot: "/bb/worktrees/env_abc123/platform",
    kind: "managed-worktree",
  };
  const calls = [];
  const run = async (invocation) => {
    calls.push(invocation);
    return { code: 0, signal: null, stdout: "", stderr: "", overflow: false };
  };
  await executeGit(
    policy,
    workspace,
    { operation: "rebase_abort" },
    {
      run,
      lockAdapter: new Map(),
    },
  );
  await executeGit(
    policy,
    workspace,
    { operation: "rebase_continue" },
    {
      run,
      lockAdapter: new Map(),
    },
  );
  assert.deepEqual(
    calls.map((invocation) => invocation.args.slice(-2)),
    [
      ["rebase", "--abort"],
      ["rebase", "--continue"],
    ],
  );
});

test("runtime lifecycle plans target only the configured primary stack", () => {
  const runtimePolicy = {
    ...policy,
    composeProject: "pform_dev",
    manifestPath: "/trusted/platform.bb-runtime.json",
    dockerSocket: "/Users/operator/.colima/default/docker.sock",
  };
  assert.deepEqual(buildRuntimeInvocation(runtimePolicy, "status"), {
    command: runtimePolicy.dockerPath,
    args: [
      "inspect",
      "--format",
      "{{.Name}} {{.State.Running}}",
      policy.containers.go,
      policy.containers.sveltekit,
      policy.containers.symfony,
    ],
    cwd: policy.primaryRoot,
  });
  assert.deepEqual(buildRuntimeInvocation(runtimePolicy, "diagnose"), {
    command: runtimePolicy.dockerPath,
    args: [
      "ps",
      "--all",
      "--filter",
      "label=com.docker.compose.project=pform_dev",
      "--format",
      '{{.Names}}\t{{.Status}}\t{{.Label "com.docker.compose.service"}}',
    ],
    cwd: policy.primaryRoot,
  });
  assert.deepEqual(buildRuntimeInvocation(runtimePolicy, "logs"), {
    command: runtimePolicy.dockerPath,
    args: [
      "ps",
      "--all",
      "--filter",
      "label=com.docker.compose.project=pform_dev",
      "--format",
      "{{.Names}}",
    ],
    cwd: policy.primaryRoot,
  });
  assert.deepEqual(buildRuntimeInvocation(runtimePolicy, "ensure"), {
    command: "/bin/bash",
    args: [path.join(policy.primaryRoot, "scripts", "dev.sh")],
    cwd: policy.primaryRoot,
  });
  assert.deepEqual(buildRuntimeInvocation(runtimePolicy, "recreate"), {
    command: "/bin/bash",
    args: [path.join(policy.primaryRoot, "scripts", "dev.sh"), "--override"],
    cwd: policy.primaryRoot,
  });
  assert.deepEqual(buildRuntimeInvocation(runtimePolicy, "stop"), {
    command: "/bin/bash",
    args: [path.join(policy.primaryRoot, "scripts", "stop.sh")],
    cwd: policy.primaryRoot,
  });
  assert.deepEqual(buildRuntimeInvocation(runtimePolicy, "sync"), {
    command: process.execPath,
    args: [
      path.join(pluginRoot, "bin", "bb-shared-runtime.mjs"),
      "sync",
      "--project-id",
      policy.projectId,
      "--manifest",
      "/trusted/platform.bb-runtime.json",
      "--no-reload",
    ],
    cwd: policy.primaryRoot,
  });
  assert.throws(
    () => buildRuntimeInvocation(runtimePolicy, "shell"),
    /unsupported runtime operation/,
  );
});

test("runtime lifecycle operations must be declared by the project manifest", () => {
  const document = JSON.parse(fixtureManifestContent.toString("utf8"));
  delete document.lifecycle;
  const bare = { ...policy, manifest: validateManifest(document) };
  assert.throws(
    () => buildRuntimeInvocation(bare, "ensure"),
    /lifecycle operation "ensure" is not declared by the project manifest/,
  );
  assert.throws(
    () =>
      buildRuntimeInvocation(
        { ...policy, composeProject: undefined },
        "diagnose",
      ),
    /Compose project is not installed/,
  );
});

test("runtime synchronization is locked and schedules reload without requiring the stack", async () => {
  const runtimePolicy = {
    ...policy,
    composeProject: "pform_dev",
    dockerSocket: "/Users/operator/.colima/default/docker.sock",
  };
  const calls = [];
  let reloadPolicy;
  const results = await executeRuntimeOperation(
    runtimePolicy,
    { hostRoot: "/bb/worktrees/env_test/platform" },
    "sync",
    {
      lockAdapter: new Map(),
      run: async (invocation) => {
        calls.push(invocation);
        return {
          stdout: `${path.basename(invocation.args[0] ?? invocation.command)} ok\n`,
          stderr: "",
        };
      },
      scheduleReload: (scheduledPolicy) => {
        reloadPolicy = scheduledPolicy;
      },
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0].endsWith("/bin/bb-shared-runtime.mjs"), true);
  assert.equal(calls[0].command, process.execPath);
  assert.equal(reloadPolicy, runtimePolicy);
  assert.match(
    formatResults(results),
    /Shared runtime plugin reload scheduled/,
  );
});

test("runtime diagnostics and logs are limited to the configured Compose project", async () => {
  const runtimePolicy = {
    ...policy,
    composeProject: "pform_dev",
    dockerSocket: "/Users/operator/.colima/default/docker.sock",
  };
  assert.deepEqual(
    buildRuntimeLogInvocation(runtimePolicy, "pform_dev_frankenphp"),
    {
      command: runtimePolicy.dockerPath,
      args: ["logs", "--tail", "200", "pform_dev_frankenphp"],
      cwd: policy.primaryRoot,
    },
  );
  assert.deepEqual(
    buildRuntimeLogInvocation(runtimePolicy, "pform_narrative_check"),
    {
      command: runtimePolicy.dockerPath,
      args: ["logs", "--tail", "200", "pform_narrative_check"],
      cwd: policy.primaryRoot,
    },
  );
  assert.throws(
    () => buildRuntimeLogInvocation(runtimePolicy, "unsafe container name"),
    /diagnostic container name is invalid/,
  );

  const calls = [];
  const results = await executeRuntimeOperation(
    runtimePolicy,
    { hostRoot: "/bb/worktrees/env_test/platform" },
    "logs",
    {
      lockAdapter: new Map(),
      run: async (invocation) => {
        calls.push(invocation);
        if (invocation.args[0] === "ps") {
          return {
            stdout:
              "pform_dev_zts\npform_dev_frankenphp\npform_narrative_check\n",
            stderr: "",
          };
        }
        return { stdout: "", stderr: `${invocation.args.at(-1)} log\n` };
      },
    },
  );
  assert.deepEqual(
    calls.slice(1).map((invocation) => invocation.args.at(-1)),
    ["pform_dev_zts", "pform_dev_frankenphp", "pform_narrative_check"],
  );
  assert.match(formatResults(results), /pform_dev_frankenphp log/);
});

test("runtime status reports the last asynchronous plugin reload result", async () => {
  const results = await executeRuntimeOperation(
    policy,
    { hostRoot: "/bb/worktrees/env_test/platform" },
    "status",
    {
      lockAdapter: new Map(),
      readFile: async () => "ok\nReloaded platform-runtime\n",
      run: async () => ({ stdout: "/pform_dev_zts true\n", stderr: "" }),
    },
  );
  assert.match(formatResults(results), /pform_dev_zts true/);
  assert.match(formatResults(results), /Last plugin reload: ok/);
});

test("registered runtime tool accepts only fixed lifecycle operations", async () => {
  const calls = [];
  const tool = buildRuntimeOpsTool({
    policyFor: () => policy,
    workspaceFor: async (threadId) => ({
      policy,
      workspace: { hostRoot: `/workspace/${threadId}` },
    }),
    executeOperation: async (...args) => {
      calls.push(args);
      return { stdout: "healthy\n", stderr: "" };
    },
  });
  assert.deepEqual(
    tool.parameters.properties.operation.enum,
    runtimeOperations,
  );
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(
    await tool.execute(
      { operation: "status" },
      { threadId: "thr_test", signal: undefined },
    ),
    "healthy",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], "status");
  await assert.rejects(
    tool.execute(
      { operation: "shell" },
      { threadId: "thr_test", signal: undefined },
    ),
    /unsupported runtime operation/,
  );
});

test("plugin reload is delegated to a fixed detached primary-checkout helper", async () => {
  const calls = [];
  let unrefCalled = false;
  await schedulePluginReload(policy, {
    spawn: (...args) => {
      calls.push(args);
      return {
        once(event, callback) {
          if (event === "spawn") {
            queueMicrotask(callback);
          }
          return this;
        },
        unref() {
          unrefCalled = true;
        },
      };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/bin/bash");
  assert.deepEqual(calls[0][1], [
    path.join(pluginRoot, "scripts", "reload.sh"),
    policy.projectId,
  ]);
  assert.equal(calls[0][2].cwd, policy.primaryRoot);
  assert.equal(calls[0][2].detached, true);
  assert.equal(calls[0][2].stdio, "ignore");
  assert.equal(calls[0][2].env.PATH, process.env.PATH);
  assert.equal(calls[0][2].env.BB_CLI, process.env.BB_CLI);
  await schedulePluginReload(
    { ...policy, bbCli: "/opt/bb/bin/bb" },
    {
      spawn: (...args) => {
        calls.push(args);
        return {
          once(event, callback) {
            if (event === "spawn") {
              queueMicrotask(callback);
            }
            return this;
          },
          unref() {},
        };
      },
    },
  );
  assert.equal(calls[1][2].env.BB_CLI, "/opt/bb/bin/bb");
  assert.equal(unrefCalled, true);
});

test("detached plugin reload waits for the project operation lock", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "platform-runtime-reload-lock-"),
  );
  const projectId = `reload-${process.pid}-${Date.now()}`;
  const helper = path.join(fixtureRoot, "scripts", "reload.sh");
  const runtimeHelper = path.join(fixtureRoot, "scripts", "plugin-reload.sh");
  const runtimeRoot = path.join(fixtureRoot, "home", ".bb", "shared-runtime");
  const lockPath = path.join(runtimeRoot, "locks", `${projectId}.lock`);
  const reloadLog = path.join(fixtureRoot, "reload.log");
  const commandRoot = path.join(fixtureRoot, "bin");

  try {
    await mkdir(path.dirname(helper), { recursive: true });
    await mkdir(commandRoot, { recursive: true });
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      helper,
      await readFile(path.join(pluginRoot, "scripts", "reload.sh"), "utf8"),
      { mode: 0o755 },
    );
    await writeFile(
      runtimeHelper,
      [
        "#!/usr/bin/env bash",
        "set -Eeuo pipefail",
        'printf "reload\\n" >>"${RELOAD_LOG:?}"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    await writeFile(path.join(commandRoot, "chmod"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    await writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`,
    );

    const reload = execFileAsync("/bin/bash", [helper, projectId], {
      env: {
        ...process.env,
        HOME: path.join(fixtureRoot, "home"),
        PATH: `${commandRoot}:${process.env.PATH}`,
        RELOAD_LOG: reloadLog,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    let reloadedWhileLocked = true;
    try {
      await readFile(reloadLog, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      reloadedWhileLocked = false;
    }
    await rm(lockPath, { recursive: true, force: true });
    await reload;

    assert.equal(reloadedWhileLocked, false);
    assert.equal(await readFile(reloadLog, "utf8"), "reload\n");
    assert.match(
      await readFile(
        path.join(runtimeRoot, `last-plugin-reload.${projectId}.status`),
        "utf8",
      ),
      /^ok\n/,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("JavaScript waits while the shell publishes its state lock", async () => {
  const fixture = await prepareReloadInterleavingFixture(
    "reload-state-interleave",
  );
  let reload;
  try {
    reload = execFileAsync("/bin/bash", [fixture.helper, fixture.projectId], {
      env: {
        ...process.env,
        BLOCK_MKDIR_PATH: fixture.lockPath,
        BLOCK_READY_PATH: fixture.readyPath,
        BLOCK_RELEASE_PATH: fixture.releasePath,
        HOME: path.join(fixture.fixtureRoot, "home"),
        PATH: `${fixture.commandRoot}:${process.env.PATH}`,
        RELOAD_LOG: fixture.reloadLog,
      },
    });
    await waitForFixturePath(fixture.readyPath);
    const shellClaim = await _testing.inspectOwnerClaim(
      `${fixture.lockPath}.owner.json`,
    );
    assert.equal(
      shellClaim.owner.processIdentity,
      await _testing.readProcessIdentity(shellClaim.owner.pid),
    );

    let javascriptEntered = false;
    let reportJavascriptWait;
    const javascriptWait = new Promise((resolve) => {
      reportJavascriptWait = resolve;
    });
    const javascript = withProjectLock(
      fixture.projectId,
      async () => {
        javascriptEntered = true;
      },
      {
        lockRoot: fixture.lockRoot,
        onWait: reportJavascriptWait,
        owner: { environmentId: "env_javascript", operation: "runtime_tests" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    await waitForFixtureSignal(javascriptWait, "JavaScript state claim wait");
    const enteredDuringShellSetup = javascriptEntered;

    await writeFile(fixture.releasePath, "\n");
    await Promise.all([reload, javascript]);

    assert.equal(enteredDuringShellSetup, false);
    assert.equal(await readFile(fixture.reloadLog, "utf8"), "reload\n");
  } finally {
    await writeFile(fixture.releasePath, "\n").catch(() => {});
    await reload?.catch(() => {});
    await removeFixtureDirectory(fixture.fixtureRoot);
  }
});

test("JavaScript waits while the shell publishes its state gate", async () => {
  const fixture = await prepareReloadInterleavingFixture(
    "reload-gate-interleave",
  );
  const gatePath = path.join(fixture.lockPath, "gate.lock");
  let reload;
  try {
    await mkdir(path.join(fixture.lockPath, "readers"), { recursive: true });
    await mkdir(path.join(fixture.lockPath, "writers"));
    await writeFile(path.join(fixture.lockPath, "rw.json"), '{"version":1}\n');

    reload = execFileAsync("/bin/bash", [fixture.helper, fixture.projectId], {
      env: {
        ...process.env,
        BLOCK_MKDIR_PATH: gatePath,
        BLOCK_READY_PATH: fixture.readyPath,
        BLOCK_RELEASE_PATH: fixture.releasePath,
        HOME: path.join(fixture.fixtureRoot, "home"),
        PATH: `${fixture.commandRoot}:${process.env.PATH}`,
        RELOAD_LOG: fixture.reloadLog,
      },
    });
    await waitForFixturePath(fixture.readyPath);
    const shellClaim = await _testing.inspectOwnerClaim(
      `${gatePath}.owner.json`,
    );
    assert.equal(
      shellClaim.owner.processIdentity,
      await _testing.readProcessIdentity(shellClaim.owner.pid),
    );

    let javascriptEntered = false;
    let reportJavascriptWait;
    const javascriptWait = new Promise((resolve) => {
      reportJavascriptWait = resolve;
    });
    const javascript = withProjectLock(
      fixture.projectId,
      async () => {
        javascriptEntered = true;
      },
      {
        lockRoot: fixture.lockRoot,
        onWait: reportJavascriptWait,
        owner: { environmentId: "env_javascript", operation: "runtime_tests" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    await waitForFixtureSignal(javascriptWait, "JavaScript gate claim wait");
    const enteredDuringShellSetup = javascriptEntered;

    await writeFile(fixture.releasePath, "\n");
    await Promise.all([reload, javascript]);

    assert.equal(enteredDuringShellSetup, false);
    assert.equal(await readFile(fixture.reloadLog, "utf8"), "reload\n");
  } finally {
    await writeFile(fixture.releasePath, "\n").catch(() => {});
    await reload?.catch(() => {});
    await removeFixtureDirectory(fixture.fixtureRoot);
  }
});

test("shell preserves a legacy gate recreated before publication", async () => {
  const fixture = await prepareReloadInterleavingFixture(
    "reload-gate-collision",
  );
  const gatePath = path.join(fixture.lockPath, "gate.lock");
  const ownerPath = path.join(gatePath, "owner.json");
  const owner = `${JSON.stringify({ createdAt: Date.now(), pid: process.pid })}\n`;
  let reload;
  try {
    await mkdir(path.join(fixture.lockPath, "readers"), { recursive: true });
    await mkdir(path.join(fixture.lockPath, "writers"));
    await writeFile(path.join(fixture.lockPath, "rw.json"), '{"version":1}\n');

    reload = execFileAsync("/bin/bash", [fixture.helper, fixture.projectId], {
      env: {
        ...process.env,
        BLOCK_MKDIR_PATH: gatePath,
        BLOCK_READY_PATH: fixture.readyPath,
        BLOCK_RELEASE_PATH: fixture.releasePath,
        HOME: path.join(fixture.fixtureRoot, "home"),
        PATH: `${fixture.commandRoot}:${process.env.PATH}`,
        RELOAD_LOG: fixture.reloadLog,
      },
    });
    await waitForFixturePath(fixture.readyPath);
    await mkdir(gatePath);
    await writeFile(ownerPath, owner);
    await writeFile(fixture.releasePath, "\n");
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(await readFile(ownerPath, "utf8"), owner);
    await assert.rejects(
      readFile(fixture.reloadLog, "utf8"),
      (error) => error?.code === "ENOENT",
    );

    await retireFixtureDirectory(gatePath);
    await reload;
    assert.equal(await readFile(fixture.reloadLog, "utf8"), "reload\n");
  } finally {
    await writeFile(fixture.releasePath, "\n").catch(() => {});
    await reload?.catch(() => {});
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("shell retries when the gate parent retires after claiming", async () => {
  const fixture = await prepareReloadInterleavingFixture(
    "reload-retired-gate-parent",
  );
  const gatePath = path.join(fixture.lockPath, "gate.lock");
  let reload;
  try {
    await mkdir(path.join(fixture.lockPath, "readers"), { recursive: true });
    await mkdir(path.join(fixture.lockPath, "writers"));
    await writeFile(path.join(fixture.lockPath, "rw.json"), '{"version":1}\n');
    await mkdir(gatePath);
    reload = execFileAsync("/bin/bash", [fixture.helper, fixture.projectId], {
      env: {
        ...process.env,
        HOME: path.join(fixture.fixtureRoot, "home"),
        PATH: `${fixture.commandRoot}:${process.env.PATH}`,
        RELOAD_LOG: fixture.reloadLog,
      },
    });

    await waitForFixturePath(`${gatePath}.owner.json`);
    await retireFixtureDirectory(fixture.lockPath);
    await reload;

    assert.equal(await readFile(fixture.reloadLog, "utf8"), "reload\n");
  } finally {
    await reload?.catch(() => {});
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("shell waits while JavaScript publishes its state lock", async () => {
  const fixture = await prepareReloadInterleavingFixture(
    "javascript-state-interleave",
  );
  const claimPath = `${fixture.lockPath}.owner.json`;
  let claim;
  let reload;
  try {
    await mkdir(fixture.lockRoot, { recursive: true });
    claim = await _testing.installOwnerClaim(claimPath);
    assert.notEqual(claim, null);

    reload = execFileAsync("/bin/bash", [fixture.helper, fixture.projectId], {
      env: {
        ...process.env,
        HOME: path.join(fixture.fixtureRoot, "home"),
        PATH: `${fixture.commandRoot}:${process.env.PATH}`,
        RELOAD_LOG: fixture.reloadLog,
        SHELL_WAIT_PATH: fixture.shellWaitPath,
        WATCH_CLAIM_PATH: claimPath,
      },
    });
    await waitForFixturePath(fixture.shellWaitPath);
    await assert.rejects(
      readFile(fixture.reloadLog, "utf8"),
      (error) => error?.code === "ENOENT",
    );

    assert.equal(await _testing.recoverOwnerClaim(claimPath, claim), true);
    claim = null;
    await reload;

    assert.equal(await readFile(fixture.reloadLog, "utf8"), "reload\n");
  } finally {
    if (claim !== null && claim !== undefined) {
      await _testing.recoverOwnerClaim(claimPath, claim).catch(() => {});
    }
    await reload?.catch(() => {});
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("shell waits while JavaScript publishes its state gate", async () => {
  const fixture = await prepareReloadInterleavingFixture(
    "javascript-gate-interleave",
  );
  const gatePath = path.join(fixture.lockPath, "gate.lock");
  const claimPath = `${gatePath}.owner.json`;
  let claim;
  let reload;
  try {
    await mkdir(path.join(fixture.lockPath, "readers"), { recursive: true });
    await mkdir(path.join(fixture.lockPath, "writers"));
    await writeFile(path.join(fixture.lockPath, "rw.json"), '{"version":1}\n');
    claim = await _testing.installOwnerClaim(claimPath);
    assert.notEqual(claim, null);

    reload = execFileAsync("/bin/bash", [fixture.helper, fixture.projectId], {
      env: {
        ...process.env,
        HOME: path.join(fixture.fixtureRoot, "home"),
        PATH: `${fixture.commandRoot}:${process.env.PATH}`,
        RELOAD_LOG: fixture.reloadLog,
        SHELL_WAIT_PATH: fixture.shellWaitPath,
        WATCH_CLAIM_PATH: claimPath,
      },
    });
    await waitForFixturePath(fixture.shellWaitPath);
    await assert.rejects(
      readFile(fixture.reloadLog, "utf8"),
      (error) => error?.code === "ENOENT",
    );

    assert.equal(await _testing.recoverOwnerClaim(claimPath, claim), true);
    claim = null;
    await reload;

    assert.equal(await readFile(fixture.reloadLog, "utf8"), "reload\n");
  } finally {
    if (claim !== null && claim !== undefined) {
      await _testing.recoverOwnerClaim(claimPath, claim).catch(() => {});
    }
    await reload?.catch(() => {});
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("shell rejects a directory where a state claim file is required", async () => {
  const fixture = await prepareReloadInterleavingFixture(
    "reload-invalid-claim",
  );
  try {
    await mkdir(`${fixture.lockPath}.owner.json`, { recursive: true });

    await assert.rejects(
      execFileAsync("/bin/bash", [fixture.helper, fixture.projectId], {
        env: {
          ...process.env,
          HOME: path.join(fixture.fixtureRoot, "home"),
          PATH: `${fixture.commandRoot}:${process.env.PATH}`,
          RELOAD_LOG: fixture.reloadLog,
        },
      }),
      (error) => {
        assert.match(error.stderr, /claim target is not a regular claim file/);
        return true;
      },
    );
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("shell preserves a claim when owner metadata cannot be read", async () => {
  const fixture = await prepareReloadInterleavingFixture(
    "reload-owner-read-failure",
  );
  const claimPath = `${fixture.lockPath}.owner.json`;
  const owner = `${JSON.stringify({
    createdAt: Date.now(),
    id: "live-owner",
    pid: process.pid,
    processIdentity: await _testing.readProcessIdentity(process.pid),
  })}\n`;
  try {
    await mkdir(fixture.lockRoot, { recursive: true });
    await writeFile(claimPath, owner);

    await assert.rejects(
      execFileAsync("/bin/bash", [fixture.helper, fixture.projectId], {
        env: {
          ...process.env,
          FAIL_READ_PATH: claimPath,
          HOME: path.join(fixture.fixtureRoot, "home"),
          PATH: `${fixture.commandRoot}:${process.env.PATH}`,
          RELOAD_LOG: fixture.reloadLog,
        },
      }),
      (error) => {
        assert.match(error.stderr, /cannot read lock owner metadata/);
        return true;
      },
    );

    assert.equal(await readFile(claimPath, "utf8"), owner);
    await assert.rejects(
      readFile(fixture.reloadLog, "utf8"),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("shell rejects a reused live pid in a stale claim", async () => {
  const fixture = await prepareReloadInterleavingFixture("reload-reused-pid");
  try {
    await mkdir(fixture.lockRoot, { recursive: true });
    await writeFile(
      `${fixture.lockPath}.owner.json`,
      `${JSON.stringify({ createdAt: 1, id: "pre-restart", pid: process.pid })}\n`,
    );

    await execFileAsync("/bin/bash", [fixture.helper, fixture.projectId], {
      env: {
        ...process.env,
        HOME: path.join(fixture.fixtureRoot, "home"),
        PATH: `${fixture.commandRoot}:${process.env.PATH}`,
        RELOAD_LOG: fixture.reloadLog,
      },
    });

    assert.equal(await readFile(fixture.reloadLog, "utf8"), "reload\n");
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("shell reports a fatal recovery contender failure", async () => {
  const fixture = await prepareReloadInterleavingFixture(
    "reload-recovery-failure",
  );
  try {
    await mkdir(fixture.lockRoot, { recursive: true });
    await writeFile(
      `${fixture.lockPath}.owner.json`,
      `${JSON.stringify({
        createdAt: 1,
        id: "dead-owner",
        pid: 2_147_483_647,
        processIdentity: "stale",
      })}\n`,
    );

    await assert.rejects(
      execFileAsync("/bin/bash", [fixture.helper, fixture.projectId], {
        env: {
          ...process.env,
          FAIL_RECOVERY_LINK: "1",
          HOME: path.join(fixture.fixtureRoot, "home"),
          PATH: `${fixture.commandRoot}:${process.env.PATH}`,
          RELOAD_LOG: fixture.reloadLog,
        },
      }),
      (error) => {
        assert.match(error.stderr, /simulated recovery link failure/);
        return true;
      },
    );
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("shell state setup waits for a live legacy ownerless publisher", async () => {
  const fixture = await prepareReloadInterleavingFixture("reload-legacy-state");
  const claimPath = `${fixture.lockPath}.owner.json`;
  let reload;
  try {
    await mkdir(fixture.lockPath, { recursive: true });
    reload = execFileAsync("/bin/bash", [fixture.helper, fixture.projectId], {
      env: {
        ...process.env,
        HOME: path.join(fixture.fixtureRoot, "home"),
        PATH: `${fixture.commandRoot}:${process.env.PATH}`,
        RELOAD_LOG: fixture.reloadLog,
      },
    });
    await waitForFixturePath(claimPath);
    await writeFile(path.join(fixture.lockPath, "owner.json"), "{\n");
    await new Promise((resolve) => setTimeout(resolve, 250));
    await writeFile(
      path.join(fixture.lockPath, "owner.json"),
      `${JSON.stringify({ createdAt: Date.now(), pid: process.pid })}\n`,
    );
    await waitForFixturePathRemoval(claimPath);
    await assert.rejects(
      readFile(fixture.reloadLog, "utf8"),
      (error) => error?.code === "ENOENT",
    );

    await retireFixtureDirectory(fixture.lockPath);
    await reload;
    assert.equal(await readFile(fixture.reloadLog, "utf8"), "reload\n");
  } finally {
    await reload?.catch(() => {});
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("shell gate setup waits for a live legacy ownerless publisher", async () => {
  const fixture = await prepareReloadInterleavingFixture("reload-legacy-gate");
  const gatePath = path.join(fixture.lockPath, "gate.lock");
  const claimPath = `${gatePath}.owner.json`;
  let reload;
  try {
    await mkdir(path.join(fixture.lockPath, "readers"), { recursive: true });
    await mkdir(path.join(fixture.lockPath, "writers"));
    await writeFile(path.join(fixture.lockPath, "rw.json"), '{"version":1}\n');
    await mkdir(gatePath);
    reload = execFileAsync("/bin/bash", [fixture.helper, fixture.projectId], {
      env: {
        ...process.env,
        HOME: path.join(fixture.fixtureRoot, "home"),
        PATH: `${fixture.commandRoot}:${process.env.PATH}`,
        RELOAD_LOG: fixture.reloadLog,
      },
    });
    await waitForFixturePath(claimPath);
    await writeFile(path.join(gatePath, "owner.json"), "{\n");
    await new Promise((resolve) => setTimeout(resolve, 250));
    await writeFile(
      path.join(gatePath, "owner.json"),
      `${JSON.stringify({ createdAt: Date.now(), pid: process.pid })}\n`,
    );
    await waitForFixturePathRemoval(claimPath);
    await assert.rejects(
      readFile(fixture.reloadLog, "utf8"),
      (error) => error?.code === "ENOENT",
    );

    await retireFixtureDirectory(gatePath);
    await reload;
    assert.equal(await readFile(fixture.reloadLog, "utf8"), "reload\n");
  } finally {
    await reload?.catch(() => {});
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("detached plugin reload recovers an abandoned reader-writer lock", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "platform-runtime-reload-rw-lock-"),
  );
  const projectId = `reload-rw-${process.pid}-${Date.now()}`;
  const helper = path.join(fixtureRoot, "scripts", "reload.sh");
  const runtimeHelper = path.join(fixtureRoot, "scripts", "plugin-reload.sh");
  const runtimeRoot = path.join(fixtureRoot, "home", ".bb", "shared-runtime");
  const lockPath = path.join(runtimeRoot, "locks", `${projectId}.lock`);
  const reloadLog = path.join(fixtureRoot, "reload.log");
  const commandRoot = path.join(fixtureRoot, "bin");

  try {
    await mkdir(path.dirname(helper), { recursive: true });
    await mkdir(path.join(lockPath, "readers"), { recursive: true });
    await mkdir(path.join(lockPath, "writers"), { recursive: true });
    await mkdir(commandRoot, { recursive: true });
    await writeFile(
      helper,
      await readFile(path.join(pluginRoot, "scripts", "reload.sh"), "utf8"),
      { mode: 0o755 },
    );
    await writeFile(
      runtimeHelper,
      [
        "#!/usr/bin/env bash",
        "set -Eeuo pipefail",
        'printf "reload\\n" >>"${RELOAD_LOG:?}"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    await writeFile(path.join(commandRoot, "chmod"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    await writeFile(path.join(lockPath, "rw.json"), '{"version":1}\n');
    await writeFile(
      path.join(lockPath, "readers", "abandoned.json"),
      `${JSON.stringify({
        createdAt: Date.now(),
        environmentId: "env_abandoned",
        id: "abandoned",
        mode: "shared",
        operation: "svelte_check",
        pid: 2_147_483_647,
      })}\n`,
    );

    await execFileAsync("/bin/bash", [helper, projectId], {
      env: {
        ...process.env,
        HOME: path.join(fixtureRoot, "home"),
        PATH: `${commandRoot}:${process.env.PATH}`,
        RELOAD_LOG: reloadLog,
      },
    });

    assert.equal(await readFile(reloadLog, "utf8"), "reload\n");
    assert.match(
      await readFile(
        path.join(runtimeRoot, `last-plugin-reload.${projectId}.status`),
        "utf8",
      ),
      /^ok\n/,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("registered Git tool accepts primary rebase and recovery", async () => {
  const workspace = {
    branchName: "bb/example",
    hostRoot: "/bb/worktrees/env_abc123/platform",
    kind: "managed-worktree",
  };
  const calls = [];
  const tool = buildRuntimeGitTool({
    workspaceFor: async (threadId) => {
      assert.equal(threadId, "thr_test");
      return { policy, workspace };
    },
    executeGitOperation: async (...args) => {
      calls.push(args);
      return { stdout: "rebased\n", stderr: "" };
    },
  });
  assert.ok(gitOperations.includes("rebase_primary"));
  assert.ok(gitOperations.includes("rebase_continue"));
  assert.ok(gitOperations.includes("rebase_abort"));
  assert.ok(
    tool.parameters.properties.operation.enum.includes("rebase_primary"),
  );
  assert.equal(
    await tool.execute(
      { operation: "rebase_primary" },
      { threadId: "thr_test", signal: undefined },
    ),
    "rebased",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].operation, "rebase_primary");
  assert.equal(
    await tool.execute(
      { operation: "rebase_abort" },
      { threadId: "thr_test", signal: undefined },
    ),
    "rebased",
  );
  assert.equal(calls.at(-1)[2].operation, "rebase_abort");
  await assert.rejects(
    tool.execute(
      { operation: "rebase" },
      { threadId: "thr_test", signal: undefined },
    ),
    /unsupported git operation/i,
  );
});
