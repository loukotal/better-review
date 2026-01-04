import { createSignal, For, Show, createMemo, onCleanup, onMount } from "solid-js";
import type { StoredSession } from "@better-review/shared";

interface SessionSelectorProps {
  sessions: StoredSession[];
  activeSessionId: string | null;
  currentHeadSha?: string;
  disabled?: boolean;
  onSelect: (sessionId: string) => void;
  onNewSession: () => void;
  onHide?: (sessionId: string) => void;
}

export function SessionSelector(props: SessionSelectorProps) {
  const [isOpen, setIsOpen] = createSignal(false);

  const activeSession = createMemo(() =>
    props.sessions.find((s) => s.id === props.activeSessionId),
  );

  const activeIndex = createMemo(() => {
    const idx = props.sessions.findIndex((s) => s.id === props.activeSessionId);
    return idx >= 0 ? idx + 1 : null;
  });

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    if (isToday) {
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  };

  const isShaOutdated = (sessionSha: string) => {
    return props.currentHeadSha && sessionSha !== props.currentHeadSha;
  };

  const handleSelect = (sessionId: string) => {
    if (sessionId !== props.activeSessionId) {
      props.onSelect(sessionId);
    }
    setIsOpen(false);
  };

  const handleNewSession = () => {
    props.onNewSession();
    setIsOpen(false);
  };

  const handleHide = (e: MouseEvent, sessionId: string) => {
    e.stopPropagation();
    props.onHide?.(sessionId);
  };

  // Close dropdown when clicking outside
  const handleClickOutside = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest(".session-selector")) {
      setIsOpen(false);
    }
  };

  // Add/remove click listener with proper cleanup
  onMount(() => {
    document.addEventListener("click", handleClickOutside);
  });

  onCleanup(() => {
    document.removeEventListener("click", handleClickOutside);
  });

  return (
    <div class="session-selector relative">
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen())}
        disabled={props.disabled}
        class="flex items-center gap-1.5 px-2 py-0.5 text-sm border border-border hover:border-text-faint disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        title="Switch session"
      >
        <span class="text-text-muted">
          Session {activeIndex() || 1}
        </span>
        <Show when={activeSession() && isShaOutdated(activeSession()!.headSha)}>
          <span class="text-warning text-xs" title="PR has new commits">*</span>
        </Show>
        <svg
          class="w-3 h-3 text-text-faint"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {/* Dropdown */}
      <Show when={isOpen()}>
        <div class="absolute top-full left-0 mt-1 z-50 min-w-[200px] bg-bg-surface border border-border shadow-lg">
          {/* Session list */}
          <div class="max-h-[240px] overflow-y-auto">
            <For each={props.sessions}>
              {(session, index) => (
                <div
                  class="flex items-center justify-between px-3 py-2 hover:bg-bg-elevated cursor-pointer group"
                  classList={{
                    "bg-accent/10": session.id === props.activeSessionId,
                  }}
                  onClick={() => handleSelect(session.id)}
                >
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="text-sm text-text">
                        Session {index() + 1}
                      </span>
                      <Show when={isShaOutdated(session.headSha)}>
                        <span
                          class="text-warning text-xs"
                          title="Created on older commit"
                        >
                          (outdated)
                        </span>
                      </Show>
                    </div>
                    <div class="flex items-center gap-2 text-xs text-text-faint">
                      <span>{session.headSha.slice(0, 7)}</span>
                      <span>-</span>
                      <span>{formatDate(session.createdAt)}</span>
                    </div>
                  </div>

                  {/* Hide button */}
                  <Show when={props.onHide && props.sessions.length > 1}>
                    <button
                      type="button"
                      onClick={(e) => handleHide(e, session.id)}
                      class="opacity-0 group-hover:opacity-100 p-1 text-text-faint hover:text-error transition-opacity"
                      title="Hide session"
                    >
                      <svg
                        class="w-3 h-3"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="2"
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </div>

          {/* New session button */}
          <div class="border-t border-border">
            <button
              type="button"
              onClick={handleNewSession}
              class="w-full flex items-center gap-2 px-3 py-2 text-sm text-accent hover:bg-bg-elevated transition-colors"
            >
              <svg
                class="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M12 4v16m8-8H4"
                />
              </svg>
              New Session
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
