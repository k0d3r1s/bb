import { describe, expect, it } from "vitest";
import { resolveAdminSocketPaths } from "../src/admin-socket.js";

describe("admin socket paths", () => {
  it("keeps the socket and capability under the selected data directory", () => {
    expect(resolveAdminSocketPaths("/srv/bb-data")).toEqual({
      directoryPath: "/srv/bb-data/admin",
      socketPath: "/srv/bb-data/admin/maintenance.sock",
      capabilityPath: "/srv/bb-data/admin/capability",
    });
  });
});
