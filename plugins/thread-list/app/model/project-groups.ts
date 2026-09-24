import type { ProjectGroup } from "../../shared/preferences.js";
import type { ProjectSortInput } from "../list/projectSort.js";
import type { SidebarSectionId } from "./sidebar-section-id.js";
import { buildSidebarEntitySectionId } from "./sidebar-section-order.js";

export type ProjectGroupLayoutEntry =
  | { kind: "section"; sectionId: SidebarSectionId }
  | { kind: "group"; group: ProjectGroup; sectionIds: SidebarSectionId[] };

export function findProjectGroup(
  groups: readonly ProjectGroup[],
  projectId: string,
): ProjectGroup | null {
  return groups.find((group) => group.projectIds.includes(projectId)) ?? null;
}

export function layoutProjectGroups(
  order: readonly SidebarSectionId[],
  groups: readonly ProjectGroup[],
): ProjectGroupLayoutEntry[] {
  const groupBySectionId = new Map<SidebarSectionId, ProjectGroup>();
  for (const group of groups) {
    for (const projectId of group.projectIds) {
      groupBySectionId.set(
        buildSidebarEntitySectionId("project", projectId),
        group,
      );
    }
  }
  const membersByGroupId = new Map<string, SidebarSectionId[]>();
  const entries: ProjectGroupLayoutEntry[] = [];
  for (const sectionId of order) {
    const group = groupBySectionId.get(sectionId);
    if (!group) {
      entries.push({ kind: "section", sectionId });
      continue;
    }
    const members = membersByGroupId.get(group.id);
    if (members) {
      members.push(sectionId);
      continue;
    }
    const sectionIds = [sectionId];
    membersByGroupId.set(group.id, sectionIds);
    entries.push({ kind: "group", group, sectionIds });
  }
  return entries;
}

function getGroupSortInput(
  entry: Extract<ProjectGroupLayoutEntry, { kind: "group" }>,
  projectBySectionId: ReadonlyMap<SidebarSectionId, ProjectSortInput>,
): ProjectSortInput {
  let lastActivityAt: number | null = null;
  for (const sectionId of entry.sectionIds) {
    const activity = projectBySectionId.get(sectionId)?.lastActivityAt ?? null;
    if (activity !== null) {
      lastActivityAt =
        lastActivityAt === null ? activity : Math.max(lastActivityAt, activity);
    }
  }
  return {
    id: `group:${entry.group.id}`,
    name: entry.group.name,
    lastActivityAt,
  };
}

export function sortProjectGroupLayout(
  entries: readonly ProjectGroupLayoutEntry[],
  projectBySectionId: ReadonlyMap<SidebarSectionId, ProjectSortInput>,
  comparator: (left: ProjectSortInput, right: ProjectSortInput) => number,
): ProjectGroupLayoutEntry[] {
  const sortInputs = new Map<ProjectGroupLayoutEntry, ProjectSortInput>();
  for (const entry of entries) {
    if (entry.kind === "group") {
      sortInputs.set(entry, getGroupSortInput(entry, projectBySectionId));
      continue;
    }
    const project = projectBySectionId.get(entry.sectionId);
    if (project) sortInputs.set(entry, project);
  }
  const sorted = entries
    .filter((entry) => sortInputs.has(entry))
    .sort((left, right) => {
      const leftInput = sortInputs.get(left);
      const rightInput = sortInputs.get(right);
      if (!leftInput || !rightInput) return 0;
      return comparator(leftInput, rightInput);
    });
  let sortedIndex = 0;
  return entries.map((entry) =>
    sortInputs.has(entry) ? (sorted[sortedIndex++] ?? entry) : entry,
  );
}

export function flattenProjectGroupLayout(
  entries: readonly ProjectGroupLayoutEntry[],
  collapsedGroupIds: ReadonlySet<string>,
): SidebarSectionId[] {
  return entries.flatMap((entry) => {
    if (entry.kind === "section") return [entry.sectionId];
    return collapsedGroupIds.has(entry.group.id) ? [] : entry.sectionIds;
  });
}

function findMovedSectionId(
  previous: readonly SidebarSectionId[],
  next: readonly SidebarSectionId[],
): SidebarSectionId | null {
  if (previous.length !== next.length) return null;
  let start = 0;
  while (start < previous.length && previous[start] === next[start]) start++;
  if (start === previous.length) return null;
  let end = previous.length - 1;
  while (end > start && previous[end] === next[end]) end--;
  if (next[end] === previous[start]) return previous[start] ?? null;
  if (next[start] === previous[end]) return previous[end] ?? null;
  return null;
}

export function resolveProjectGroupReorder(
  previous: readonly SidebarSectionId[],
  next: readonly SidebarSectionId[],
  groups: readonly ProjectGroup[],
): SidebarSectionId[] {
  const movedId = findMovedSectionId(previous, next);
  if (movedId === null || !movedId.startsWith("project:")) return [...next];
  const group = findProjectGroup(groups, movedId.slice("project:".length));
  if (!group) return [...next];
  const memberIds = new Set(
    group.projectIds.map((projectId) =>
      buildSidebarEntitySectionId("project", projectId),
    ),
  );
  const movedIndex = next.indexOf(movedId);
  const otherMemberIndexes = next
    .filter((sectionId) => sectionId !== movedId)
    .flatMap((sectionId, index) => (memberIds.has(sectionId) ? [index] : []));
  const firstMemberIndex = otherMemberIndexes[0];
  const lastMemberIndex = otherMemberIndexes.at(-1);
  if (
    firstMemberIndex === undefined ||
    lastMemberIndex === undefined ||
    (movedIndex >= firstMemberIndex && movedIndex <= lastMemberIndex + 1)
  ) {
    return [...next];
  }
  const block = previous.filter((sectionId) => memberIds.has(sectionId));
  const insertAt = next
    .slice(0, movedIndex)
    .filter((sectionId) => !memberIds.has(sectionId)).length;
  const reordered = next.filter((sectionId) => !memberIds.has(sectionId));
  reordered.splice(insertAt, 0, ...block);
  return reordered;
}

function withoutProjects(
  groups: readonly ProjectGroup[],
  projectIds: ReadonlySet<string>,
): ProjectGroup[] {
  return groups.flatMap((group) => {
    if (!group.projectIds.some((projectId) => projectIds.has(projectId))) {
      return [group];
    }
    const remaining = group.projectIds.filter(
      (projectId) => !projectIds.has(projectId),
    );
    return remaining.length === 0 ? [] : [{ ...group, projectIds: remaining }];
  });
}

export function assignProjectToGroup(
  groups: readonly ProjectGroup[],
  projectId: string,
  groupId: string | null,
): ProjectGroup[] {
  if (findProjectGroup(groups, projectId)?.id === groupId) return [...groups];
  return withoutProjects(groups, new Set([projectId])).map((group) =>
    group.id === groupId
      ? { ...group, projectIds: [...group.projectIds, projectId] }
      : group,
  );
}

export function createProjectGroup(
  groups: readonly ProjectGroup[],
  group: ProjectGroup,
): ProjectGroup[] {
  return [...withoutProjects(groups, new Set(group.projectIds)), group];
}

export function renameProjectGroup(
  groups: readonly ProjectGroup[],
  groupId: string,
  name: string,
): ProjectGroup[] {
  return groups.map((group) =>
    group.id === groupId ? { ...group, name } : group,
  );
}

export function deleteProjectGroup(
  groups: readonly ProjectGroup[],
  groupId: string,
): ProjectGroup[] {
  return groups.filter((group) => group.id !== groupId);
}

export function createProjectGroupId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
