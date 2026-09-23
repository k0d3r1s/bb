import { describe, expect, it } from "vitest";
import { buildUnclaimedAnswerMessage } from "../../src/services/interactions/unclaimed-answer-message.js";

const payload = {
  questions: [
    {
      id: "q0",
      prompt: "Which layout?",
      shortLabel: "Layout",
      multiSelect: false,
      options: [
        { value: "q0o0", label: "Inner area" },
        { value: "q0o1", label: "Full page" },
      ],
      allowFreeText: true,
    },
  ],
};

describe("buildUnclaimedAnswerMessage", () => {
  it("names the question and selected option", () => {
    const message = buildUnclaimedAnswerMessage(payload, {
      answers: { q0: { selected: ["q0o0"] } },
    });
    expect(message).toContain("Which layout? — Inner area");
    expect(message).toContain("Continue from these.");
  });

  it("preserves free-text and unknown option answers", () => {
    const message = buildUnclaimedAnswerMessage(payload, {
      answers: {
        q0: { selected: ["unknown"], freeText: "Something custom" },
      },
    });
    expect(message).toContain("unknown, Something custom");
  });

  it("returns null for invalid or empty answers", () => {
    expect(
      buildUnclaimedAnswerMessage(payload, {
        answers: { q0: { selected: [] } },
      }),
    ).toBeNull();
    expect(buildUnclaimedAnswerMessage({}, { answers: {} })).toBeNull();
  });
});
