import { useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import { Icon } from "@/components/ui/icon";
import {
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { sidebarProjectGroupsAtom } from "../preferences/atoms.js";
import {
  assignProjectToGroup,
  createProjectGroup,
  createProjectGroupId,
  findProjectGroup,
} from "../model/project-groups.js";
import type { ActionMenuSurface } from "../ui/action-menu-items.js";
import {
  NameCreateDialog,
  type NameCreateDialogCopy,
} from "./ThreadSectionCreateDialog.js";

const PROJECT_GROUP_DIALOG_COPY: NameCreateDialogCopy = {
  title: "New project group",
  description: "Group projects together in the sidebar.",
  inputLabel: "Group name",
  submitLabel: "Create group",
  emptyMessage: "Group name cannot be empty.",
};

const SURFACE_MENU = {
  context: {
    Item: ContextMenuItem,
    Portal: ContextMenuPortal,
    Separator: ContextMenuSeparator,
    Sub: ContextMenuSub,
    SubContent: ContextMenuSubContent,
    SubTrigger: ContextMenuSubTrigger,
  },
  dropdown: {
    Item: DropdownMenuItem,
    Portal: DropdownMenuPortal,
    Separator: DropdownMenuSeparator,
    Sub: DropdownMenuSub,
    SubContent: DropdownMenuSubContent,
    SubTrigger: DropdownMenuSubTrigger,
  },
} as const;

interface ProjectGroupMenuItemsProps {
  projectId: string;
  surface: ActionMenuSurface;
  onNewGroup: () => void;
}

export function ProjectGroupMenuItems({
  projectId,
  surface,
  onNewGroup,
}: ProjectGroupMenuItemsProps) {
  const [groups, setGroups] = useAtom(sidebarProjectGroupsAtom);
  const currentGroup = findProjectGroup(groups, projectId);
  const { Item, Portal, Separator, Sub, SubContent, SubTrigger } =
    SURFACE_MENU[surface];
  const moveTo = (groupId: string | null) =>
    setGroups((current) => assignProjectToGroup(current, projectId, groupId));
  return (
    <Sub>
      <SubTrigger>
        <Icon name="Layers" aria-hidden="true" />
        Move to group
      </SubTrigger>
      <Portal>
        <SubContent className="w-max min-w-32 max-w-64">
          {groups.map((group) => {
            const isCurrent = group.id === currentGroup?.id;
            return (
              <Item
                key={group.id}
                role="menuitemradio"
                aria-checked={isCurrent}
                onSelect={() => {
                  if (!isCurrent) moveTo(group.id);
                }}
              >
                <span className="min-w-0 truncate">{group.name}</span>
                <span className="ml-auto inline-flex size-4 shrink-0 items-center justify-center">
                  {isCurrent && <Icon name="Check" className="size-4" />}
                </span>
              </Item>
            );
          })}
          {groups.length > 0 && <Separator />}
          <Item onSelect={onNewGroup}>
            <Icon name="Plus" aria-hidden="true" />
            New group…
          </Item>
          {currentGroup && (
            <Item onSelect={() => moveTo(null)}>
              <Icon name="FolderMinus" aria-hidden="true" />
              Remove from group
            </Item>
          )}
        </SubContent>
      </Portal>
    </Sub>
  );
}

export function useNewProjectGroupDialog(projectId: string) {
  const [open, setOpen] = useState(false);
  const setGroups = useSetAtom(sidebarProjectGroupsAtom);
  return {
    openDialog: () => setOpen(true),
    dialog: (
      <NameCreateDialog
        copy={PROJECT_GROUP_DIALOG_COPY}
        open={open}
        onOpenChange={setOpen}
        onCreate={(name) => {
          setGroups((current) =>
            createProjectGroup(current, {
              id: createProjectGroupId(),
              name,
              projectIds: [projectId],
            }),
          );
          setOpen(false);
        }}
      />
    ),
  };
}
