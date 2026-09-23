// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadProjectFocus,
  PROJECT_FOCUS_STORAGE_KEY,
  storeProjectFocus,
} from "./project-focus-preference.js";

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";

beforeEach(() => window.localStorage.clear());

describe("project focus preference", () => {
  it("persists and clears a valid project focus", () => {
    storeProjectFocus(PROJECT_ID);
    expect(loadProjectFocus()).toBe(PROJECT_ID);
    storeProjectFocus(null);
    expect(loadProjectFocus()).toBeNull();
  });

  it("ignores invalid and unavailable storage", () => {
    window.localStorage.setItem(PROJECT_FOCUS_STORAGE_KEY, "not-a-project");
    expect(loadProjectFocus()).toBeNull();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage is disabled", "SecurityError");
    });
    expect(loadProjectFocus()).toBeNull();
  });
});
