import { describe, expect, it } from "vitest";
import {
  getHelpOutput,
  setupCommandOutputTestEnvironment,
  type CommandRegistrar,
} from "../helpers/command-output-harness.js";
import { registerMaintenanceCommands } from "../../commands/maintenance.js";

setupCommandOutputTestEnvironment();

const register: CommandRegistrar = (program) =>
  registerMaintenanceCommands(program);

describe("maintenance command output", () => {
  it("documents the headless maintenance command family", async () => {
    const output = await getHelpOutput(["maintenance"], register);
    expect(output).toContain("identity");
    expect(output).toContain("status");
    expect(output).toContain("acquire");
    expect(output).toContain("renew");
    expect(output).toContain("seal");
    expect(output).toContain("transition");
    expect(output).toContain("release");
    expect(output).toContain("recover");
    expect(output).toContain("--data-dir");
  });

  it("generates acquisition ownership locally", async () => {
    const output = await getHelpOutput(["maintenance", "acquire"], register);
    expect(output).toContain("--reason");
    expect(output).toContain("--ttl-ms");
    expect(output).toContain("--operation-id");
    expect(output).not.toContain("<operation-id>");
  });

  it("does not advertise an ignored operation argument for live status", async () => {
    const output = await getHelpOutput(["maintenance"], register);
    expect(output).toContain("status");
    expect(output).not.toContain("status [operation-id]");
  });

  it("limits force-abort recovery to supported phases", async () => {
    const output = await getHelpOutput(["maintenance", "recover"], register);
    expect(output).toContain("draining, sealing, or rollback-failed");
  });
});
