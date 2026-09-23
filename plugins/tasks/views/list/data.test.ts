import { describe, expect, it } from "vitest";
import {
  modeStatusOptions,
  requestedStatuses,
  statusFilterForMode,
} from "./data.js";

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

  it("falls back to the mode's statuses when the selection cannot appear in it", () => {
    expect(requestedStatuses("focus", ["done"])).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "in_review",
    ]);
    expect(requestedStatuses("recent", ["todo"])).toEqual(["done", "canceled"]);
    expect(requestedStatuses("archive", ["todo"])).toBeUndefined();
    expect(requestedStatuses("focus", ["done", "todo"])).toEqual(["todo"]);
  });
});

describe("statusFilterForMode", () => {
  it("drops statuses the mode never lists", () => {
    expect(statusFilterForMode("focus", ["done", "todo"])).toEqual(["todo"]);
    expect(statusFilterForMode("recent", ["todo"])).toEqual([]);
    expect(statusFilterForMode("archive", ["canceled"])).toEqual(["canceled"]);
    expect(statusFilterForMode("active", ["done", "todo"])).toEqual([
      "done",
      "todo",
    ]);
  });

  it("offers only the statuses each mode can list", () => {
    expect(modeStatusOptions("focus")).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "in_review",
    ]);
    expect(modeStatusOptions("recent")).toEqual(["done", "canceled"]);
    expect(modeStatusOptions("archive")).toEqual(["done", "canceled"]);
  });
});
