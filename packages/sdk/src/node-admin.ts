import {
  resolveAdminSocketPaths,
  withUnixSocketAddress,
} from "@bb/config/admin-socket";
import {
  maintenanceAcquireResponseSchema,
  maintenanceIdentityResponseSchema,
  maintenanceStatusResponseSchema,
  type MaintenanceAcquireRequest,
  type MaintenanceAcquireResponse,
  type MaintenanceIdentityResponse,
  type MaintenanceOwnedRequest,
  type MaintenanceReleaseRequest,
  type MaintenanceSealRequest,
  type MaintenanceStatusResponse,
  type MaintenanceTransitionRequest,
} from "@bb/server-contract";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { connect, type Socket } from "node:net";

export interface CreateNodeAdminClientOptions {
  dataDir?: string;
  socketPath?: string;
  capabilityPath?: string;
  timeoutMs?: number;
}

export interface NodeAdminClient {
  identity(): Promise<MaintenanceIdentityResponse>;
  status(): Promise<MaintenanceStatusResponse>;
  acquire(
    input: MaintenanceAcquireRequest,
  ): Promise<MaintenanceAcquireResponse>;
  renew(
    input: MaintenanceOwnedRequest & { ttlMs: number },
  ): Promise<MaintenanceStatusResponse>;
  seal(input: MaintenanceSealRequest): Promise<MaintenanceStatusResponse>;
  transition(
    input: MaintenanceTransitionRequest,
  ): Promise<MaintenanceStatusResponse>;
  release(input: MaintenanceReleaseRequest): Promise<MaintenanceStatusResponse>;
  recover(input: MaintenanceOwnedRequest): Promise<MaintenanceStatusResponse>;
}

export class NodeAdminHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    const detail =
      typeof body === "object" &&
      body !== null &&
      "message" in body &&
      typeof body.message === "string"
        ? `: ${body.message}`
        : "";
    super(`BB maintenance request failed with HTTP ${status}${detail}`);
    this.name = "NodeAdminHttpError";
  }
}

function resolveClientPaths(options: CreateNodeAdminClientOptions) {
  if (options.socketPath && options.capabilityPath) {
    return {
      socketPath: options.socketPath,
      capabilityPath: options.capabilityPath,
    };
  }
  if (!options.dataDir) {
    throw new Error(
      "createNodeAdminClient requires dataDir or both socketPath and capabilityPath",
    );
  }
  return resolveAdminSocketPaths(options.dataDir);
}

export function createNodeAdminClient(
  options: CreateNodeAdminClientOptions,
): NodeAdminClient {
  const paths = resolveClientPaths(options);
  const timeoutMs = options.timeoutMs ?? 30_000;

  function call<T>(
    path: string,
    schema: { parse(value: unknown): T },
    body?: unknown,
  ): Promise<T> {
    const capability = readFileSync(paths.capabilityPath, "utf8").trim();
    const encodedBody = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      const outgoing = request(
        {
          socketPath: paths.socketPath,
          createConnection: (): Socket =>
            withUnixSocketAddress(paths.socketPath, (address) =>
              connect(address),
            ),
          path,
          method: encodedBody === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${capability}`,
            ...(encodedBody === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(encodedBody),
                }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            try {
              const value: unknown = JSON.parse(
                Buffer.concat(chunks).toString("utf8"),
              );
              const status = response.statusCode ?? 500;
              if (status < 200 || status >= 300) {
                reject(new NodeAdminHttpError(status, value));
                return;
              }
              resolve(schema.parse(value));
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      outgoing.setTimeout(timeoutMs, () =>
        outgoing.destroy(new Error("BB maintenance request timed out")),
      );
      outgoing.once("error", reject);
      if (encodedBody !== undefined) outgoing.write(encodedBody);
      outgoing.end();
    });
  }

  return {
    identity: () => call("/identity", maintenanceIdentityResponseSchema),
    status: () => call("/maintenance", maintenanceStatusResponseSchema),
    acquire: (input) =>
      call(
        "/maintenance/acquisitions",
        maintenanceAcquireResponseSchema,
        input,
      ),
    renew: (input) =>
      call("/maintenance/renew", maintenanceStatusResponseSchema, input),
    seal: (input) =>
      call("/maintenance/seal", maintenanceStatusResponseSchema, input),
    transition: (input) =>
      call("/maintenance/transition", maintenanceStatusResponseSchema, input),
    release: (input) =>
      call("/maintenance/release", maintenanceStatusResponseSchema, input),
    recover: (input) =>
      call("/maintenance/recover", maintenanceStatusResponseSchema, input),
  };
}
