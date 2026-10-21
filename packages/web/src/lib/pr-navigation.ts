export type PrTab = "overview" | "changes" | "checks";

/** Explicit tabs win over legacy review deep links. */
export function resolvePrTab(params: Record<string, unknown>): PrTab {
  if (params.tab === "overview" || params.tab === "changes" || params.tab === "checks")
    return params.tab;
  return "changes";
}

/** Detail deep links may return only to this application's PR list, never an external URL. */
export function prListReturnPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const parsed = new URL(value, "https://better-review.invalid");
    return parsed.origin === "https://better-review.invalid" && parsed.pathname === "/"
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : "/";
  } catch {
    return "/";
  }
}

export function prPageHref(
  url: string,
  options: { tab?: PrTab; returnTo?: string; sessionId?: string | null; showChat?: boolean } = {},
): string {
  const params = new URLSearchParams({ prUrl: url });
  if (options.tab) params.set("tab", options.tab);
  if (options.returnTo !== undefined) params.set("returnTo", prListReturnPath(options.returnTo));
  if (options.sessionId) params.set("sessionId", options.sessionId);
  if (options.showChat) params.set("showChat", "1");
  return `/review?${params}`;
}

function navigationState(value: unknown): Record<string, unknown> {
  const state: Record<string, unknown> =
    typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};
  // Router-owned depth belongs to the current entry, never to the next pushed entry.
  delete state._depth;
  return state;
}
function listOrigin(value: unknown): { path: string; steps: number } | undefined {
  const origin = navigationState(value).prListOrigin;
  if (typeof origin !== "object" || origin === null || !("path" in origin) || !("steps" in origin))
    return;
  if (
    typeof origin.path !== "string" ||
    origin.path !== prListReturnPath(origin.path) ||
    typeof origin.steps !== "number" ||
    !Number.isSafeInteger(origin.steps) ||
    origin.steps < 1 ||
    origin.steps > 1000
  )
    return;
  return { path: origin.path, steps: origin.steps };
}
export function prListLinkState(path: string, state?: unknown) {
  return { ...navigationState(state), prListOrigin: { path: prListReturnPath(path), steps: 1 } };
}
export function advancePrLinkState(state: unknown) {
  const origin = listOrigin(state);
  return origin
    ? { ...navigationState(state), prListOrigin: { ...origin, steps: origin.steps + 1 } }
    : navigationState(state);
}
export function prListBackSteps(state: unknown, path: string): number | undefined {
  const origin = listOrigin(state);
  return origin?.path === prListReturnPath(path) ? origin.steps : undefined;
}
export function prQueryChanges(
  search: string,
  changes: Record<string, string | undefined>,
): boolean {
  const params = new URLSearchParams(search);
  return Object.entries(changes).some(([key, value]) =>
    value === undefined
      ? params.has(key)
      : params.getAll(key).length !== 1 || params.get(key) !== value,
  );
}
/** Capture before route disposal. Queue links share the list's exact storage key. */
export function rememberPrListScroll(path: string, element?: HTMLElement): void {
  try {
    if (prListReturnPath(path) !== path) return;
    const scroll = element ?? document.querySelector<HTMLElement>("[data-pr-list-scroll]");
    if (!scroll?.isConnected) return;
    sessionStorage.setItem(`pr-list-scroll:${path}`, String(scroll.scrollTop));
  } catch {
    /* Storage may be disabled. Navigation must still work. */
  }
}
