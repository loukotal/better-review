import { A } from "@solidjs/router";
import { createMemo, createResource, createSignal, For, Show } from "solid-js";

import type { ReviewSession, ReviewSessionStatus } from "@better-review/shared";

import { AppHeader } from "../components/AppHeader";
import { Alert, Badge, Button, EmptyState, LoadingState } from "../design-system";
import { SpinnerIcon } from "../icons/spinner-icon";
import { fetchWithApiAuth } from "../lib/apiAuth";

const statusFilters = ["all", "pending", "approved", "feedback", "cancelled"] as const;
type StatusFilter = (typeof statusFilters)[number];

function statusVariant(status: ReviewSessionStatus): "accent" | "success" | "warning" | "neutral" {
  if (status === "approved") return "success";
  if (status === "feedback") return "warning";
  if (status === "pending") return "accent";
  return "neutral";
}

function formatRelativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function sessionScope(session: ReviewSession): string {
  const scope = session.repoRoot ?? session.cwd;
  if (!scope) return session.origin;
  const segments = scope.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments.at(-1) ?? scope;
}

async function fetchSessions(): Promise<ReviewSession[]> {
  const response = await fetchWithApiAuth("/api/sessions");
  if (!response.ok) throw new Error(await response.text());
  const body = (await response.json()) as { sessions: ReviewSession[] };
  return body.sessions;
}

export default function AgentReviewIndexPage() {
  const [sessions, { refetch }] = createResource(fetchSessions);
  const [filter, setFilter] = createSignal<StatusFilter>("all");

  const filteredSessions = createMemo(() => {
    const selected = filter();
    const items = sessions() ?? [];
    return selected === "all" ? items : items.filter((session) => session.status === selected);
  });

  const countFor = (status: StatusFilter) => {
    const items = sessions() ?? [];
    return status === "all" ? items.length : items.filter((item) => item.status === status).length;
  };

  return (
    <div class="flex h-screen flex-col bg-bg text-text">
      <AppHeader constrained />

      <main class="flex-1 overflow-y-auto">
        <div class="mx-auto max-w-6xl px-4 py-4">
          <div class="mb-4 flex items-center justify-between gap-4">
            <div class="min-w-0">
              <div class="flex items-baseline gap-2.5">
                <h1 class="text-lg font-semibold tracking-tight text-text">Agent reviews</h1>
                <Show when={!sessions.loading && sessions()}>
                  <span class="font-mono text-xs text-text-faint">{sessions()!.length}</span>
                </Show>
              </div>
              <p class="mt-1 text-sm text-text-muted">
                Review plans, messages, and code changes submitted by your agents.
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              disabled={sessions.loading}
              onClick={() => void refetch()}
            >
              <Show when={sessions.loading}>
                <SpinnerIcon size={12} class="animate-spin" />
              </Show>
              {sessions.loading ? "Refreshing" : "Refresh"}
            </Button>
          </div>

          <Show when={sessions()}>
            <div
              class="mb-3 flex items-center gap-1 overflow-x-auto border-y border-border py-1"
              role="group"
              aria-label="Filter agent reviews by status"
            >
              <For each={statusFilters}>
                {(status) => (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-pressed={filter() === status}
                    class={
                      filter() === status
                        ? "bg-bg-elevated text-text"
                        : "text-text-muted hover:bg-bg-surface hover:text-text"
                    }
                    onClick={() => setFilter(status)}
                  >
                    <span class="capitalize">{status}</span>
                    <span class="font-mono text-[11px] text-text-faint">{countFor(status)}</span>
                  </Button>
                )}
              </For>
            </div>
          </Show>

          <Show when={sessions.loading && !sessions()}>
            <LoadingState label="Loading agent reviews…" />
          </Show>

          <Show when={sessions.error}>
            <Alert
              intent="danger"
              title="Could not load agent reviews"
              actions={
                <Button type="button" size="sm" onClick={() => void refetch()}>
                  Try again
                </Button>
              }
            >
              {sessions.error instanceof Error ? sessions.error.message : "Please try again."}
            </Alert>
          </Show>

          <Show when={sessions() && sessions()!.length === 0}>
            <EmptyState
              title="No agent reviews yet"
              description="Reviews requested by Pi, OpenCode, or another agent will appear here."
            />
          </Show>

          <Show when={sessions() && sessions()!.length > 0 && filteredSessions().length === 0}>
            <EmptyState
              title={`No ${filter()} reviews`}
              description="Choose another status to see more review sessions."
            />
          </Show>

          <Show when={filteredSessions().length > 0}>
            <div class="border-t border-border">
              <For each={filteredSessions()}>
                {(session) => (
                  <A
                    href={`/agent-review/${encodeURIComponent(session.id)}`}
                    class="group grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-b border-border px-2 py-3 hover:bg-bg-surface sm:grid-cols-[minmax(0,1fr)_9rem_7rem]"
                  >
                    <div class="min-w-0">
                      <div class="flex min-w-0 items-center gap-2">
                        <span class="truncate text-sm font-medium text-text group-hover:text-accent">
                          {session.title}
                        </span>
                        <Badge variant={statusVariant(session.status)}>{session.status}</Badge>
                        <Badge variant="neutral">{session.mode}</Badge>
                      </div>
                      <div class="mt-1 flex min-w-0 items-center gap-2 text-xs text-text-faint">
                        <span class="truncate font-mono" title={session.repoRoot ?? session.cwd}>
                          {sessionScope(session)}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{session.origin}</span>
                      </div>
                    </div>
                    <span class="self-center whitespace-nowrap text-right text-xs text-text-faint sm:text-left">
                      {formatRelativeTime(session.createdAt)}
                    </span>
                    <span class="hidden self-center text-right text-xs font-medium text-text-muted group-hover:text-accent sm:block">
                      Open review →
                    </span>
                  </A>
                )}
              </For>
            </div>
          </Show>
        </div>
      </main>
    </div>
  );
}
