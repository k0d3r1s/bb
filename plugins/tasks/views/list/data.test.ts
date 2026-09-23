import { describe, expect, it } from "vitest";
import { requestedStatuses } from "./data.js";

describe("requestedStatuses", () => {
  it("sends the mode's statuses when nothing is selected", () => {
    expect(requestedStatuses("focus", [])).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "in_review",
    ]);
    expect(requestedStatuses("recent", [])).toEqual(["done", "canceled"]);
    expect(requestedStatuses("archive", [])).toBeUndefined();
    expect(requestedStatuses("active", [])).toBeUndefined();
  });

  it("narrows the mode's statuses by the selected ones", () => {
    expect(requestedStatuses("focus", ["todo", "in_review"])).toEqual([
      "todo",
      "in_review",
    ]);
    expect(requestedStatuses("recent", ["canceled"])).toEqual(["canceled"]);
    expect(requestedStatuses("archive", ["done"])).toEqual(["done"]);
  });

  it("asks for nothing when the selection cannot appear in the mode", () => {
    expect(requestedStatuses("focus", ["done"])).toEqual([]);
    expect(requestedStatuses("recent", ["todo"])).toEqual([]);
  });
});
