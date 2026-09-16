import { describe, expect, it } from "vitest";
import { buildPromptInputs, parseThreadMentions } from "./helpers.js";

describe("parseThreadMentions", () => {
  it("resolves a thread mention with the range covering the mention text", () => {
    const text = "Continue from @thread:thr_42fa4vbj43";

    expect(parseThreadMentions(text)).toEqual([
      {
        start: "Continue from ".length,
        end: text.length,
        resource: {
          kind: "thread",
          threadId: "thr_42fa4vbj43",
          label: "thr_42fa4vbj43",
        },
      },
    ]);
    expect(text.slice(14, text.length)).toBe("@thread:thr_42fa4vbj43");
  });

  it("resolves several mentions in one message", () => {
    const mentions = parseThreadMentions(
      "compare @thread:thr_42fa4vbj43 with @thread:thr_9vjdcyhd58",
    );

    expect(mentions.map((mention) => mention.resource)).toEqual([
      {
        kind: "thread",
        threadId: "thr_42fa4vbj43",
        label: "thr_42fa4vbj43",
      },
      {
        kind: "thread",
        threadId: "thr_9vjdcyhd58",
        label: "thr_9vjdcyhd58",
      },
    ]);
  });

  it("ignores text that is not a valid thread id", () => {
    expect(parseThreadMentions("@thread:not-an-id")).toEqual([]);
    expect(parseThreadMentions("@thread:thr_TOOSHORT")).toEqual([]);
    expect(parseThreadMentions("@thread:thr_42fa4vbj43extra")).toEqual([]);
    expect(parseThreadMentions("prefix@thread:thr_42fa4vbj43")).toEqual([]);
    expect(parseThreadMentions("no mention here")).toEqual([]);
  });

  it("attaches parsed mentions to the built prompt input", () => {
    const [input] = buildPromptInputs({
      message: "Continue from @thread:thr_42fa4vbj43",
    });

    expect(input).toEqual({
      type: "text",
      text: "Continue from @thread:thr_42fa4vbj43",
      mentions: [
        {
          start: 14,
          end: 36,
          resource: {
            kind: "thread",
            threadId: "thr_42fa4vbj43",
            label: "thr_42fa4vbj43",
          },
        },
      ],
    });
  });

  it("preserves parsed thread mentions in plan input", () => {
    const [input] = buildPromptInputs({
      message: "Continue from @thread:thr_42fa4vbj43",
      plan: true,
    });

    expect(input).toMatchObject({
      type: "text",
      text: "/plan Continue from @thread:thr_42fa4vbj43",
      mentions: [
        { resource: { kind: "command", name: "plan" } },
        {
          start: "/plan Continue from ".length,
          end: "/plan Continue from @thread:thr_42fa4vbj43".length,
          resource: {
            kind: "thread",
            threadId: "thr_42fa4vbj43",
          },
        },
      ],
    });
  });
});
