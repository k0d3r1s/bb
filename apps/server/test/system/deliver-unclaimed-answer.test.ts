import { describe, expect, it } from "vitest";
import type { PendingInteraction } from "@bb/domain";
import { planUnclaimedAnswerDelivery } from "../../src/services/interactions/deliver-unclaimed-answer.js";

const interaction = {
  threadId: "thr_late",
  payload: {
    kind: "plugin",
    title: "Layout",
    data: {
      questions: [
        {
          id: "q0",
          prompt: "Which layout?",
          shortLabel: "Layout",
          multiSelect: false,
          options: [{ value: "q0o0", label: "Inner area" }],
          allowFreeText: true,
        },
      ],
    },
  },
} satisfies Pick<PendingInteraction, "threadId" | "payload">;

describe("planUnclaimedAnswerDelivery", () => {
  it("targets the thread that asked", () => {
    const delivery = planUnclaimedAnswerDelivery({
      interaction,
      value: { answers: { q0: { selected: ["q0o0"] } } },
    });
    expect(delivery).toEqual({
      threadId: "thr_late",
      text: expect.stringContaining("Which layout? — Inner area"),
    });
  });

  it("plans nothing for an empty answer", () => {
    expect(
      planUnclaimedAnswerDelivery({
        interaction,
        value: { answers: { q0: { selected: [] } } },
      }),
    ).toBeNull();
  });
});
