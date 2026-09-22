import { describe, expect, it } from "vitest";
import {
  coreHostDaemonCommandRegistry,
  hostDaemonCommandRegistry,
} from "../src/commands.js";
import { forkHostDaemonCommandRegistry } from "../src/commands.fork.js";

describe("fork command registry seam", () => {
  it("keeps fork command keys disjoint from core command keys", () => {
    const coreKeys = new Set(Object.keys(coreHostDaemonCommandRegistry));
    const collisions = Object.keys(forkHostDaemonCommandRegistry).filter(
      (key) => coreKeys.has(key),
    );
    expect(collisions).toEqual([]);
  });

  it("merges core and fork registries without dropping entries", () => {
    expect(Object.keys(hostDaemonCommandRegistry).length).toBe(
      Object.keys(coreHostDaemonCommandRegistry).length +
        Object.keys(forkHostDaemonCommandRegistry).length,
    );
  });
});
