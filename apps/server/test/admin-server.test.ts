import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAdminMaintenanceApp,
  startAdminServer,
} from "../src/admin-server.js";

function service() {
  return {
    acquire: vi.fn(async () => ({
      replayed: false,
      lease: null,
      barrier: [],
      activity: { activeByKind: {} },
    })),
    renew: vi.fn(),
    seal: vi.fn(),
    status: vi.fn(async () => ({
      lease: null,
      barrier: [],
      activity: { activeByKind: {} },
    })),
    transition: vi.fn(),
    release: vi.fn(),
  };
}

describe("admin maintenance app", () => {
  it("rejects missing and wrong capabilities and accepts the local capability", async () => {
    const maintenanceService = service();
    const app = createAdminMaintenanceApp({
      capability: "local-secret",
      connectedHostIds: () => ["host-1"],
      releaseIdentity: "/srv/releases/candidate",
      service: maintenanceService,
    });

    const identity = await app.request("/identity", {
      headers: { authorization: "Bearer local-secret" },
    });
    expect(await identity.json()).toEqual({
      service: "bb-maintenance",
      protocolVersion: 2,
      releaseIdentity: "/srv/releases/candidate",
      connectedHostIds: ["host-1"],
    });

    expect((await app.request("/maintenance")).status).toBe(401);
    const wrong = await app.request("/maintenance", {
      headers: { authorization: "Bearer wrong" },
    });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toMatchObject({
      code: "invalid_admin_capability",
      retryable: false,
    });
    const accepted = await app.request("/maintenance", {
      headers: { authorization: "Bearer local-secret" },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("x-request-id")).toMatch(/^req_/u);
    expect(
      (
        await app.request("/maintenance/acquisitions", {
          method: "POST",
          headers: {
            authorization: "Bearer local-secret",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            operationId: "update-1",
            ownerSecret: "owner-secret",
            reason: "VPS update",
            ttlMs: 60_000,
          }),
        })
      ).status,
    ).toBe(201);
    expect(maintenanceService.acquire).toHaveBeenCalledOnce();
  });

  it("does not register maintenance routes on an unrelated TCP app", async () => {
    const { Hono } = await import("hono");
    const tcpApp = new Hono();
    tcpApp.get("/health", (context) => context.json({ ok: true }));
    expect((await tcpApp.request("/maintenance")).status).toBe(404);
    expect(
      (
        await tcpApp.request("/maintenance", {
          headers: {
            "x-forwarded-for": "127.0.0.1",
            "tailscale-user-login": "operator@example.com",
          },
        })
      ).status,
    ).toBe(404);
  });

  it("creates restrictive admin filesystem state", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "bb-admin-server-"));
    const handle = await startAdminServer({
      connectedHostIds: () => [],
      dataDir,
      releaseIdentity: "/srv/releases/candidate",
      service: service(),
    });
    expect((await stat(join(dataDir, "admin"))).mode & 0o777).toBe(0o700);
    expect((await stat(handle.capabilityPath)).mode & 0o777).toBe(0o600);
    expect((await stat(handle.socketPath)).mode & 0o777).toBe(0o600);
    await handle.close();
  });

  it("rejects symlinked admin directories and capability files", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-admin-unsafe-"));
    const dataWithLinkedAdmin = join(root, "linked-admin-data");
    const target = join(root, "target");
    await mkdir(dataWithLinkedAdmin);
    await mkdir(target);
    await symlink(target, join(dataWithLinkedAdmin, "admin"));
    await expect(
      startAdminServer({
        connectedHostIds: () => [],
        dataDir: dataWithLinkedAdmin,
        releaseIdentity: "/srv/releases/candidate",
        service: service(),
      }),
    ).rejects.toThrow(/admin directory.*directory/u);

    const dataWithLinkedCapability = join(root, "linked-capability-data");
    await mkdir(join(dataWithLinkedCapability, "admin"), {
      recursive: true,
      mode: 0o700,
    });
    const secretTarget = join(root, "secret-target");
    await writeFile(secretTarget, "do-not-overwrite\n", { mode: 0o600 });
    await symlink(
      secretTarget,
      join(dataWithLinkedCapability, "admin", "capability"),
    );
    await expect(
      startAdminServer({
        connectedHostIds: () => [],
        dataDir: dataWithLinkedCapability,
        releaseIdentity: "/srv/releases/candidate",
        service: service(),
      }),
    ).rejects.toThrow(/capability.*regular file/u);
  });
});
