import { describe, expect, it } from "vitest";
import { WorkQuiesceGate } from "../../src/work-quiesce-gate.js";

describe("work quiesce gate", () => {
  it("expires only an unsealed draining gate", () => {
    const gate = new WorkQuiesceGate();
    expect(gate.allowsExecutionStart(999)).toBe(true);
    expect(
      gate.quiesce({ operationId: "update-1", expiresAt: 1_100 }, 1_000),
    ).toEqual({
      operationId: "update-1",
      phase: "draining",
      expiresAt: 1_100,
    });
    expect(gate.allowsExecutionStart(1_050)).toBe(false);
    expect(gate.allowsExecutionStart(1_101)).toBe(true);

    gate.quiesce({ operationId: "update-1", expiresAt: 1_200 }, 1_101);
    gate.seal("update-1", 1_150);
    expect(gate.allowsExecutionStart(Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it("is idempotent for one operation and rejects mismatched owners", () => {
    const gate = new WorkQuiesceGate();
    gate.quiesce({ operationId: "update-1", expiresAt: 2_000 }, 1_000);
    expect(
      gate.quiesce({ operationId: "update-1", expiresAt: 2_500 }, 1_100),
    ).toMatchObject({ operationId: "update-1", expiresAt: 2_500 });
    expect(() =>
      gate.quiesce({ operationId: "update-2", expiresAt: 3_000 }, 1_100),
    ).toThrowError(expect.objectContaining({ code: "work_quiesce_conflict" }));
    expect(() => gate.seal("update-2", 1_200)).toThrowError(
      expect.objectContaining({ code: "work_quiesce_owner_mismatch" }),
    );
    expect(() => gate.unquiesce("update-2", 1_200)).toThrowError(
      expect.objectContaining({ code: "work_quiesce_owner_mismatch" }),
    );
    expect(gate.unquiesce("update-1", 1_200)).toBe(true);
    expect(gate.allowsExecutionStart(1_200)).toBe(true);
  });
});
