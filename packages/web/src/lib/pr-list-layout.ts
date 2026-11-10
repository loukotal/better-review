export type PrListLayout = "title-first" | "table";

export const PR_LIST_LAYOUT_KEY = "better-review:pr-list-layout";
type LayoutStorage = Pick<Storage, "getItem" | "setItem">;

export function loadPrListLayout(storage?: LayoutStorage): PrListLayout {
  try {
    return (storage ?? localStorage).getItem(PR_LIST_LAYOUT_KEY) === "table"
      ? "table"
      : "title-first";
  } catch {
    return "title-first";
  }
}

export function savePrListLayout(layout: PrListLayout, storage?: LayoutStorage): void {
  try {
    (storage ?? localStorage).setItem(PR_LIST_LAYOUT_KEY, layout);
  } catch {}
}
