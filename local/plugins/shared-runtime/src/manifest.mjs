import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const MANIFEST_FILE_NAME = ".bb-runtime.json";
export const MANIFEST_VERSION = 1;
export const DEFAULT_WORKTREE_CONTAINER_ROOT = "/bb-worktrees";
export const PRIMARY_ROOT_PLACEHOLDER = "${primaryRoot}";

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const ROLE_PATTERN = /^[a-z][a-z0-9_-]*$/;
const SERVICE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const PLACEHOLDER_PATTERN = /\$\{([a-zA-Z0-9_.-]+)\}/g;
const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const SCRIPT_INTERPRETERS = new Set(["node", "nodejs", "php", "python", "python3", "perl", "ruby"]);
const LIFECYCLE_OPERATIONS = Object.freeze(["ensure", "recreate", "stop"]);

function deny(message) {
  throw new Error(`Shared runtime manifest invalid: ${message}`);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    deny(`${label} must be a non-empty string`);
  }
  return value;
}

function assertOptionalBoolean(value, label) {
  if (value !== undefined && typeof value !== "boolean") {
    deny(`${label} must be a boolean`);
  }
  return value === true;
}

export function validateRepositoryRelativePath(value, label, { allowRoot = false } = {}) {
  assertString(value, label);
  if (path.posix.isAbsolute(value) || value.startsWith("-") || value.includes("\\")) {
    deny(`${label} must be a repository-relative POSIX path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === "./") {
    if (!allowRoot) {
      deny(`${label} may not be the repository root`);
    }
    return ".";
  }
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..")
  ) {
    deny(`${label} escapes the repository`);
  }
  return normalized.replace(/\/+$/, "");
}

function assertAbsoluteContainerPath(value, label) {
  assertString(value, label);
  if (!path.posix.isAbsolute(value) || value.includes("\\")) {
    deny(`${label} must be an absolute container path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized.includes("/../") || normalized.endsWith("/..")) {
    deny(`${label} escapes its root`);
  }
  return normalized === "/" ? "/" : normalized.replace(/\/+$/, "");
}

function assertArgv(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    deny(`${label} must be a non-empty argument array`);
  }
  for (const [index, argument] of value.entries()) {
    if (typeof argument !== "string" || argument.includes("\0")) {
      deny(`${label}[${index}] must be a string`);
    }
  }
  const program = value[0];
  if (program === "" || program.startsWith("-")) {
    deny(`${label} program is invalid`);
  }
  const base = path.posix.basename(program);
  if (SHELL_INTERPRETERS.has(base)) {
    if (value.length < 2 || value.slice(1).some((argument) => /^-(?:c|i|s)$/.test(argument))) {
      deny(`${label} may not evaluate inline shell text`);
    }
  }
  if (SCRIPT_INTERPRETERS.has(base)) {
    if (value.slice(1).some((argument) => /^(?:-e|--eval|-p|--print|-r)$/.test(argument))) {
      deny(`${label} may not evaluate inline script text`);
    }
  }
  return [...value];
}

function collectPlaceholders(value, into) {
  for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
    into.add(match[1]);
  }
}

function assertEnvironment(value, label) {
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value)) {
    deny(`${label} must be an object`);
  }
  const environment = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      deny(`${label} name ${JSON.stringify(name)} is invalid`);
    }
    if (typeof entry !== "string" || entry.includes("\0")) {
      deny(`${label}.${name} must be a string`);
    }
    environment[name] = entry;
  }
  return environment;
}

function knownPlaceholders(manifest, { allowTarget = false, host = false } = {}) {
  const names = new Set([
    "root",
    "cwd",
    "env",
    "envSlug",
    "tmp",
    "runtime",
    "primaryRoot",
    "hostRoot",
    "docker",
  ]);
  if (allowTarget) {
    names.add("target");
  }
  for (const scratchName of Object.keys(manifest.scratch)) {
    names.add(`scratch.${scratchName}`);
  }
  for (const role of Object.keys(manifest.containers)) {
    names.add(`launcher.${role}`);
    names.add(`root.${role}`);
    names.add(`runtime.${role}`);
  }
  if (host) {
    names.add("worktreeRoot");
  }
  return names;
}

function assertPlaceholders(values, allowed, label) {
  const used = new Set();
  for (const value of values) {
    collectPlaceholders(value, used);
  }
  for (const name of used) {
    if (!allowed.has(name)) {
      deny(`${label} references unknown placeholder ${JSON.stringify(name)}`);
    }
  }
  return used;
}

function validateTarget(value, label) {
  if (value === undefined) {
    return null;
  }
  if (!isPlainObject(value)) {
    deny(`${label} must be an object`);
  }
  const target = {
    description:
      value.description === undefined ? null : assertString(value.description, `${label}.description`),
    pattern: null,
    required: assertOptionalBoolean(value.required, `${label}.required`),
    variants: null,
  };
  if (value.pattern !== undefined) {
    assertString(value.pattern, `${label}.pattern`);
    let expression;
    try {
      expression = new RegExp(value.pattern);
    } catch {
      deny(`${label}.pattern is not a valid regular expression`);
    }
    if (!value.pattern.startsWith("^") || !value.pattern.endsWith("$")) {
      deny(`${label}.pattern must be anchored with ^ and $`);
    }
    target.pattern = expression;
    target.patternSource = value.pattern;
  }
  if (value.variants !== undefined) {
    if (!isPlainObject(value.variants) || Object.keys(value.variants).length === 0) {
      deny(`${label}.variants must be a non-empty object`);
    }
    target.variants = value.variants;
  }
  if (target.pattern === null && target.variants === null) {
    deny(`${label} needs a pattern or variants`);
  }
  if (target.pattern !== null && target.variants !== null) {
    deny(`${label} may not combine a pattern with variants`);
  }
  return target;
}

function validateContainerStep(manifest, value, label, { allowTarget }) {
  const role = assertString(value.container, `${label}.container`);
  if (!Object.hasOwn(manifest.containers, role)) {
    deny(`${label}.container ${JSON.stringify(role)} is not declared`);
  }
  const container = manifest.containers[role];
  const cwd =
    value.cwd === undefined
      ? container.root
      : validateRepositoryRelativePath(value.cwd, `${label}.cwd`, { allowRoot: true });
  const argv = assertArgv(value.argv, `${label}.argv`);
  const environment = assertEnvironment(value.env, `${label}.env`);
  const failOnStdout = assertOptionalBoolean(value.failOnStdout, `${label}.failOnStdout`);
  const allowed = knownPlaceholders(manifest, { allowTarget });
  const placeholders = assertPlaceholders(
    [...argv, ...Object.values(environment)],
    allowed,
    label,
  );
  return Object.freeze({
    kind: "container",
    container: role,
    cwd,
    argv,
    environment,
    failOnStdout,
    usesTarget: placeholders.has("target"),
  });
}

function validateHostStep(manifest, value, label, { allowTarget }) {
  const argv = assertArgv(value.argv, `${label}.argv`);
  const base = path.posix.basename(argv[0]);
  if (!SHELL_INTERPRETERS.has(base) && !SCRIPT_INTERPRETERS.has(base)) {
    deny(`${label}.argv host steps must start with a known interpreter`);
  }
  if (argv.length < 2) {
    deny(`${label}.argv host steps need a primary-checkout script`);
  }
  const script = validateRepositoryRelativePath(argv[1], `${label}.argv[1]`);
  const environment = assertEnvironment(value.env, `${label}.env`);
  const containers = value.containers === undefined ? [] : value.containers;
  if (!Array.isArray(containers)) {
    deny(`${label}.containers must be an array`);
  }
  for (const role of containers) {
    if (typeof role !== "string" || !Object.hasOwn(manifest.containers, role)) {
      deny(`${label}.containers references undeclared container ${JSON.stringify(role)}`);
    }
  }
  const allowed = knownPlaceholders(manifest, { allowTarget, host: true });
  const placeholders = assertPlaceholders(
    [...argv.slice(2), ...Object.values(environment)],
    allowed,
    label,
  );
  return Object.freeze({
    kind: "host",
    interpreter: base,
    script,
    argv: argv.slice(2),
    environment,
    containers: Object.freeze([...containers]),
    usesTarget: placeholders.has("target"),
  });
}

function validateStep(manifest, value, label, options) {
  if (!isPlainObject(value)) {
    deny(`${label} must be an object`);
  }
  if (value.kind === "host") {
    return validateHostStep(manifest, value, label, options);
  }
  if (value.kind !== undefined && value.kind !== "container") {
    deny(`${label}.kind must be "container" or "host"`);
  }
  return validateContainerStep(manifest, value, label, options);
}

function validateOperation(manifest, name, value, { nested = false } = {}) {
  const label = `operations.${name}`;
  if (!isPlainObject(value)) {
    deny(`${label} must be an object`);
  }
  if (value.steps !== undefined) {
    if (nested) {
      deny(`${label} may not nest step lists`);
    }
    if (!Array.isArray(value.steps) || value.steps.length === 0) {
      deny(`${label}.steps must be a non-empty array`);
    }
    if (value.target !== undefined) {
      deny(`${label} step lists do not accept a target`);
    }
    const steps = value.steps.map((step, index) => {
      if (typeof step === "string") {
        return { reference: step };
      }
      return validateStep(manifest, step, `${label}.steps[${index}]`, { allowTarget: false });
    });
    return Object.freeze({ kind: "sequence", steps: Object.freeze(steps), target: null });
  }
  const target = validateTarget(value.target, `${label}.target`);
  const step = validateStep(manifest, value, label, { allowTarget: target?.pattern !== null && target !== null });
  if (target?.pattern && !step.usesTarget) {
    deny(`${label} declares a target pattern but never uses \${target}`);
  }
  let variants = null;
  if (target?.variants) {
    variants = {};
    for (const [variantName, variantValue] of Object.entries(target.variants)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(variantName)) {
        deny(`${label}.target.variants name ${JSON.stringify(variantName)} is invalid`);
      }
      variants[variantName] = validateStep(
        manifest,
        variantValue,
        `${label}.target.variants.${variantName}`,
        { allowTarget: false },
      );
    }
  }
  return Object.freeze({
    kind: "single",
    step,
    target:
      target === null
        ? null
        : Object.freeze({
            description: target.description,
            pattern: target.pattern,
            patternSource: target.patternSource ?? null,
            required: target.required,
            variants: variants === null ? null : Object.freeze(variants),
          }),
  });
}

function validateDependency(value, index) {
  const label = `dependencies[${index}]`;
  if (!isPlainObject(value)) {
    deny(`${label} must be an object`);
  }
  const dependencyPath = validateRepositoryRelativePath(value.path, `${label}.path`);
  const wildcardCount = dependencyPath.split("/").filter((segment) => segment === "*").length;
  if (dependencyPath.split("/").some((segment) => segment.includes("*") && segment !== "*")) {
    deny(`${label}.path wildcards must be whole path segments`);
  }
  if (value.link !== undefined && value.mirror !== undefined) {
    deny(`${label} may not be both a link and a mirror`);
  }
  if (value.link !== undefined) {
    const link = assertAbsoluteContainerPath(value.link, `${label}.link`);
    if (wildcardCount !== link.split("/").filter((segment) => segment === "*").length) {
      deny(`${label}.link must repeat every wildcard segment of path`);
    }
    if (value.local !== undefined) {
      deny(`${label}.local is only valid for mirrors`);
    }
    return Object.freeze({ kind: "link", path: dependencyPath, target: link, local: Object.freeze([]) });
  }
  if (value.mirror === undefined) {
    deny(`${label} needs a link or mirror target`);
  }
  const mirror = assertAbsoluteContainerPath(value.mirror, `${label}.mirror`);
  if (wildcardCount !== mirror.split("/").filter((segment) => segment === "*").length) {
    deny(`${label}.mirror must repeat every wildcard segment of path`);
  }
  const local = value.local === undefined ? [] : value.local;
  if (!Array.isArray(local)) {
    deny(`${label}.local must be an array`);
  }
  for (const entry of local) {
    if (typeof entry !== "string" || entry === "" || entry.includes("/") || entry === "." || entry === "..") {
      deny(`${label}.local entries must be single directory names`);
    }
  }
  return Object.freeze({ kind: "mirror", path: dependencyPath, target: mirror, local: Object.freeze([...local]) });
}

function validateContainers(value) {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    deny("containers must declare at least one container");
  }
  const containers = {};
  for (const [role, entry] of Object.entries(value)) {
    if (!ROLE_PATTERN.test(role)) {
      deny(`containers role ${JSON.stringify(role)} is invalid`);
    }
    if (!isPlainObject(entry)) {
      deny(`containers.${role} must be an object`);
    }
    const service = assertString(entry.service, `containers.${role}.service`);
    if (!SERVICE_PATTERN.test(service)) {
      deny(`containers.${role}.service is invalid`);
    }
    if (!Array.isArray(entry.mounts) || entry.mounts.length === 0) {
      deny(`containers.${role}.mounts must list at least one mount`);
    }
    const mounts = entry.mounts.map((mount, index) => {
      const label = `containers.${role}.mounts[${index}]`;
      if (!isPlainObject(mount)) {
        deny(`${label} must be an object`);
      }
      const host = validateRepositoryRelativePath(mount.host, `${label}.host`, { allowRoot: true });
      const container =
        mount.container === PRIMARY_ROOT_PLACEHOLDER
          ? PRIMARY_ROOT_PLACEHOLDER
          : assertAbsoluteContainerPath(mount.container, `${label}.container`);
      return Object.freeze({ host, container });
    });
    const root =
      entry.root === undefined
        ? "."
        : validateRepositoryRelativePath(entry.root, `containers.${role}.root`, { allowRoot: true });
    containers[role] = Object.freeze({
      service,
      mounts: Object.freeze(mounts),
      root,
      containerName:
        entry.containerName === undefined
          ? null
          : assertString(entry.containerName, `containers.${role}.containerName`),
    });
  }
  return Object.freeze(containers);
}

function validateScratch(value) {
  if (value === undefined) {
    return Object.freeze({});
  }
  if (!isPlainObject(value)) {
    deny("scratch must be an object");
  }
  const scratch = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      deny(`scratch name ${JSON.stringify(name)} is invalid`);
    }
    const environment = entry?.env === undefined ? [] : entry.env;
    if (!isPlainObject(entry ?? {}) || !Array.isArray(environment)) {
      deny(`scratch.${name} must be an object with an optional env array`);
    }
    for (const variable of environment) {
      if (typeof variable !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(variable)) {
        deny(`scratch.${name}.env entries must be environment variable names`);
      }
    }
    scratch[name] = Object.freeze({ environment: Object.freeze([...environment]) });
  }
  return Object.freeze(scratch);
}

function validateLifecycle(value) {
  if (value === undefined) {
    return Object.freeze({});
  }
  if (!isPlainObject(value)) {
    deny("lifecycle must be an object");
  }
  const lifecycle = {};
  for (const [operation, argv] of Object.entries(value)) {
    if (!LIFECYCLE_OPERATIONS.includes(operation)) {
      deny(`lifecycle.${operation} is not a lifecycle operation`);
    }
    const validated = assertArgv(argv, `lifecycle.${operation}`);
    const base = path.posix.basename(validated[0]);
    if (!SHELL_INTERPRETERS.has(base) && !SCRIPT_INTERPRETERS.has(base)) {
      deny(`lifecycle.${operation} must start with a known interpreter`);
    }
    if (validated.length < 2) {
      deny(`lifecycle.${operation} needs a primary-checkout script`);
    }
    validateRepositoryRelativePath(validated[1], `lifecycle.${operation}[1]`);
    for (const argument of validated.slice(2)) {
      if (argument.includes("${")) {
        deny(`lifecycle.${operation} arguments may not use placeholders`);
      }
    }
    lifecycle[operation] = Object.freeze(validated);
  }
  return Object.freeze(lifecycle);
}

function validateGit(manifest, value) {
  const result = { generators: [], hardlinks: [] };
  if (value === undefined) {
    return Object.freeze({ generators: Object.freeze([]), hardlinks: Object.freeze([]) });
  }
  if (!isPlainObject(value)) {
    deny("git must be an object");
  }
  const prepare = value.prepareCommit;
  if (prepare !== undefined) {
    if (!isPlainObject(prepare)) {
      deny("git.prepareCommit must be an object");
    }
    const generators = prepare.generators === undefined ? [] : prepare.generators;
    if (!Array.isArray(generators)) {
      deny("git.prepareCommit.generators must be an array");
    }
    result.generators = generators.map((generator, index) => {
      const label = `git.prepareCommit.generators[${index}]`;
      if (!isPlainObject(generator) || generator.kind === "host") {
        deny(`${label} must be a container step`);
      }
      const step = validateContainerStep(manifest, generator, label, { allowTarget: false });
      const requires =
        generator.requires === undefined
          ? null
          : validateRepositoryRelativePath(generator.requires, `${label}.requires`);
      const stages = generator.stages === undefined ? [] : generator.stages;
      if (!Array.isArray(stages)) {
        deny(`${label}.stages must be an array`);
      }
      return Object.freeze({
        step,
        requires,
        stages: Object.freeze(
          stages.map((entry, stageIndex) =>
            validateRepositoryRelativePath(entry, `${label}.stages[${stageIndex}]`),
          ),
        ),
        tolerateMissingExecutable: assertOptionalBoolean(
          generator.tolerateMissingExecutable,
          `${label}.tolerateMissingExecutable`,
        ),
      });
    });
    const hardlinks = prepare.hardlinks === undefined ? [] : prepare.hardlinks;
    if (!Array.isArray(hardlinks)) {
      deny("git.prepareCommit.hardlinks must be an array");
    }
    result.hardlinks = hardlinks.map((entry, index) => {
      const label = `git.prepareCommit.hardlinks[${index}]`;
      if (!isPlainObject(entry)) {
        deny(`${label} must be an object`);
      }
      return Object.freeze({
        source: validateRepositoryRelativePath(entry.source, `${label}.source`),
        target: validateRepositoryRelativePath(entry.target, `${label}.target`),
      });
    });
  }
  return Object.freeze({
    generators: Object.freeze(result.generators),
    hardlinks: Object.freeze(result.hardlinks),
  });
}

export function validateManifest(document) {
  if (!isPlainObject(document)) {
    deny("document must be a JSON object");
  }
  if (document.version !== MANIFEST_VERSION) {
    deny(`version must be ${MANIFEST_VERSION}`);
  }
  const manifest = {
    version: MANIFEST_VERSION,
    name:
      document.name === undefined ? null : assertString(document.name, "name"),
    containers: validateContainers(document.containers),
    scratch: validateScratch(document.scratch),
    lifecycle: validateLifecycle(document.lifecycle),
    worktrees: Object.freeze({
      containerRoot:
        document.worktrees === undefined
          ? DEFAULT_WORKTREE_CONTAINER_ROOT
          : assertAbsoluteContainerPath(
              document.worktrees?.containerRoot,
              "worktrees.containerRoot",
            ),
    }),
    search: Object.freeze({
      defaultPath:
        document.search?.defaultPath === undefined
          ? "."
          : validateRepositoryRelativePath(document.search.defaultPath, "search.defaultPath", {
              allowRoot: true,
            }),
    }),
    codegraph: Object.freeze({
      enabled: document.codegraph === undefined ? true : assertOptionalBoolean(
        document.codegraph?.enabled,
        "codegraph.enabled",
      ),
    }),
    compose: Object.freeze({
      envFile:
        document.compose?.envFile === undefined
          ? null
          : validateRepositoryRelativePath(document.compose.envFile, "compose.envFile"),
      projectVariable:
        document.compose?.projectVariable === undefined
          ? null
          : assertString(document.compose.projectVariable, "compose.projectVariable"),
    }),
  };
  if (manifest.compose.projectVariable !== null && !/^[A-Z_][A-Z0-9_]*$/.test(manifest.compose.projectVariable)) {
    deny("compose.projectVariable must be an environment variable name");
  }

  if (document.isolation !== undefined) {
    if (!isPlainObject(document.isolation)) {
      deny("isolation must be an object");
    }
    const builder = assertString(document.isolation.builder, "isolation.builder");
    if (!Object.hasOwn(manifest.containers, builder)) {
      deny(`isolation.builder ${JSON.stringify(builder)} is not a declared container`);
    }
    let probe = builder;
    if (document.isolation.probe !== undefined) {
      probe = assertString(document.isolation.probe, "isolation.probe");
      if (!Object.hasOwn(manifest.containers, probe)) {
        deny(`isolation.probe ${JSON.stringify(probe)} is not a declared container`);
      }
    }
    manifest.isolation = Object.freeze({ builder, probe });
  } else {
    manifest.isolation = null;
  }

  if (document.dependencies !== undefined && !Array.isArray(document.dependencies)) {
    deny("dependencies must be an array");
  }
  manifest.dependencies = Object.freeze(
    (document.dependencies ?? []).map((entry, index) => validateDependency(entry, index)),
  );

  if (!isPlainObject(document.operations ?? {})) {
    deny("operations must be an object");
  }
  const operations = {};
  for (const [name, value] of Object.entries(document.operations ?? {})) {
    if (!NAME_PATTERN.test(name) || name.length > 64) {
      deny(`operation name ${JSON.stringify(name)} is invalid`);
    }
    operations[name] = validateOperation(manifest, name, value);
  }
  for (const [name, operation] of Object.entries(operations)) {
    if (operation.kind !== "sequence") {
      continue;
    }
    for (const step of operation.steps) {
      if (step.reference === undefined) {
        continue;
      }
      const referenced = operations[step.reference];
      if (!referenced) {
        deny(`operations.${name} references unknown operation ${JSON.stringify(step.reference)}`);
      }
      if (referenced.kind !== "single") {
        deny(`operations.${name} may only reference single-step operations`);
      }
      if (referenced.target?.required) {
        deny(`operations.${name} may not reference an operation that requires a target`);
      }
    }
  }
  manifest.operations = Object.freeze(operations);
  manifest.git = validateGit(manifest, document.git);

  const needsIsolation =
    Object.values(operations).some((operation) => operation.kind !== "sequence" ? operation.step.kind === "container" || operation.target?.variants : true) ||
    manifest.git.generators.length > 0;
  if (needsIsolation && manifest.isolation === null) {
    deny("isolation.builder is required when container operations are declared");
  }
  return Object.freeze(manifest);
}

export function manifestDigest(content) {
  return createHash("sha256").update(content).digest("hex");
}

export async function readManifest(primaryRoot, configuredPath) {
  const manifestPath = configuredPath ?? path.join(primaryRoot, MANIFEST_FILE_NAME);
  if (!path.isAbsolute(manifestPath)) {
    deny("manifest path must be absolute");
  }
  let content;
  try {
    content = await readFile(manifestPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Shared runtime manifest missing: ${manifestPath}`);
    }
    throw error;
  }
  let document;
  try {
    document = JSON.parse(content.toString("utf8"));
  } catch {
    deny(`${manifestPath} is not valid JSON`);
  }
  return Object.freeze({
    digest: manifestDigest(content),
    manifest: validateManifest(document),
    path: manifestPath,
  });
}

export function substitutePlaceholders(value, variables, label = "value") {
  return value.replace(PLACEHOLDER_PATTERN, (_match, name) => {
    if (!Object.hasOwn(variables, name)) {
      throw new Error(`Shared runtime denied: ${label} references unresolved placeholder ${JSON.stringify(name)}`);
    }
    return variables[name];
  });
}

export function listOperationNames(manifest) {
  return Object.keys(manifest.operations).sort();
}

export function describeOperations(manifest) {
  return listOperationNames(manifest).map((name) => {
    const operation = manifest.operations[name];
    if (operation.kind === "sequence") {
      const parts = operation.steps.map((step) =>
        step.reference !== undefined ? step.reference : `${step.kind}:${step.argv?.[0] ?? step.script}`,
      );
      return `${name} (sequence: ${parts.join(", ")})`;
    }
    const target = operation.target;
    if (target === null) {
      return name;
    }
    if (target.variants) {
      return `${name} (target one of ${Object.keys(target.variants).map((value) => JSON.stringify(value)).join(", ")})`;
    }
    return `${name} (${target.required ? "requires" : "accepts"} target matching ${target.patternSource}${target.description ? `: ${target.description}` : ""})`;
  });
}

function expandWildcardSegments(segments, primaryRoot, readDirectory) {
  return (async () => {
    let candidates = [{ relative: [], captures: [] }];
    for (const segment of segments) {
      const next = [];
      for (const candidate of candidates) {
        if (segment !== "*") {
          next.push({
            relative: [...candidate.relative, segment],
            captures: candidate.captures,
          });
          continue;
        }
        const directory = path.join(primaryRoot, ...candidate.relative);
        let entries;
        try {
          entries = await readDirectory(directory);
        } catch (error) {
          if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
            continue;
          }
          throw error;
        }
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith(".")) {
            continue;
          }
          next.push({
            relative: [...candidate.relative, entry.name],
            captures: [...candidate.captures, entry.name],
          });
        }
      }
      candidates = next;
    }
    return candidates;
  })();
}

function fillTemplate(template, captures) {
  let index = 0;
  return template
    .split("/")
    .map((segment) => (segment === "*" ? captures[index++] : segment))
    .join("/");
}

export async function expandDependencies(manifest, primaryRoot, { readDirectory, pathExists }) {
  const expanded = [];
  for (const dependency of manifest.dependencies) {
    const segments = dependency.path.split("/");
    if (!segments.includes("*")) {
      expanded.push({ ...dependency, relativePath: dependency.path, containerTarget: dependency.target });
      continue;
    }
    const matches = await expandWildcardSegments(segments, primaryRoot, readDirectory);
    for (const match of matches) {
      const relativePath = match.relative.join("/");
      if (!(await pathExists(path.join(primaryRoot, ...match.relative)))) {
        continue;
      }
      expanded.push({
        ...dependency,
        relativePath,
        containerTarget: fillTemplate(dependency.target, match.captures),
      });
    }
  }
  return expanded;
}
