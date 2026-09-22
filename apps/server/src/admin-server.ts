import { createAdaptorServer, type ServerType } from "@hono/node-server";
import {
  resolveAdminSocketPaths,
  withUnixSocketAddress,
} from "@bb/config/admin-socket";
import {
  maintenanceAcquireRequestSchema,
  maintenanceIdentityResponseSchema,
  maintenanceOwnedRequestSchema,
  maintenanceReleaseRequestSchema,
  maintenanceSealRequestSchema,
  maintenanceTransitionRequestSchema,
} from "@bb/server-contract";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
// oxlint-disable-next-line no-restricted-imports
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { Hono } from "hono";
import { ZodError } from "zod";
import type { WorkQuiesceService } from "./services/system/work-quiesce.js";

type MaintenanceService = Pick<
  WorkQuiesceService,
  "acquire" | "release" | "renew" | "seal" | "status" | "transition"
>;

interface AdminMaintenanceAppOptions {
  capability: string;
  connectedHostIds(): string[];
  releaseIdentity: string;
  service: MaintenanceService;
}

interface StartAdminServerOptions extends AdminMaintenanceAppOptions {
  dataDir: string;
}

export interface AdminServerHandle {
  capabilityPath: string;
  close(): Promise<void>;
  socketPath: string;
}

function capabilityMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

async function parseJson<T>(
  request: Request,
  schema: { parse(value: unknown): T },
): Promise<T> {
  return schema.parse(await request.json());
}

export function createAdminMaintenanceApp(
  options: AdminMaintenanceAppOptions,
): Hono {
  const app = new Hono();
  app.use("*", async (context, next) => {
    const requestId = `req_${randomUUID()}`;
    context.header("x-request-id", requestId);
    const authorization = context.req.header("authorization") ?? "";
    const prefix = "Bearer ";
    if (!authorization.startsWith(prefix)) {
      return context.json(
        {
          requestId,
          code: "missing_admin_capability",
          message: "The local admin capability is required",
          retryable: false,
        },
        401,
      );
    }
    const capability = authorization.startsWith(prefix)
      ? authorization.slice(prefix.length)
      : "";
    if (!capabilityMatches(capability, options.capability)) {
      return context.json(
        {
          requestId,
          code: "invalid_admin_capability",
          message: "The local admin capability is invalid",
          retryable: false,
        },
        403,
      );
    }
    await next();
  });
  app.onError((error, context) => {
    const requestId =
      context.res.headers.get("x-request-id") ?? `req_${randomUUID()}`;
    const code =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "invalid_request";
    const status =
      error instanceof ZodError
        ? 422
        : code === "lease_held" ||
            code === "stale_owner" ||
            code === "invalid_phase" ||
            code === "active_work"
          ? 409
          : code === "barrier_failed"
            ? 503
            : 400;
    if (status === 503) context.header("retry-after", "1");
    return context.json(
      {
        requestId,
        code: error instanceof ZodError ? "invalid_request" : code,
        message: error.message,
        retryable: status === 503,
        ...(error instanceof ZodError ? { details: error.issues } : {}),
      },
      status,
    );
  });
  app.get("/identity", (context) =>
    context.json(
      maintenanceIdentityResponseSchema.parse({
        service: "bb-maintenance",
        protocolVersion: 2,
        releaseIdentity: options.releaseIdentity,
        connectedHostIds: [...options.connectedHostIds()].sort(),
      }),
    ),
  );
  app.get("/maintenance", async (context) =>
    context.json(await options.service.status()),
  );
  app.post("/maintenance/acquisitions", async (context) => {
    const input = await parseJson(
      context.req.raw,
      maintenanceAcquireRequestSchema,
    );
    const response = await options.service.acquire(input);
    return context.json(response, response.replayed ? 200 : 201);
  });
  app.post("/maintenance/renew", async (context) => {
    const input = await parseJson(
      context.req.raw,
      maintenanceAcquireRequestSchema.pick({
        operationId: true,
        ownerSecret: true,
        ttlMs: true,
      }),
    );
    options.service.renew(input);
    return context.json(await options.service.status());
  });
  app.post("/maintenance/seal", async (context) => {
    const input = await parseJson(
      context.req.raw,
      maintenanceSealRequestSchema,
    );
    return context.json(await options.service.seal(input));
  });
  app.post("/maintenance/transition", async (context) => {
    const input = await parseJson(
      context.req.raw,
      maintenanceTransitionRequestSchema,
    );
    options.service.transition(input);
    return context.json(await options.service.status());
  });
  app.post("/maintenance/release", async (context) => {
    const input = await parseJson(
      context.req.raw,
      maintenanceReleaseRequestSchema,
    );
    await options.service.release(input);
    return context.json(await options.service.status());
  });
  app.post("/maintenance/recover", async (context) => {
    const input = await parseJson(
      context.req.raw,
      maintenanceOwnedRequestSchema,
    );
    await options.service.release({ ...input, resolution: "force-aborted" });
    return context.json(await options.service.status());
  });
  return app;
}

function loadOrCreateCapability(capabilityPath: string): string {
  if (existsSync(capabilityPath)) {
    const identity = lstatSync(capabilityPath);
    if (!identity.isFile() || identity.isSymbolicLink()) {
      throw new Error(
        "admin capability must be a regular file, not a link or special file",
      );
    }
    if (
      typeof process.getuid === "function" &&
      identity.uid !== process.getuid()
    ) {
      throw new Error("admin capability must be owned by the service user");
    }
    if ((identity.mode & 0o777) !== 0o600) {
      throw new Error("admin capability must have mode 0600");
    }
    const capability = readFileSync(capabilityPath, "utf8").trim();
    if (capability.length === 0) {
      throw new Error("admin capability file is empty");
    }
    return capability;
  }
  const capability = randomBytes(32).toString("base64url");
  writeFileSync(capabilityPath, `${capability}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return capability;
}

function sameFileIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) return;
  const initial = lstatSync(socketPath);
  if (!initial.isSocket() || initial.isSymbolicLink()) {
    throw new Error(
      "admin socket path must be a Unix socket, not a link or regular file",
    );
  }
  if (
    typeof process.getuid === "function" &&
    initial.uid !== process.getuid()
  ) {
    throw new Error("admin socket must be owned by the service user");
  }
  await new Promise<void>((resolve, reject) => {
    const socket = withUnixSocketAddress(socketPath, (address) =>
      connect(address),
    );
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`admin socket is already active at ${socketPath}`));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
        resolve();
        return;
      }
      reject(error);
    });
  });
  if (!existsSync(socketPath)) return;
  const current = lstatSync(socketPath);
  if (!sameFileIdentity(initial, current)) {
    throw new Error("admin socket changed while checking stale ownership");
  }
  unlinkSync(socketPath);
}

function listenOnSocket(server: ServerType, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    withUnixSocketAddress(socketPath, (address) =>
      server.listen(address, () => {
        server.off("error", onError);
        resolve();
      }),
    );
  });
}

export async function startAdminServer(
  options: Omit<StartAdminServerOptions, "capability">,
): Promise<AdminServerHandle> {
  const paths = resolveAdminSocketPaths(options.dataDir);
  if (!existsSync(paths.directoryPath)) {
    mkdirSync(paths.directoryPath, { mode: 0o700, recursive: true });
  }
  const directoryIdentity = lstatSync(paths.directoryPath);
  if (!directoryIdentity.isDirectory() || directoryIdentity.isSymbolicLink()) {
    throw new Error(
      "admin directory must be a directory, not a link or special file",
    );
  }
  if (
    typeof process.getuid === "function" &&
    directoryIdentity.uid !== process.getuid()
  ) {
    throw new Error("admin directory must be owned by the service user");
  }
  if ((directoryIdentity.mode & 0o777) !== 0o700) {
    throw new Error("admin directory must have mode 0700");
  }
  const capability = loadOrCreateCapability(paths.capabilityPath);
  await removeStaleSocket(paths.socketPath);
  const app = createAdminMaintenanceApp({
    capability,
    connectedHostIds: options.connectedHostIds,
    releaseIdentity: options.releaseIdentity,
    service: options.service,
  });
  const server = createAdaptorServer({ fetch: app.fetch });
  await listenOnSocket(server, paths.socketPath);
  chmodSync(paths.socketPath, 0o600);
  const identity = lstatSync(paths.socketPath);
  return {
    capabilityPath: paths.capabilityPath,
    socketPath: paths.socketPath,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          if (existsSync(paths.socketPath)) {
            const current = lstatSync(paths.socketPath);
            if (sameFileIdentity(identity, current))
              unlinkSync(paths.socketPath);
          }
          resolve();
        });
      }),
  };
}
