import type { ProjectSort, SortDirection } from "../../shared/preferences.js";

export type ActiveProjectSort = Exclude<ProjectSort, "custom">;

export interface ProjectSortInput {
  id: string;
  lastActivityAt: number | null;
  name: string;
}

export interface ProjectActivityThread {
  archivedAt: number | null;
  isHidden: boolean;
  pinnedAt: number | null;
  updatedAt: number;
}

export interface ProjectSortOption {
  direction: Exclude<SortDirection, "default">;
  label: string;
  sort: ActiveProjectSort;
}

export const PROJECT_SORT_OPTIONS: readonly ProjectSortOption[] = [
  { label: "Alphabetical", sort: "alpha", direction: "ascending" },
  {
    label: "Recent activity",
    sort: "activity",
    direction: "descending",
  },
];

export function isCustomProjectSort(sort: ProjectSort): sort is "custom" {
  return sort === "custom";
}

export function getProjectLastActivity(
  threads: readonly ProjectActivityThread[],
): number | null {
  let latest: number | null = null;
  for (const thread of threads) {
    if (thread.isHidden || thread.archivedAt !== null) continue;
    latest =
      latest === null ? thread.updatedAt : Math.max(latest, thread.updatedAt);
  }
  return latest;
}

function naturalDirection(
  sort: ActiveProjectSort,
): Exclude<SortDirection, "default"> {
  return sort === "alpha" ? "ascending" : "descending";
}

function comparePrimary(
  sort: ActiveProjectSort,
  left: ProjectSortInput,
  right: ProjectSortInput,
): number {
  if (sort === "alpha") return left.name.localeCompare(right.name);
  if (left.lastActivityAt === right.lastActivityAt) return 0;
  if (left.lastActivityAt === null) return -1;
  if (right.lastActivityAt === null) return 1;
  return left.lastActivityAt - right.lastActivityAt;
}

export function getProjectComparator(
  sort: ActiveProjectSort,
  direction: SortDirection,
): (left: ProjectSortInput, right: ProjectSortInput) => number {
  const resolved = direction === "default" ? naturalDirection(sort) : direction;
  const multiplier = resolved === "ascending" ? 1 : -1;
  return (left, right) => {
    const primary = comparePrimary(sort, left, right);
    return primary === 0
      ? left.id.localeCompare(right.id)
      : multiplier * primary;
  };
}

export function sortProjectSectionIds<
  Id extends string,
  T extends ProjectSortInput,
>(
  order: readonly Id[],
  projectBySectionId: ReadonlyMap<Id, T>,
  comparator: (left: T, right: T) => number,
): Id[] {
  const projectIds = order.filter(
    (sectionId) =>
      sectionId.startsWith("project:") && projectBySectionId.has(sectionId),
  );
  projectIds.sort((left, right) => {
    const leftProject = projectBySectionId.get(left);
    const rightProject = projectBySectionId.get(right);
    if (!leftProject || !rightProject) return 0;
    return comparator(leftProject, rightProject);
  });
  let projectIndex = 0;
  return order.map((sectionId) =>
    sectionId.startsWith("project:") && projectBySectionId.has(sectionId)
      ? (projectIds[projectIndex++] ?? sectionId)
      : sectionId,
  );
}
