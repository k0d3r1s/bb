import { describe, expect, it, vi } from "vitest";
import {
  collectLogLines,
  getHelpOutput,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

describe("bb thread promotion", () => {
  setupCommandOutputTestEnvironment();
  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  it("inspects an operation and preserves the observation in JSON", async () => {
    const result = {
      operationId: "op-1",
      phase: "reconciling",
      snapshot: { observation: "token-1", commandTerminated: false },
    };
    const get = vi.fn(async () => result);
    stubServerApi({ "v1.threads.:id.branch-promotion.$get": get });
    await runCommand(
      ["thread", "promotion", "inspect", "thread-1", "--json"],
      register,
    );
    expect(get).toHaveBeenCalledWith({ param: { id: "thread-1" } });
    expect(
      JSON.parse(collectLogLines(vi.mocked(console.log)).join("\n")),
    ).toEqual(result);
  });

  it("prints uncertain host state and recovery choices", async () => {
    stubServerApi({
      "v1.threads.:id.branch-promotion.$get": async () => ({
        operationId: "op-1",
        phase: "reconciling",
        intent: { path: "/checkout", target: { kind: "new", name: "bb/task" } },
        snapshot: {
          phase: "uncertain",
          branchName: "main",
          headSha: "abc",
          observation: "token-1",
          commandTerminated: false,
          message: "Host must prove process-group termination",
          resolution: null,
        },
      }),
    });
    await runCommand(["thread", "promotion", "inspect", "thread-1"], register);
    const output = collectLogLines(vi.mocked(console.log)).join("\n");
    expect(output).toContain("Command terminated: false");
    expect(output).toContain("Observation: token-1");
    expect(output).toContain("--accept-current");
    expect(output).toContain("--keep-current");
    expect(output).toContain("Recovery does not mutate Git");
  });

  it("reports no pending operation", async () => {
    stubServerApi({ "v1.threads.:id.branch-promotion.$get": async () => null });
    await runCommand(["thread", "promotion", "inspect", "thread-1"], register);
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "No branch promotion operation.",
    );
  });

  it.each(["accept-current", "keep-current"])(
    "forwards %s with the observed operation",
    async (resolution) => {
      const post = vi.fn(async () => null);
      stubServerApi({ "v1.threads.:id.branch-promotion.resolve.$post": post });
      await runCommand(
        [
          "thread",
          "promotion",
          "resolve",
          "thread-1",
          "--operation",
          "op-1",
          "--observation",
          "token-1",
          `--${resolution}`,
        ],
        register,
      );
      expect(post).toHaveBeenCalledWith({
        param: { id: "thread-1" },
        json: { operationId: "op-1", observation: "token-1", resolution },
      });
    },
  );

  it.each([{ flags: [] }, { flags: ["--accept-current", "--keep-current"] }])(
    "rejects missing or conflicting recovery choices $flags",
    async ({ flags }) => {
      const post = vi.fn();
      stubServerApi({ "v1.threads.:id.branch-promotion.resolve.$post": post });
      await expect(
        runCommand(
          [
            "thread",
            "promotion",
            "resolve",
            "thread-1",
            "--operation",
            "op-1",
            "--observation",
            "token-1",
            ...flags,
          ],
          register,
        ),
      ).rejects.toThrow("process.exit:1");
      expect(post).not.toHaveBeenCalled();
    },
  );

  it("explains both recovery choices in help", async () => {
    const help = await getHelpOutput(
      ["thread", "promotion", "resolve"],
      register,
    );
    expect(help).toContain("Accept the requested target at the observed HEAD");
    expect(help).toContain("Decline promotion and stay on the observed branch");
  });
});
