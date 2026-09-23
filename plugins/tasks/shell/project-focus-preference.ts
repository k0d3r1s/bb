import { ULID_PATTERN } from "../shared/contract.js";

export const PROJECT_FOCUS_STORAGE_KEY = "bb-tasks:project-focus";

export function loadProjectFocus(): string | null {
  try {
    const value = window.localStorage.getItem(PROJECT_FOCUS_STORAGE_KEY);
    return value !== null && ULID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function storeProjectFocus(projectId: string | null): void {
  try {
    if (projectId === null) {
      window.localStorage.removeItem(PROJECT_FOCUS_STORAGE_KEY);
    } else {
      window.localStorage.setItem(PROJECT_FOCUS_STORAGE_KEY, projectId);
    }
  } catch {}
}
