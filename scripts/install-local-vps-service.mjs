import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export function parseInstallArgs(argv) {
  let dataDir;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--data-dir") {
      dataDir = argv[index + 1];
      index += 1;
      if (!dataDir || !path.isAbsolute(dataDir)) {
        throw new Error("--data-dir requires an absolute path");
      }
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return { dataDir };
}

export function createEnvironmentFile(dataDir) {
  if (!path.isAbsolute(dataDir) || /[\r\n]/u.test(dataDir)) {
    throw new Error("BB data directory must be an absolute single-line path");
  }
  return `BB_DATA_DIR=${JSON.stringify(dataDir)}\n`;
}

export async function canonicalizeExistingDataDir(dataDir) {
  const canonical = await realpath(dataDir);
  if (!path.isAbsolute(canonical) || /[\r\n]/u.test(canonical)) {
    throw new Error("canonical BB data directory is invalid");
  }
  return canonical;
}

function quoteSystemdPath(value) {
  return JSON.stringify(value);
}

export function createSystemdUnit({ homeDir, dataDir, stateDir, nodePath }) {
  for (const value of [homeDir, dataDir, stateDir, nodePath]) {
    if (!path.isAbsolute(value) || /[\r\n]/u.test(value)) {
      throw new Error("systemd paths must be absolute single-line paths");
    }
  }
  return `[Unit]
Description=bb local headless service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=%h/.config/bb-local/environment
WorkingDirectory=%h/.local/share/bb-local/current
ExecStart=${quoteSystemdPath(nodePath)} %h/.local/share/bb-local/current/packages/bb-app/dist/bb-app.js --data-dir \${BB_DATA_DIR} --server-bind-host 127.0.0.1
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
UMask=0077
ReadOnlyPaths=%h/.local/share/bb-local/releases
ReadWritePaths=${quoteSystemdPath(dataDir)} ${quoteSystemdPath(stateDir)}

[Install]
WantedBy=default.target
`;
}

export function lingeringRemediation(user) {
  if (!user || /\s/u.test(user)) throw new Error("invalid user name");
  return `sudo loginctl enable-linger ${user}`;
}

function run(command, args, { allowFailure = false, capture = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  if (status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(" ")} exited ${status}`);
  }
  return {
    status,
    stdout: typeof result.stdout === "string" ? result.stdout.trim() : "",
  };
}

export async function installLocalVpsService(argv, runtime = {}) {
  if (process.platform !== "linux" || process.arch !== "arm64") {
    throw new Error(
      "the local VPS service currently supports Linux arm64 only",
    );
  }
  const options = parseInstallArgs(argv);
  const homeDir = runtime.homeDir ?? os.homedir();
  const requestedDataDir = options.dataDir ?? path.join(homeDir, ".bb");
  const configDir = path.join(homeDir, ".config", "bb-local");
  const unitDir = path.join(homeDir, ".config", "systemd", "user");
  const stateDir = path.join(homeDir, ".local", "state", "bb-local");
  const nodePath = await realpath(process.execPath);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await mkdir(unitDir, { recursive: true, mode: 0o700 });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(requestedDataDir, { recursive: true, mode: 0o700 });
  const dataDir = await canonicalizeExistingDataDir(requestedDataDir);
  await chmod(dataDir, 0o700);
  const environmentPath = path.join(configDir, "environment");
  const unitPath = path.join(unitDir, "bb-local.service");
  await writeFile(environmentPath, createEnvironmentFile(dataDir), {
    mode: 0o600,
  });
  await chmod(environmentPath, 0o600);
  await writeFile(
    unitPath,
    createSystemdUnit({ homeDir, dataDir, stateDir, nodePath }),
    { mode: 0o644 },
  );
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "bb-local.service"]);
  const user = process.env.USER ?? os.userInfo().username;
  const lingering = run(
    "loginctl",
    ["show-user", user, "-p", "Linger", "--value"],
    {
      allowFailure: true,
      capture: true,
    },
  );
  if (lingering.status !== 0 || lingering.stdout !== "yes") {
    console.log(
      `User lingering is disabled. Optional administrator command: ${lingeringRemediation(user)}`,
    );
  }
  console.log(`Installed ${unitPath}`);
  console.log(`BB data directory: ${dataDir}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  installLocalVpsService(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 3;
  });
}
