import { useAtom } from "jotai";
import { Icon } from "@/components/ui/icon";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DirectionalSortMenuItems } from "./DirectionalSortMenuItems.js";
import { PROJECT_SORT_OPTIONS, isCustomProjectSort } from "./projectSort.js";
import {
  sidebarProjectSortAtom,
  sidebarProjectSortDirectionAtom,
} from "../preferences/atoms.js";

export function ProjectSortMenuItems() {
  const [sort, setSort] = useAtom(sidebarProjectSortAtom);
  const [savedDirection, setDirection] = useAtom(
    sidebarProjectSortDirectionAtom,
  );
  return (
    <>
      <DropdownMenuItem
        role="menuitemradio"
        aria-checked={isCustomProjectSort(sort)}
        onSelect={(event) => {
          event.preventDefault();
          setSort("custom");
        }}
      >
        Custom
        <span className="ml-auto inline-flex size-4 shrink-0 items-center justify-center">
          {isCustomProjectSort(sort) && (
            <Icon name="Check" className="size-4" />
          )}
        </span>
      </DropdownMenuItem>
      <DirectionalSortMenuItems
        options={PROJECT_SORT_OPTIONS}
        selectedSort={sort}
        savedDirection={savedDirection}
        onSortChange={setSort}
        onDirectionChange={setDirection}
      />
    </>
  );
}
