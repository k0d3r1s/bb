import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalizeExistingDataDir,
  createEnvironmentFile,
  createSystemdUnit,
  lingeringRemediation,
  parseInstallArgs,
} from "./install-local-vps-service.mjs";

test("service installer accepts only an absolute data directory", () => {
  assert.deepEqual(parseInstallArgs(["--data-dir", "/srv/bb"]), {
    dataDir: "/srv/bb",
  });
  assert.throws(() => parseInstallArgs(["--data-dir", "data"]), /absolute/u);
});

test("service installer canonicalizes a symlinked data directory", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bb-vps-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "target");
  const linked = path.join(root, "linked");
  await mkdir(target);
  await symlink(target, linked);

  assert.equal(
    await canonicalizeExistingDataDir(linked),
    await realpath(target),
  );
});

test("unit launches the current release with writable home workspaces", () => {
  const unit = createSystemdUnit({
    homeDir: "/home/alice",
    dataDir: "/srv/bb",
    stateDir: "/home/alice/.local/state/bb-local",
    nodePath: "/home/alice/.nvm/versions/node/v26/bin/node",
  });
  assert.match(unit, /EnvironmentFile=%h\/.config\/bb-local\/environment/u);
  assert.match(
    unit,
    /ExecStart="\/home\/alice\/\.nvm\/versions\/node\/v26\/bin\/node" %h\/.local\/share\/bb-local\/current\/packages\/bb-app\/dist\/bb-app\.js/u,
  );
  assert.match(unit, /--server-bind-host 127\.0\.0\.1/u);
  assert.match(unit, /ProtectSystem=full/u);
  assert.doesNotMatch(unit, /^ProtectHome=/mu);
  assert.match(unit, /ReadOnlyPaths=%h\/.local\/share\/bb-local\/releases/u);
  assert.match(
    unit,
    /ReadWritePaths="\/srv\/bb" "\/home\/alice\/\.local\/state\/bb-local"/u,
  );
});

test(
  "systemd service policy writes a representative home checkout",
  {
    skip:
      process.platform !== "linux" ||
      process.env.BB_VPS_SYSTEMD_INTEGRATION !== "1",
  },
  async (t) => {
    const root = await mkdtemp(path.join(homedir(), ".bb-vps-systemd-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const checkout = path.join(root, "projects", "app");
    const target = path.join(checkout, "service-edit.txt");
    await mkdir(checkout, { recursive: true });
    const unit = createSystemdUnit({
      homeDir: homedir(),
      dataDir: path.join(root, "data"),
      stateDir: path.join(root, "state"),
      nodePath: process.execPath,
    });
    const protectSystem = unit.match(/^ProtectSystem=.*$/mu)?.[0];
    assert.equal(protectSystem, "ProtectSystem=full");
    const result = spawnSync(
      "systemd-run",
      [
        "--user",
        "--wait",
        "--collect",
        "--quiet",
        `--property=${protectSystem}`,
        "--property=NoNewPrivileges=yes",
        "--property=PrivateTmp=yes",
        process.execPath,
        "-e",
        "import('node:fs/promises').then(({writeFile}) => writeFile(process.argv[1], 'edited'))",
        target,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(await readFile(target, "utf8"), "edited");
  },
);

test("environment and lingering diagnostics are copy-pasteable", () => {
  assert.equal(createEnvironmentFile("/srv/bb"), 'BB_DATA_DIR="/srv/bb"\n');
  assert.equal(
    createEnvironmentFile("/srv/bb data"),
    'BB_DATA_DIR="/srv/bb data"\n',
  );
  assert.match(
    createSystemdUnit({
      homeDir: "/home/alice",
      dataDir: "/srv/bb data",
      stateDir: "/home/alice/.local/state/bb local",
      nodePath: "/home/alice/.local/node path/bin/node",
    }),
    /ReadWritePaths="\/srv\/bb data" "\/home\/alice\/\.local\/state\/bb local"/u,
  );
  assert.equal(
    lingeringRemediation("alice"),
    "sudo loginctl enable-linger alice",
  );
});
