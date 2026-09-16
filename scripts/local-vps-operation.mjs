import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const VPS_UPDATE_PHASES = new Set([
  "validating",
  "building",
  "draining",
  "sealing",
  "sealed",
  "activating",
  "verifying",
  "rolling-back",
  "rollback-verified",
  "rollback-failed",
  "releasing",
  "plugins",
  "pruning",
  "pushing",
  "complete",
  "validation-failed",
  "build-failed",
  "active-work-refused",
  "barrier-failed",
  "candidate-failed",
  "release-failed",
  "plugin-failed",
  "prune-failed",
  "push-failed",
]);

const VPS_UPDATE_TRANSITIONS = new Map([
  [null, new Set(["validating"])],
  [
    "validating",
    new Set(["validating", "building", "complete", "validation-failed"]),
  ],
  ["building", new Set(["activating", "draining", "complete", "build-failed"])],
  ["draining", new Set(["sealing", "active-work-refused", "barrier-failed"])],
  ["sealing", new Set(["sealed", "barrier-failed"])],
  ["sealed", new Set(["activating", "rolling-back"])],
  ["activating", new Set(["verifying", "rolling-back", "candidate-failed"])],
  [
    "verifying",
    new Set([
      "plugins",
      "rolling-back",
      "releasing",
      "pruning",
      "candidate-failed",
    ]),
  ],
  ["rolling-back", new Set(["rollback-verified", "rollback-failed"])],
  ["rollback-verified", new Set(["releasing"])],
  [
    "releasing",
    new Set(["plugins", "pruning", "candidate-failed", "release-failed"]),
  ],
  [
    "plugins",
    new Set([
      "rolling-back",
      "releasing",
      "pruning",
      "candidate-failed",
      "plugin-failed",
    ]),
  ],
  ["pruning", new Set(["pushing", "complete", "prune-failed"])],
  ["pushing", new Set(["complete", "push-failed"])],
  ["complete", new Set()],
  ["validation-failed", new Set()],
  ["build-failed", new Set()],
  ["active-work-refused", new Set()],
  ["barrier-failed", new Set()],
  ["candidate-failed", new Set()],
  ["release-failed", new Set()],
  ["plugin-failed", new Set()],
  ["rollback-failed", new Set()],
  ["prune-failed", new Set()],
  ["push-failed", new Set()],
]);

async function writeRestrictedAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, value, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporaryPath, filePath);
  await chmod(filePath, 0o600);
}

export async function createVpsOperationStore({
  updatesDir,
  operationId,
  now = Date.now,
}) {
  if (!operationId || operationId.includes(path.sep)) {
    throw new Error("operation ID must be a non-empty filename-safe value");
  }
  await mkdir(updatesDir, { recursive: true, mode: 0o700 });
  await chmod(updatesDir, 0o700);
  const recordPath = path.join(updatesDir, `${operationId}.json`);
  const logPath = path.join(updatesDir, `${operationId}.jsonl`);
  let state = null;

  async function transition(phase, details = {}) {
    if (!VPS_UPDATE_PHASES.has(phase))
      throw new Error(`invalid VPS update phase: ${phase}`);
    const previousPhase = state?.phase ?? null;
    if (!VPS_UPDATE_TRANSITIONS.get(previousPhase)?.has(phase)) {
      throw new Error(
        `cannot transition from ${previousPhase ?? "new"} to ${phase}`,
      );
    }
    if (
      state?.dataDir !== undefined &&
      details.dataDir !== undefined &&
      details.dataDir !== state.dataDir
    ) {
      throw new Error("VPS operation data directory cannot change");
    }
    const dataDir = details.dataDir ?? state?.dataDir;
    state = {
      operationId,
      phase,
      updatedAt: now(),
      ...(dataDir === undefined ? {} : { dataDir }),
      ...details,
    };
    const encoded = `${JSON.stringify(state)}\n`;
    await writeRestrictedAtomic(recordPath, encoded);
    await appendFile(logPath, encoded, { encoding: "utf8", mode: 0o600 });
    await chmod(logPath, 0o600);
    return state;
  }

  return {
    logPath,
    operationId,
    recordPath,
    async read() {
      if (state !== null) return state;
      return JSON.parse(await readFile(recordPath, "utf8"));
    },
    transition,
  };
}

export async function readVpsOperation(updatesDir, operationId) {
  return JSON.parse(
    await readFile(path.join(updatesDir, `${operationId}.json`), "utf8"),
  );
}
