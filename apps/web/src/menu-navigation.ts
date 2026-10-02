export type MenuKeyEvent = Pick<KeyboardEvent, "key" | "preventDefault" | "stopPropagation">;
export type MenuFocusable = { focus(): void };

export function handleMenuNavigation(
  event: MenuKeyEvent,
  items: readonly MenuFocusable[],
  activeIndex: number,
  close: (restoreFocus: boolean) => void,
): boolean {
  if (event.key === "Escape") {
    event.preventDefault(); event.stopPropagation(); close(true); return true;
  }
  if (event.key === "Tab") return false;
  if (!items.length) return false;
  let next: number | null = null;
  if (event.key === "ArrowDown") next = activeIndex < 0 ? 0 : (activeIndex + 1) % items.length;
  else if (event.key === "ArrowUp") next = activeIndex < 0 ? items.length - 1 : (activeIndex - 1 + items.length) % items.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  if (next === null) return false;
  event.preventDefault(); event.stopPropagation(); items[next]?.focus(); return true;
}

export function openMenuFromTrigger(event: Pick<KeyboardEvent, "key" | "preventDefault" | "stopPropagation">, open: (last: boolean) => void): boolean {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
  event.preventDefault(); event.stopPropagation(); open(event.key === "ArrowUp"); return true;
}
