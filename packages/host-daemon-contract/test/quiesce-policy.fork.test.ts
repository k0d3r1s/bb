import { describe, expect, it } from "vitest";
import { hostDaemonCommandRegistry } from "../src/commands.js";
import {
  hostDaemonCommandQuiescePolicyByType,
  hostDaemonQuiescePolicyForCommand,
} from "../src/quiesce-policy.fork.js";

describe("host-daemon work-quiesce classification", () => {
  it("classifies every registered command", () => {
    for (const type of Object.keys(hostDaemonCommandRegistry)) {
      const policy =
        hostDaemonCommandQuiescePolicyByType[
          type as keyof typeof hostDaemonCommandQuiescePolicyByType
        ];
      expect(policy === "allowed" || policy === "execution-start").toBe(true);
    }
    expect(Object.keys(hostDaemonCommandQuiescePolicyByType).sort()).toEqual(
      Object.keys(hostDaemonCommandRegistry).sort(),
    );
  });

  it("uses the expected policy for representative commands", () => {
    expect(hostDaemonCommandQuiescePolicyByType["thread.start"]).toBe(
      "execution-start",
    );
    expect(hostDaemonCommandQuiescePolicyByType["turn.submit"]).toBe(
      "execution-start",
    );
    expect(hostDaemonCommandQuiescePolicyByType["plugin.host.call"]).toBe(
      "execution-start",
    );
    expect(
      hostDaemonCommandQuiescePolicyByType["provider.installation.run"],
    ).toBe("execution-start");
    expect(
      hostDaemonCommandQuiescePolicyByType["desktop.browser.import_cookies"],
    ).toBe("execution-start");
    expect(
      hostDaemonCommandQuiescePolicyByType[
        "desktop.browser.list_import_sources"
      ],
    ).toBe("allowed");
    expect(hostDaemonCommandQuiescePolicyByType["thread.stop"]).toBe("allowed");
    expect(
      hostDaemonCommandQuiescePolicyByType["environment.hook.cancel"],
    ).toBe("allowed");
    expect(
      hostDaemonCommandQuiescePolicyByType["work.quiesce"],
    ).toBe("allowed");
  });

  it("resolves policy by command through the helper", () => {
    expect(
      hostDaemonQuiescePolicyForCommand({
        type: "thread.stop",
      } as Parameters<typeof hostDaemonQuiescePolicyForCommand>[0]),
    ).toBe("allowed");
    expect(
      hostDaemonQuiescePolicyForCommand({
        type: "turn.submit",
      } as Parameters<typeof hostDaemonQuiescePolicyForCommand>[0]),
    ).toBe("execution-start");
  });
});
