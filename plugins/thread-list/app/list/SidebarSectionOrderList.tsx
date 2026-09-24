import { Fragment, type ReactNode } from "react";
import { DndContext } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { SidebarSectionId } from "../model/sidebar-section-id.js";
import type { ReorderDndContextProps } from "../ui/useReorderDnd.js";

export interface SidebarSectionOrderGroup {
  key: string;
  sectionIds: readonly SidebarSectionId[];
  render: (children: ReactNode) => ReactNode;
}

export type SidebarSectionOrderLayoutEntry =
  | SidebarSectionId
  | SidebarSectionOrderGroup;

interface SidebarSectionOrderListProps {
  children: (sectionId: SidebarSectionId) => ReactNode;
  dndContextProps?: ReorderDndContextProps;
  layout?: readonly SidebarSectionOrderLayoutEntry[];
  order: readonly SidebarSectionId[];
  trailing?: ReactNode;
}

export function SidebarSectionOrderList({
  children,
  dndContextProps,
  layout,
  order,
  trailing,
}: SidebarSectionOrderListProps) {
  const content = (
    <SortableContext items={[...order]} strategy={verticalListSortingStrategy}>
      <div className="space-y-4">
        {(layout ?? order).map((entry) =>
          typeof entry === "string" ? (
            children(entry)
          ) : (
            <Fragment key={entry.key}>
              {entry.render(entry.sectionIds.map(children))}
            </Fragment>
          ),
        )}
      </div>
    </SortableContext>
  );

  return dndContextProps ? (
    <DndContext {...dndContextProps}>
      {content}
      {trailing}
    </DndContext>
  ) : (
    content
  );
}
