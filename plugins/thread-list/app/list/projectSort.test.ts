import { describe, expect, it } from "vitest";
import {
  getProjectComparator,
  getProjectLastActivity,
  isCustomProjectSort,
  sortProjectSectionIds,
  type ProjectSortInput,
} from "./projectSort.js";

function project(
  id: string,
  overrides: Partial<Omit<ProjectSortInput, "id">> = {},
): ProjectSortInput {
  return {
    id,
    name: overrides.name ?? id,
    lastActivityAt: overrides.lastActivityAt ?? null,
  };
}

function sortedIds(
  projects: ProjectSortInput[],
  comparator: (left: ProjectSortInput, right: ProjectSortInput) => number,
): string[] {
  return [...projects].sort(comparator).map((entry) => entry.id);
}

describe("project sorting", () => {
  it("keeps manual sorting distinct from automatic modes", () => {
    expect(isCustomProjectSort("custom")).toBe(true);
    expect(isCustomProjectSort("alpha")).toBe(false);
    expect(isCustomProjectSort("activity")).toBe(false);
  });

  it("sorts alphabetically with an independent direction", () => {
    const projects = [
      project("1", { name: "Charlie" }),
      project("2", { name: "alpha" }),
      project("3", { name: "Bravo" }),
    ];
    expect(
      sortedIds(projects, getProjectComparator("alpha", "default")),
    ).toEqual(["2", "3", "1"]);
    expect(
      sortedIds(projects, getProjectComparator("alpha", "descending")),
    ).toEqual(["1", "3", "2"]);
  });

  it("sorts recent activity newest first and quiet projects last", () => {
    const projects = [
      project("old", { lastActivityAt: 10 }),
      project("quiet"),
      project("new", { lastActivityAt: 30 }),
    ];
    expect(
      sortedIds(projects, getProjectComparator("activity", "default")),
    ).toEqual(["new", "old", "quiet"]);
  });

  it("derives activity from visible non-archived threads including pinned ones", () => {
    expect(
      getProjectLastActivity([
        {
          archivedAt: null,
          pinnedAt: 30,
          updatedAt: 40,
          isHidden: false,
        },
        {
          archivedAt: 50,
          pinnedAt: null,
          updatedAt: 50,
          isHidden: false,
        },
        {
          archivedAt: null,
          pinnedAt: null,
          updatedAt: 60,
          isHidden: true,
        },
      ]),
    ).toBe(40);
  });

  it("breaks equal values by project id", () => {
    expect(
      sortedIds(
        [project("b", { name: "same" }), project("a", { name: "same" })],
        getProjectComparator("alpha", "default"),
      ),
    ).toEqual(["a", "b"]);
  });

  it("reorders only project slots and preserves built-in positions", () => {
    const rows = new Map([
      ["project:c", project("c", { name: "Charlie" })],
      ["project:a", project("a", { name: "Alpha" })],
      ["project:b", project("b", { name: "Bravo" })],
    ]);
    expect(
      sortProjectSectionIds(
        ["pinned", "project:c", "project:a", "threads", "project:b"],
        rows,
        getProjectComparator("alpha", "default"),
      ),
    ).toEqual(["pinned", "project:a", "project:b", "threads", "project:c"]);
  });
});
