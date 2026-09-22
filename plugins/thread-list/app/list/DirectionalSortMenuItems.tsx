import { Icon } from "@/components/ui/icon";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { SortDirection } from "../../shared/preferences.js";

interface DirectionalSortMenuItemsProps<Sort extends string> {
  onDirectionChange: (direction: Exclude<SortDirection, "default">) => void;
  onSortChange: (sort: Sort) => void;
  options: readonly {
    direction: Exclude<SortDirection, "default">;
    label: string;
    sort: Sort;
  }[];
  savedDirection: SortDirection;
  selectedSort: string;
}

export function DirectionalSortMenuItems<Sort extends string>({
  onDirectionChange,
  onSortChange,
  options,
  savedDirection,
  selectedSort,
}: DirectionalSortMenuItemsProps<Sort>) {
  return options.map((option) => {
    const selected = selectedSort === option.sort;
    const direction =
      savedDirection === "default" ? option.direction : savedDirection;
    const nextDirection = selected
      ? direction === "ascending"
        ? "descending"
        : "ascending"
      : option.direction;
    return (
      <DropdownMenuItem
        key={option.sort}
        role="menuitemradio"
        aria-checked={selected}
        aria-label={
          selected
            ? `${option.label}, ${direction}. Sort ${nextDirection}`
            : option.label
        }
        onSelect={(event) => {
          event.preventDefault();
          onSortChange(option.sort);
          onDirectionChange(nextDirection);
        }}
      >
        {option.label}
        {selected && (
          <span className="sr-only">
            , {direction}. Sort {nextDirection}
          </span>
        )}
        <span className="ml-auto inline-flex size-4 shrink-0 items-center justify-center">
          {selected && (
            <Icon
              name={direction === "ascending" ? "ArrowUp" : "ArrowDown"}
              className="size-4"
            />
          )}
        </span>
      </DropdownMenuItem>
    );
  });
}
