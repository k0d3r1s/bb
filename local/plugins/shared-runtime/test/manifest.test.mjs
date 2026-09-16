import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  describeOperations,
  expandDependencies,
  manifestDigest,
  readManifest,
  substitutePlaceholders,
  validateManifest,
} from "../src/manifest.mjs";

const execFileAsync = promisify(execFile);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(pluginRoot, "test", "fixtures", "platform.bb-runtime.json");
const productionManifestPath = path.join(pluginRoot, "manifests", "platform.bb-runtime.json");

async function fixtureDocument() {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

function minimal(overrides = {}) {
  return {
    version: 1,
    isolation: { builder: "app" },
    containers: {
      app: { service: "app", mounts: [{ host: ".", container: "/app" }] },
    },
    operations: {
      tests: { container: "app", argv: ["npm", "test"] },
    },
    ...overrides,
  };
}

test("the Platform fixture manifest validates and describes every operation", async () => {
  const manifest = validateManifest(await fixtureDocument());
  assert.equal(manifest.isolation.builder, "go");
  assert.equal(manifest.isolation.probe, "symfony");
  assert.deepEqual(Object.keys(manifest.containers), ["go", "sveltekit", "symfony"]);
  assert.equal(manifest.containers.symfony.root, "src/symfony");
  assert.equal(manifest.worktrees.containerRoot, "/bb-worktrees");
  assert.equal(manifest.search.defaultPath, "src");
  const described = describeOperations(manifest);
  assert.ok(described.some((line) => line.startsWith("symfony_unit (requires target matching")));
  assert.ok(described.some((line) => line === "go_full (sequence: go_format_check, go_vet, go_tests)"));
  assert.ok(described.some((line) => line.includes('go_tests (target one of "tracigo_timeline_context_postgres")')));
  assert.equal(manifest.git.generators.length, 2);
  assert.equal(manifest.git.hardlinks.length, 1);
});

test("the bundled Platform manifest preserves every legacy Go test target", async () => {
  const manifest = validateManifest(JSON.parse(await readFile(productionManifestPath, "utf8")));
  assert.deepEqual(Object.keys(manifest.operations.go_tests.target.variants), [
    "tracigo_write_through_inventory_generate",
    "tracigo_write_through_inventory_require_zero",
    "tracigo_timeline_context_postgres",
    "tracigo_write_through_unit",
    "tracigo_write_through_postgres",
    "tracigo_write_through_redis_required",
    "tracigo_write_through_race",
    "tracigo_e2e",
    "tracigo_write_through_knowledge",
    "tracigo_write_through_sources",
    "tracigo_write_through_content",
    "tracigo_write_through_automation_developer",
    "tracigo_write_through_ai",
    "tracigo_write_through_sre",
    "tracigo_write_through_platform",
    "tracigo_write_through_secondary",
    "tracigo_write_through_background",
  ]);
});

test("manifest validation refuses shell evaluation and unknown placeholders", () => {
  assert.throws(
    () =>
      validateManifest(
        minimal({ operations: { bad: { container: "app", argv: ["bash", "-c", "rm -rf /"] } } }),
      ),
    /may not evaluate inline shell text/,
  );
  assert.throws(
    () =>
      validateManifest(
        minimal({ operations: { bad: { container: "app", argv: ["node", "-e", "1"] } } }),
      ),
    /may not evaluate inline script text/,
  );
  assert.throws(
    () =>
      validateManifest(
        minimal({ operations: { bad: { container: "app", argv: ["npm", "${nope}"] } } }),
      ),
    /unknown placeholder "nope"/,
  );
  assert.throws(
    () =>
      validateManifest(
        minimal({ operations: { bad: { container: "missing", argv: ["npm"] } } }),
      ),
    /is not declared/,
  );
  assert.throws(
    () => validateManifest(minimal({ operations: { "Bad-Name": { container: "app", argv: ["x"] } } })),
    /operation name "Bad-Name" is invalid/,
  );
  assert.throws(
    () => validateManifest(minimal({ version: 2 })),
    /version must be 1/,
  );
  assert.throws(
    () => validateManifest(minimal({ isolation: undefined })),
    /isolation.builder is required/,
  );
  assert.throws(
    () =>
      validateManifest(
        minimal({
          operations: {
            unit: {
              container: "app",
              argv: ["npm", "test"],
              target: { pattern: "^[a-z]+$" },
            },
          },
        }),
      ),
    /never uses \$\{target\}/,
  );
  assert.throws(
    () =>
      validateManifest(
        minimal({
          operations: {
            unit: {
              container: "app",
              argv: ["npm", "test", "${target}"],
              target: { pattern: "[a-z]+" },
            },
          },
        }),
      ),
    /anchored/,
  );
  assert.throws(
    () =>
      validateManifest(
        minimal({
          operations: {
            a: { container: "app", argv: ["npm"] },
            all: { steps: ["a", "missing"] },
          },
        }),
      ),
    /references unknown operation "missing"/,
  );
  assert.throws(
    () =>
      validateManifest(
        minimal({
          operations: {
            unit: { container: "app", argv: ["npm", "${target}"], target: { pattern: "^x$", required: true } },
            all: { steps: ["unit"] },
          },
        }),
      ),
    /may not reference an operation that requires a target/,
  );
  assert.throws(
    () =>
      validateManifest(
        minimal({ lifecycle: { ensure: ["docker", "compose", "up"] } }),
      ),
    /must start with a known interpreter/,
  );
  assert.throws(
    () => validateManifest(minimal({ dependencies: [{ path: "../vendor", link: "/x" }] })),
    /escapes the repository/,
  );
  assert.throws(
    () => validateManifest(minimal({ dependencies: [{ path: "apps/*/node_modules", mirror: "/app/node_modules" }] })),
    /must repeat every wildcard segment/,
  );
});

test("host steps are limited to primary-checkout scripts under a known interpreter", () => {
  const manifest = validateManifest(
    minimal({
      operations: {
        integration: {
          container: "app",
          argv: ["npm", "test"],
          target: {
            variants: {
              postgres: {
                kind: "host",
                argv: ["bash", "scripts/integration.sh", "--fast"],
                containers: ["app"],
                env: { WORKDIR: "${root.app}" },
              },
            },
          },
        },
      },
    }),
  );
  const variant = manifest.operations.integration.target.variants.postgres;
  assert.equal(variant.kind, "host");
  assert.equal(variant.script, "scripts/integration.sh");
  assert.deepEqual(variant.argv, ["--fast"]);
  assert.throws(
    () =>
      validateManifest(
        minimal({
          operations: {
            bad: { kind: "host", argv: ["python", "/etc/passwd"] },
          },
        }),
      ),
    /must be a repository-relative POSIX path/,
  );
  assert.throws(
    () =>
      validateManifest(
        minimal({
          operations: {
            bad: { kind: "host", argv: ["custom-binary", "scripts/x.sh"] },
          },
        }),
      ),
    /must start with a known interpreter/,
  );
});

test("placeholder substitution is explicit and fails closed", () => {
  assert.equal(
    substitutePlaceholders("--require=${runtime}/preload.cjs", { runtime: "/x/assets" }),
    "--require=/x/assets/preload.cjs",
  );
  assert.throws(
    () => substitutePlaceholders("${missing}", {}, "argv"),
    /argv references unresolved placeholder "missing"/,
  );
});

test("dependency wildcards expand against the primary checkout only", async () => {
  const manifest = validateManifest(
    minimal({
      dependencies: [
        { path: "vendor", link: "/app/vendor" },
        { path: "apps/*/node_modules", mirror: "/app/apps/*/node_modules", local: [".vite"] },
      ],
    }),
  );
  const tree = {
    "/primary/apps": [
      { name: "web", isDirectory: () => true },
      { name: "api", isDirectory: () => true },
      { name: ".hidden", isDirectory: () => true },
      { name: "README.md", isDirectory: () => false },
    ],
  };
  const existing = new Set(["/primary/apps/web/node_modules"]);
  const expanded = await expandDependencies(manifest, "/primary", {
    readDirectory: async (directory) => {
      if (!tree[directory]) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      return tree[directory];
    },
    pathExists: async (target) => existing.has(target),
  });
  assert.deepEqual(
    expanded.map((entry) => [entry.kind, entry.relativePath, entry.containerTarget]),
    [
      ["link", "vendor", "/app/vendor"],
      ["mirror", "apps/web/node_modules", "/app/apps/web/node_modules"],
    ],
  );
});

test("readManifest hashes the exact committed bytes", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "shared-runtime-manifest-")));
  try {
    await assert.rejects(readManifest(root), /manifest missing/);
    const content = `${JSON.stringify(minimal(), null, 2)}\n`;
    await writeFile(path.join(root, ".bb-runtime.json"), content);
    const loaded = await readManifest(root);
    assert.equal(loaded.digest, manifestDigest(content));
    assert.equal(loaded.manifest.operations.tests.step.container, "app");
    await writeFile(path.join(root, ".bb-runtime.json"), "{ not json");
    await assert.rejects(readManifest(root), /not valid JSON/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readManifest accepts a trusted manifest outside the repository root", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "shared-runtime-root-")));
  const manifestRoot = await realpath(
    await mkdtemp(path.join(tmpdir(), "shared-runtime-external-manifest-")),
  );
  try {
    const manifestPath = path.join(manifestRoot, "platform.json");
    const content = `${JSON.stringify(minimal(), null, 2)}\n`;
    await writeFile(manifestPath, content);
    const loaded = await readManifest(root, manifestPath);
    assert.equal(loaded.path, manifestPath);
    assert.equal(loaded.digest, manifestDigest(content));
    await assert.rejects(readManifest(root, "relative.json"), /path must be absolute/u);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(manifestRoot, { recursive: true, force: true });
  }
});

test("the CLI validates a manifest and prints a compose overlay without a registry", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "shared-runtime-cli-")));
  try {
    await writeFile(path.join(root, ".bb-runtime.json"), await readFile(fixturePath));
    const cli = path.join(pluginRoot, "bin", "bb-shared-runtime.mjs");
    const validated = await execFileAsync(process.execPath, [cli, "validate", "--json"], { cwd: root });
    const summary = JSON.parse(validated.stdout);
    assert.deepEqual(summary.containers, ["go", "sveltekit", "symfony"]);
    assert.ok(summary.operations.includes("symfony_static"));
    const overlay = await execFileAsync(process.execPath, [cli, "compose-overlay"], { cwd: root });
    assert.match(overlay.stdout, /^services:$/m);
    assert.match(overlay.stdout, /^  zts:$/m);
    assert.match(overlay.stdout, /BB_WORKTREES_ROOT[^\n]*:\/bb-worktrees$/m);
    assert.match(overlay.stdout, /BB_PRIMARY_ROOT[^\n]*\/src\/symfony:\/var\/www\/html$/m);
    const help = await execFileAsync(process.execPath, [cli], { cwd: root });
    assert.match(help.stdout, /Usage: bb-shared-runtime/);
    await assert.rejects(
      execFileAsync(process.execPath, [cli, "bogus"], { cwd: root }),
      /Unknown command: bogus/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
