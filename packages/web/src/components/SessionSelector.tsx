import { For, Show, createMemo } from "solid-js";

import type { StoredSession } from "@better-review/shared";

import { Button, IconButton, Popover } from "../design-system";

interface SessionSelectorProps {
  sessions: StoredSession[];
  activeSessionId: string | null;
  currentHeadSha?: string;
  disabled?: boolean;
  creatingNewSession?: boolean;
  onSelect: (sessionId: string) => void;
  onNewSession: () => void;
  onHide?: (sessionId: string) => void;
}

export function SessionSelector(props: SessionSelectorProps) {
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
  };

  const handleNewSession = () => {
    if (props.disabled || props.creatingNewSession) return;
    props.onNewSession();
  };

  const handleHide = (e: MouseEvent, sessionId: string) => {
    e.stopPropagation();
    props.onHide?.(sessionId);
  };

  return (
    <div class="flex flex-wrap items-center justify-between gap-2">
      <Popover align="left" label={`Session ${activeIndex() || 1}`} disabled={props.disabled}>
        {(close) => (
          <div class="space-y-1">
            <For each={props.sessions}>
              {(session, index) => (
                <div class="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    fullWidth
                    class="justify-start text-left"
                    aria-pressed={session.id === props.activeSessionId}
                    onClick={() => {
                      handleSelect(session.id);
                      close();
                    }}
                  >
                    <span class="flex flex-col items-start gap-0.5">
                      <span>
                        Session {index() + 1}
                        {isShaOutdated(session.headSha) ? " (older commit)" : ""}
                      </span>
                      <span class="text-xs text-text-muted">
                        {session.headSha.slice(0, 7)} · {formatDate(session.createdAt)}
                      </span>
                    </span>
                  </Button>
                  <Show when={props.onHide && props.sessions.length > 1}>
                    <IconButton
                      label={`Hide session ${index() + 1}`}
                      onClick={(e) => handleHide(e, session.id)}
                    >
                      ×
                    </IconButton>
                  </Show>
                </div>
              )}
            </For>
          </div>
        )}
      </Popover>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleNewSession}
        disabled={props.disabled || props.creatingNewSession}
      >
        {props.creatingNewSession ? "Creating session…" : "+ New session"}
      </Button>
    </div>
  );
}
