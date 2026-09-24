import { useMemo, useState, type ReactNode } from "react";
import { useSetAtom } from "jotai";
import { useSidebarThreadDraftIds } from "@get-bb/plugin-sdk/app";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { ProjectGroup } from "../../shared/preferences.js";
import { sidebarProjectGroupsAtom } from "../preferences/atoms.js";
import {
  deleteProjectGroup,
  renameProjectGroup,
} from "../model/project-groups.js";
import type { SidebarThread } from "../model/sidebar-thread.js";
import {
  getCollapsedChildActivity,
  NO_COLLAPSED_CHILD_ACTIVITY,
} from "../model/thread-activity.js";
import { useSidebarRename } from "../rows/SidebarInlineRename.js";
import {
  ActionMenuItem,
  type ActionMenuSurface,
} from "../ui/action-menu-items.js";
import { SidebarHeaderControls } from "./SidebarHeaderControls.js";
import { TopLevelSidebarSection } from "./TopLevelSidebarSection.js";

const EMPTY_GROUP_THREADS: readonly SidebarThread[] = [];

interface ProjectGroupSectionProps {
  group: ProjectGroup;
  isCollapsed: boolean;
  threads: readonly SidebarThread[];
  onToggleCollapsed: (groupId: string) => void;
  children: ReactNode;
}

function ProjectGroupActionItems({
  surface,
  onRename,
  onUngroup,
}: {
  surface: ActionMenuSurface;
  onRename: () => void;
  onUngroup: () => void;
}) {
  return (
    <>
      <ActionMenuItem surface={surface} icon="Edit" onSelect={onRename}>
        Rename group
      </ActionMenuItem>
      <ActionMenuItem surface={surface} icon="FolderMinus" onSelect={onUngroup}>
        Ungroup projects
      </ActionMenuItem>
    </>
  );
}

export function ProjectGroupSection({
  group,
  isCollapsed,
  threads,
  onToggleCollapsed,
  children,
}: ProjectGroupSectionProps) {
  const setGroups = useSetAtom(sidebarProjectGroupsAtom);
  const draftThreadIds = useSidebarThreadDraftIds();
  const [isActionsOpen, setIsActionsOpen] = useState(false);
  const rename = useSidebarRename({
    kind: "projectGroup",
    id: group.id,
    ownerKey: `projectGroup:${group.id}`,
    name: group.name,
    label: "Group name",
    onSave: async (name) => {
      setGroups((current) => renameProjectGroup(current, group.id, name));
    },
  });
  const ungroup = () =>
    setGroups((current) => deleteProjectGroup(current, group.id));
  const collapsedThreads = isCollapsed ? threads : EMPTY_GROUP_THREADS;
  const collapsedActivity = useMemo(
    () =>
      collapsedThreads.length === 0
        ? NO_COLLAPSED_CHILD_ACTIVITY
        : getCollapsedChildActivity(collapsedThreads, draftThreadIds),
    [collapsedThreads, draftThreadIds],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={rename.isEditing}>
        <div data-sidebar-project-group-id={group.id}>
          <TopLevelSidebarSection
            label={group.name}
            labelEditor={rename.editor}
            onRename={rename.startEditing}
            stickyHeader={false}
            actions={
              <SidebarHeaderControls
                label={group.name}
                showNewThread={false}
                onOpenChange={setIsActionsOpen}
                onCloseAutoFocus={rename.onCloseAutoFocus}
              >
                <ProjectGroupActionItems
                  surface="dropdown"
                  onRename={rename.startEditingFromMenu}
                  onUngroup={ungroup}
                />
              </SidebarHeaderControls>
            }
            actionsMobileAlways
            actionsOpen={isActionsOpen}
            collapseControl={{
              isCollapsed,
              onToggleCollapsed: () => onToggleCollapsed(group.id),
            }}
            collapsedActivity={collapsedActivity}
            collapsedThreads={collapsedThreads}
          >
            <div className="ml-2 space-y-4 border-l border-border-hairline pl-1">
              {children}
            </div>
          </TopLevelSidebarSection>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        aria-label={`${group.name} actions`}
        onCloseAutoFocus={rename.onCloseAutoFocus}
      >
        <ProjectGroupActionItems
          surface="context"
          onRename={rename.startEditingFromMenu}
          onUngroup={ungroup}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}
