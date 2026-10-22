import type { ReviewSnapshot } from "@better-review/shared";

import { parseReviewTokens } from "../utils/parseReviewTokens";

export const AUTO_ORDER_PREFERENCE_KEY = "better-review:automatic-review-order";
const APPLIED_KEY = "better-review:applied-review-orders";
type StorageAccess = Pick<Storage, "getItem" | "setItem">;

export function loadAutomaticReviewOrder(storage?: StorageAccess): boolean {
  try {
    const value = JSON.parse(
      (storage ?? localStorage).getItem(AUTO_ORDER_PREFERENCE_KEY) ?? "null",
    );
    return !(value?.version === 1 && value.enabled === false);
  } catch {
    return true;
  }
}

export function saveAutomaticReviewOrder(enabled: boolean, storage?: StorageAccess) {
  try {
    (storage ?? localStorage).setItem(
      AUTO_ORDER_PREFERENCE_KEY,
      JSON.stringify({ version: 1, enabled }),
    );
  } catch {}
}

export interface AvailableReviewOrder {
  prUrl: string;
  sessionId: string;
  revision: string;
  mode: "full" | "commit";
  messageId: string;
  files: string[];
}

export interface ReviewOrderObservation {
  order: AvailableReviewOrder | null;
  hydration?: {
    prUrl: string;
    mode: "full" | "commit";
    revision: string | null;
    /** Errors release the page too; the first late snapshot must not replay saved history. */
    snapshotLoaded: boolean;
  };
}

export interface AutomaticReviewOrderContext {
  requestedUrl: string;
  loadedUrl: string | null;
  mode: "full" | "commit";
  revision: string | null;
  paths: string[];
  loading: boolean;
  loadingCommits: boolean;
  switchingPr: boolean;
}

export interface SavedReviewOrderScope {
  sessionId: string;
  mode: "full" | "commit";
  commitSha: string | null;
  /** null means conversion is saved but continuation admission is still pending. */
  afterSubmissionId?: string | null;
}

/** Never infer provenance from the displayed diff or consume the live assistant tail. */
export function availableReviewOrder(
  snapshot: ReviewSnapshot | null,
  scope: { prUrl: string; sessionId: string; revision: string; mode: "full" | "commit" },
  savedScope: SavedReviewOrderScope | null,
): AvailableReviewOrder | null {
  if (
    !savedScope ||
    savedScope.sessionId !== scope.sessionId ||
    savedScope.mode !== scope.mode ||
    (scope.mode === "commit"
      ? savedScope.commitSha !== scope.revision
      : savedScope.commitSha !== null)
  )
    return null;
  if (!snapshot || snapshot.sessionId !== scope.sessionId || snapshot.revision !== scope.revision)
    return null;
  let result: AvailableReviewOrder | null = null;
  let afterScopeBoundary = savedScope.afterSubmissionId === undefined;
  for (const [index, message] of snapshot.messages.entries()) {
    if (savedScope.afterSubmissionId && message.submissionId === savedScope.afterSubmissionId)
      afterScopeBoundary = true;
    if (!afterScopeBoundary) continue;
    const content = message.parts
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    if (
      message.role === "user" &&
      content.startsWith("Pulled the latest full PR into this review session.")
    )
      result = null;
    if (message.role !== "assistant" || message.metadata.revision !== scope.revision) continue;
    if (snapshot.running && index === snapshot.messages.length - 1) continue;
    if (
      message.submissionId &&
      !snapshot.settlements.some(
        (item) => item.submissionId === message.submissionId && item.outcome === "completed",
      )
    )
      continue;
    const order: unknown = parseReviewTokens(content).reviewOrder;
    if (
      !Array.isArray(order) ||
      !order.length ||
      !order.every((file) => typeof file === "string" && file.length > 0) ||
      new Set(order).size !== order.length
    )
      continue;
    result = { ...scope, messageId: message.id, files: order };
  }
  return result;
}

/** Persist consumption, not just the preference: reload must not undo a manual override. */
export function createAutomaticOrderTracker(storage?: StorageAccess) {
  let applied: string[] = [];
  try {
    const value = JSON.parse((storage ?? localStorage).getItem(APPLIED_KEY) ?? "null");
    if (
      value?.version === 1 &&
      Array.isArray(value.keys) &&
      value.keys.every((key: unknown) => typeof key === "string")
    )
      applied = value.keys.slice(-100);
  } catch {}
  return {
    take(order: AvailableReviewOrder, paths: string[]): string[] | null {
      if (!order.files.every((file) => paths.includes(file))) return null;
      const key = JSON.stringify([
        order.prUrl,
        order.sessionId,
        order.mode,
        order.revision,
        order.messageId,
        order.files,
      ]);
      if (applied.includes(key)) return null;
      applied = [...applied, key].slice(-100);
      try {
        (storage ?? localStorage).setItem(
          APPLIED_KEY,
          JSON.stringify({ version: 1, keys: applied }),
        );
      } catch {}
      return order.files;
    },
  };
}

/** Own automatic acceptance, not manual ordering or the displayed-order cache. */
export function createAutomaticReviewOrder(options: {
  storage?: StorageAccess;
  apply(files: string[]): void;
  /** UI adapter: observations read current context without relying on effect order. */
  context?: () => AutomaticReviewOrderContext;
}) {
  let state = { enabled: loadAutomaticReviewOrder(options.storage), initialPending: false };
  const tracker = createAutomaticOrderTracker(options.storage);
  let context: AutomaticReviewOrderContext | undefined;
  let latest: AvailableReviewOrder | null = null;
  let initial: { url: string; fallback: boolean } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const listeners = new Set<() => void>();
  const currentContext = () => options.context?.() ?? context;
  const publish = (previous: typeof state) => {
    if (!disposed && previous !== state) for (const listener of listeners) listener();
  };
  function clearInitial() {
    clearTimeout(timer);
    timer = undefined;
    initial = null;
    if (state.initialPending) state = { ...state, initialPending: false };
  }
  const matches = (order: AvailableReviewOrder, current: AutomaticReviewOrderContext) =>
    current.loadedUrl === current.requestedUrl &&
    order.prUrl === current.loadedUrl &&
    order.mode === current.mode &&
    order.revision === current.revision;
  function take(order: AvailableReviewOrder, paths: string[]) {
    if (!order.files.length || new Set(order.files).size !== order.files.length) return null;
    return tracker.take(order, paths);
  }
  function applyLive() {
    const current = currentContext();
    if (
      disposed ||
      !state.enabled ||
      state.initialPending ||
      !latest ||
      !current ||
      current.loading ||
      current.loadingCommits ||
      current.switchingPr ||
      !matches(latest, current)
    )
      return;
    const files = take(latest, current.paths);
    if (files && !disposed) options.apply(files);
  }
  return {
    getState: (): Readonly<typeof state> => state,
    subscribe(listener: () => void) {
      if (!disposed) listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    updateContext(value: AutomaticReviewOrderContext) {
      if (disposed) return;
      context = value;
      applyLive();
    },
    beginInitialLoad(url: string) {
      if (disposed) return;
      const previous = state;
      clearInitial();
      if (state.enabled) {
        const captured = { url, fallback: false };
        initial = captured;
        state = { ...state, initialPending: true };
        timer = setTimeout(() => {
          if (disposed || initial !== captured) return;
          const before = state;
          captured.fallback = true;
          state = { ...state, initialPending: false };
          timer = undefined;
          applyLive();
          publish(before);
        }, 10_000);
      }
      publish(previous);
    },
    cancelInitialLoad() {
      if (disposed) return;
      const previous = state;
      clearInitial();
      publish(previous);
    },
    observe(observation: ReviewOrderObservation) {
      if (disposed) return;
      const previous = state;
      latest = observation.order;
      const hydration = observation.hydration;
      const current = currentContext();
      if (
        initial &&
        hydration &&
        current &&
        initial.url === hydration.prUrl &&
        hydration.prUrl === current.loadedUrl &&
        hydration.prUrl === current.requestedUrl &&
        hydration.mode === current.mode &&
        hydration.revision === current.revision
      ) {
        if (latest && state.enabled && matches(latest, current)) {
          const files = take(latest, current.paths);
          // Apply before releasing the initial render gate. On fallback, only
          // consume the first loaded history; future completed orders remain live.
          if (files && !initial.fallback && !disposed) options.apply(files);
        }
        if (hydration.snapshotLoaded) initial = null;
        else initial.fallback = true;
        clearTimeout(timer);
        timer = undefined;
        if (state.initialPending) state = { ...state, initialPending: false };
      }
      applyLive();
      publish(previous);
    },
    setEnabled(enabled: boolean) {
      if (disposed) return;
      const previous = state;
      saveAutomaticReviewOrder(enabled, options.storage);
      if (state.enabled !== enabled) state = { ...state, enabled };
      if (!enabled) clearInitial();
      applyLive();
      publish(previous);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      initial = null;
      listeners.clear();
    },
  };
}
