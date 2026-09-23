import { listAllTasks, useTasksQuery } from "../../shell/data.js";
import type {
  Label,
  Task,
  TaskPriority,
  TaskStatus,
  TaskThread,
} from "../../shared/contract.js";
import { isActiveThread } from "../detail/meta.js";

interface ListTaskFilters {
  statuses: readonly TaskStatus[];
  priorities: readonly TaskPriority[];
  labelIds: readonly string[] | null;
}

const FOCUS_STATUSES: readonly TaskStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
];
const RECENT_STATUSES: readonly TaskStatus[] = ["done", "canceled"];

export type ListTaskMode = "focus" | "recent" | "archive" | "active";

export function requestedStatuses(
  mode: ListTaskMode,
  selected: readonly TaskStatus[],
): readonly TaskStatus[] | undefined {
  const allowed =
    mode === "focus"
      ? FOCUS_STATUSES
      : mode === "recent"
        ? RECENT_STATUSES
        : null;
  if (allowed === null) return selected.length > 0 ? selected : undefined;
  if (selected.length === 0) return allowed;
  return allowed.filter((status) => selected.includes(status));
}

export function useListTasks(
  projectId: string | null,
  mode: ListTaskMode,
  filters: ListTaskFilters,
) {
  const statuses = requestedStatuses(mode, filters.statuses);
  return useTasksQuery(
    async (rpc) =>
      listAllTasks(rpc, {
        ...(projectId === null ? {} : { projectId }),
        ...(statuses === undefined ? {} : { statuses: [...statuses] }),
        ...(filters.priorities.length > 0
          ? { priorities: [...filters.priorities] }
          : {}),
        ...(filters.labelIds !== null
          ? { labelIds: [...filters.labelIds] }
          : {}),
        activeOnly: mode === "active",
        archive: mode === "archive" ? "archived" : "active",
        parentTaskId: null,
      }),
    ["tasks:changed", "threads:changed"],
    [
      projectId,
      mode,
      filters.statuses.join(),
      filters.priorities.join(),
      filters.labelIds === null ? "" : `active:${filters.labelIds.join()}`,
    ],
  );
}

export function useLabels(projectIds: readonly string[]) {
  return useTasksQuery<Label[]>(
    async (rpc) => {
      const results = await Promise.all(
        projectIds.map((projectId) => rpc.call("listLabels", { projectId })),
      );
      return results.flatMap((result) => result.labels);
    },
    ["projects:changed"],
    [projectIds.join()],
  );
}

export interface TaskRowMeta {
  activeThreads: TaskThread[];
}

export function useTaskListMeta(tasks: readonly Task[] | undefined) {
  const taskIds = (tasks ?? []).map((task) => task.id);
  return useTasksQuery<Map<string, TaskRowMeta>>(
    async (rpc) => {
      const entries = await Promise.all(
        taskIds.map(async (taskId) => {
          const threads = await rpc.call("listTaskThreads", { taskId });
          const meta: TaskRowMeta = {
            activeThreads: threads.taskThreads.filter(isActiveThread),
          };
          return [taskId, meta] as const;
        }),
      );
      return new Map(entries);
    },
    ["threads:changed", "tasks:changed"],
    [taskIds.join()],
  );
}
