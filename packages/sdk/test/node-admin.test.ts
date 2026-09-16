import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeAdminClient } from "../src/node-admin.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("node admin client", () => {
  it("authenticates and parses maintenance responses over a Unix socket", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-sdk-admin-"));
    const socketPath = join(directory, "maintenance.sock");
    const capabilityPath = join(directory, "capability");
    writeFileSync(capabilityPath, "local-secret\n", { mode: 0o600 });
    const server = createServer((request, response) => {
      expect(request.headers.authorization).toBe("Bearer local-secret");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url === "/identity"
            ? {
                service: "bb-maintenance",
                protocolVersion: 2,
                releaseIdentity: "/srv/releases/abc123",
                connectedHostIds: ["host-1"],
              }
            : {
                lease: null,
                barrier: [],
                activity: { activeByKind: {} },
              },
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanup.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
      () => rmSync(directory, { force: true, recursive: true }),
    );

    const client = createNodeAdminClient({
      socketPath,
      capabilityPath,
    });
    await expect(client.status()).resolves.toEqual({
      lease: null,
      barrier: [],
      activity: { activeByKind: {} },
    });
    await expect(client.identity()).resolves.toEqual({
      service: "bb-maintenance",
      protocolVersion: 2,
      releaseIdentity: "/srv/releases/abc123",
      connectedHostIds: ["host-1"],
    });
  });

  it("preserves the server's actionable maintenance error message", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-sdk-admin-error-"));
    const socketPath = join(directory, "maintenance.sock");
    const capabilityPath = join(directory, "capability");
    writeFileSync(capabilityPath, "local-secret\n", { mode: 0o600 });
    const server = createServer((_request, response) => {
      response.statusCode = 409;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          code: "lease_held",
          message: "work maintenance is held by update-2",
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanup.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
      () => rmSync(directory, { force: true, recursive: true }),
    );

    await expect(
      createNodeAdminClient({ socketPath, capabilityPath }).status(),
    ).rejects.toMatchObject({
      message:
        "BB maintenance request failed with HTTP 409: work maintenance is held by update-2",
      status: 409,
    });
  });
});
