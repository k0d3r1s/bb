import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const codeGraphTools = Object.freeze([
  {
    name: "codegraph_search",
    description: "Find indexed symbols by name in the authorized checkout.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 10000 },
        kind: {
          type: "string",
          enum: [
            "function",
            "method",
            "class",
            "interface",
            "type",
            "variable",
            "route",
            "component",
          ],
        },
        limit: { type: "number", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "codegraph_context",
    description: "Build focused indexed context for a task in the authorized checkout.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["task"],
      properties: {
        task: { type: "string", minLength: 1, maxLength: 10000 },
        maxNodes: { type: "number", minimum: 1, maximum: 200 },
        includeCode: { type: "boolean" },
        format: { type: "string", enum: ["markdown", "json"] },
      },
    },
  },
  {
    name: "codegraph_callers",
    description: "Find indexed callers of one symbol in the authorized checkout.",
    parameters: symbolParameters("limit"),
  },
  {
    name: "codegraph_callees",
    description: "Find indexed callees of one symbol in the authorized checkout.",
    parameters: symbolParameters("limit"),
  },
  {
    name: "codegraph_impact",
    description: "Find indexed symbols affected by changing one symbol.",
    parameters: symbolParameters("depth"),
  },
  {
    name: "codegraph_node",
    description: "Read one indexed symbol or file, with structural relationships.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        symbol: { type: "string", minLength: 1, maxLength: 10000 },
        includeCode: { type: "boolean" },
        file: { type: "string", minLength: 1, maxLength: 4096 },
        offset: { type: "number", minimum: 1 },
        limit: { type: "number", minimum: 1, maximum: 2000 },
        symbolsOnly: { type: "boolean" },
        line: { type: "number", minimum: 1 },
      },
    },
  },
  {
    name: "codegraph_explore",
    description: "Return focused indexed source and relationships for a code question.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 10000 },
        maxFiles: { type: "number", minimum: 1, maximum: 20 },
      },
    },
  },
  {
    name: "codegraph_status",
    description: "Check CodeGraph index health for the authorized checkout.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "codegraph_files",
    description: "List indexed files and symbol counts in the authorized checkout.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1, maxLength: 4096 },
        pattern: { type: "string", minLength: 1, maxLength: 4096 },
        format: { type: "string", enum: ["tree", "flat", "grouped"] },
        includeMetadata: { type: "boolean" },
        maxDepth: { type: "number", minimum: 1, maximum: 100 },
      },
    },
  },
]);

export const CODEGRAPH_TOOL_NAMES = Object.freeze(
  codeGraphTools.map((tool) => tool.name),
);

function symbolParameters(numberField) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["symbol"],
    properties: {
      symbol: { type: "string", minLength: 1, maxLength: 10000 },
      file: { type: "string", minLength: 1, maxLength: 4096 },
      [numberField]: { type: "number", minimum: 1, maximum: 100 },
    },
  };
}

function deny(message) {
  throw new Error(`Shared runtime CodeGraph denied: ${message}`);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

async function verifyCommand(policy) {
  if (
    typeof policy.codegraphCommand !== "string" ||
    typeof policy.codegraphRoot !== "string" ||
    !path.isAbsolute(policy.codegraphCommand) ||
    !path.isAbsolute(policy.codegraphRoot)
  ) {
    deny(
      "CodeGraph is not pinned in the operator policy; rerun bb-shared-runtime install from the primary checkout",
    );
  }
  const [command, root] = await Promise.all([
    realpath(policy.codegraphCommand),
    realpath(policy.codegraphRoot),
  ]);
  if (
    command !== policy.codegraphCommand ||
    root !== policy.codegraphRoot ||
    !isInside(root, command)
  ) {
    deny("operator-pinned CodeGraph paths changed");
  }
  const [commandStat, rootStat] = await Promise.all([stat(command), stat(root)]);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !rootStat.isDirectory() ||
    (rootStat.mode & 0o022) !== 0 ||
    (currentUid !== null && rootStat.uid !== currentUid)
  ) {
    deny("operator-pinned CodeGraph root has unsafe ownership or permissions");
  }
  if (
    !commandStat.isFile() ||
    commandStat.nlink !== 1 ||
    (commandStat.mode & 0o111) === 0 ||
    (currentUid !== null && commandStat.uid !== currentUid)
  ) {
    deny("operator-pinned CodeGraph command is not executable");
  }
  return command;
}

function validateWorkspaceArguments(input) {
  const sanitized = { ...(input ?? {}) };
  delete sanitized.projectPath;
  for (const field of ["file", "path"]) {
    const value = sanitized[field];
    if (value === undefined) continue;
    if (
      typeof value !== "string" ||
      path.isAbsolute(value) ||
      value.includes("\0")
    ) {
      deny(`${field} must be a relative workspace path`);
    }
    const normalized = path.normalize(value);
    if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
      deny(`${field} escapes the authorized workspace`);
    }
  }
  return sanitized;
}

function renderToolResult(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const text = blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  if (result?.isError) {
    throw new Error(text || "CodeGraph returned an error");
  }
  return text || JSON.stringify(result ?? null);
}

function codeGraphEnvironment() {
  const environment = {
    CODEGRAPH_MCP_TOOLS:
      "explore,context,node,search,callers,callees,impact,files,status",
  };
  for (const name of ["HOME", "LANG", "LC_ALL", "PATH", "TEMP", "TMP", "TMPDIR"]) {
    if (typeof process.env[name] === "string") {
      environment[name] = process.env[name];
    }
  }
  return environment;
}

function contextFallbackArguments(input, root) {
  const maxFiles =
    typeof input.maxNodes === "number"
      ? Math.max(1, Math.min(20, Math.ceil(input.maxNodes / 10)))
      : undefined;
  return {
    query: input.task,
    ...(maxFiles === undefined ? {} : { maxFiles }),
    projectPath: root,
  };
}

function resultReportsMissingTool(result) {
  if (!result?.isError || !Array.isArray(result.content)) return false;
  return result.content.some(
    (block) =>
      block?.type === "text" &&
      typeof block.text === "string" &&
      /unknown|unsupported|not found|no such tool/i.test(block.text),
  );
}

export async function executeCodeGraphTool(
  policy,
  workspace,
  toolName,
  input,
  options = {},
) {
  if (!CODEGRAPH_TOOL_NAMES.includes(toolName)) {
    deny("unsupported tool");
  }
  if (options.signal?.aborted) {
    throw new Error("CodeGraph request aborted");
  }
  const sanitizedInput = validateWorkspaceArguments(input);
  const command = await verifyCommand(policy);
  const root = await realpath(workspace.hostRoot);
  if (root !== workspace.hostRoot) {
    deny("workspace path changed after authorization");
  }

  const launch = options.spawn ?? spawn;
  const child = launch(command, ["serve", "--mcp", "--path", root], {
    cwd: root,
    env: codeGraphEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const timeoutMs = options.timeoutMs ?? 30_000;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let settled = false;
  let exited = false;
  let nextId = 1;
  const pending = new Map();

  const finish = () => {
    if (settled) return;
    settled = true;
    options.signal?.removeEventListener("abort", onAbort);
    try {
      child.stdin.end();
    } catch {
    }
    child.kill();
  };
  const failAll = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
    finish();
  };
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method, params) => {
    if (settled || exited) {
      return Promise.reject(new Error("CodeGraph process is not available"));
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
    });
  };
  const onAbort = () => failAll(new Error("CodeGraph request aborted"));

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrBuffer = `${stderrBuffer}${chunk}`.slice(-65_536);
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    if (stdoutBuffer.length > 2_000_000) {
      failAll(new Error("CodeGraph response exceeded its output bound"));
      return;
    }
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        failAll(new Error("CodeGraph returned invalid JSON-RPC"));
        return;
      }
      if (message.method && message.id !== undefined) {
        if (message.method === "roots/list") {
          send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              roots: [
                { uri: pathToFileURL(root).href, name: "Shared runtime workspace" },
              ],
            },
          });
        } else if (message.method === "ping") {
          send({ jsonrpc: "2.0", id: message.id, result: {} });
        } else {
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Unsupported server request" },
          });
        }
        continue;
      }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) {
        waiter.reject(new Error(message.error.message || "CodeGraph RPC error"));
      }
      else waiter.resolve(message.result);
    }
  });
  child.on("error", (error) => failAll(error));
  child.stdin.on("error", (error) => failAll(error));
  child.on("exit", (code, signal) => {
    exited = true;
    if (!settled && pending.size > 0) {
      failAll(
        new Error(
          `CodeGraph exited before replying (${signal ?? code}); ${stderrBuffer.trim()}`,
        ),
      );
    }
  });
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  const timer = setTimeout(
    () => failAll(new Error(`CodeGraph timed out; ${stderrBuffer.trim()}`)),
    timeoutMs,
  );
  timer.unref?.();
  try {
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: "bb-plugin-shared-runtime", version: "1" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    let result;
    try {
      result = await request("tools/call", {
        name: toolName,
        arguments: { ...sanitizedInput, projectPath: root },
      });
    } catch (error) {
      if (
        toolName !== "codegraph_context" ||
        !/unknown|unsupported|not found|no such tool/i.test(String(error?.message))
      ) {
        throw error;
      }
      result = await request("tools/call", {
        name: "codegraph_explore",
        arguments: contextFallbackArguments(sanitizedInput, root),
      });
    }
    if (toolName === "codegraph_context" && resultReportsMissingTool(result)) {
      result = await request("tools/call", {
        name: "codegraph_explore",
        arguments: contextFallbackArguments(sanitizedInput, root),
      });
    }
    return renderToolResult(result);
  } finally {
    clearTimeout(timer);
    finish();
  }
}
