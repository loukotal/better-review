import { type Component, Show, createMemo, createSignal } from "solid-js";
import { marked } from "marked";

// Configure marked for safe output
marked.setOptions({
  gfm: true,
  breaks: true,
});

export type PrState = "open" | "closed" | "merged";

export interface CheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | null;
}

export interface PrStatus {
  state: PrState;
  draft: boolean;
  mergeable: boolean | null;
  title: string;
  body: string;
  author: string;
  url: string;
  checks: CheckRun[];
}

interface PrStatusBarProps {
  status: PrStatus | null;
  loading?: boolean;
}

const stateStyles: Record<PrState, { bg: string; text: string; label: string }> = {
  open: { bg: "bg-success/20", text: "text-success", label: "Open" },
  closed: { bg: "bg-error/20", text: "text-error", label: "Closed" },
  merged: { bg: "bg-merged/20", text: "text-merged", label: "Merged" },
};

function ChecksIndicator(props: { checks: CheckRun[] }) {
  const summary = createMemo(() => {
    const checks = props.checks;
    if (checks.length === 0) return null;

    const completed = checks.filter((c) => c.status === "completed");
    const inProgress = checks.filter((c) => c.status === "in_progress" || c.status === "queued");
    const failed = completed.filter((c) => c.conclusion === "failure" || c.conclusion === "timed_out");
    const passed = completed.filter((c) => c.conclusion === "success" || c.conclusion === "skipped" || c.conclusion === "neutral");

    return { total: checks.length, completed: completed.length, inProgress: inProgress.length, failed: failed.length, passed: passed.length };
  });

  const status = createMemo(() => {
    const s = summary();
    if (!s) return null;
    if (s.failed > 0) return "failed";
    if (s.inProgress > 0) return "pending";
    if (s.passed === s.total) return "passed";
    return "pending";
  });

  return (
    <Show when={summary()}>
      {(s) => (
        <div class="flex items-center gap-1.5">
          <Show when={status() === "passed"}>
            <svg class="w-3 h-3 text-success" viewBox="0 0 16 16" fill="currentColor">
              <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/>
            </svg>
          </Show>
          <Show when={status() === "failed"}>
            <svg class="w-3 h-3 text-error" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z"/>
            </svg>
          </Show>
          <Show when={status() === "pending"}>
            <svg class="w-3 h-3 text-yellow-500 animate-spin" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8z" opacity="0.3"/>
              <path d="M8 0a8 8 0 0 1 8 8h-2a6 6 0 0 0-6-6V0z"/>
            </svg>
          </Show>
          <span class="text-sm text-text-muted">
            {s().passed}/{s().total} checks
          </span>
        </div>
      )}
    </Show>
  );
}

function ExternalLinkIcon() {
  return (
    <svg class="w-2.5 h-2.5" viewBox="0 0 16 16" fill="currentColor">
      <path d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1z"/>
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg class="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
      <path d="M4.5 5.5L8 9l3.5-3.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  );
}

export const PrStatusBar: Component<PrStatusBarProps> = (props) => {
  const [showDescription, setShowDescription] = createSignal(false);
  
  return (
    <Show when={!props.loading && props.status} fallback={
      <Show when={props.loading}>
        <div class="flex items-center gap-2 text-sm text-text-faint">
          <span class="animate-pulse">Loading status...</span>
        </div>
      </Show>
    }>
      {(status) => {
        const style = () => stateStyles[status().state];
        const hasDescription = () => status().body.trim().length > 0;
        
        return (
          <div class="space-y-2">
            <div class="flex items-center gap-3">
              {/* State badge */}
              <div class={`flex items-center gap-1.5 px-1.5 py-0.5 ${style().bg}`}>
                <span class={`text-sm font-medium ${style().text}`}>
                  {status().draft ? "Draft" : style().label}
                </span>
              </div>

              {/* Title (clickable) & Author */}
              <div class="flex items-center gap-2 min-w-0 flex-1">
                <a 
                  href={status().url} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  class="text-[11px] text-text hover:text-accent truncate max-w-[300px] inline-flex items-center gap-1 group"
                  title={`${status().title} - Open in GitHub`}
                >
                  <span class="truncate">{status().title}</span>
                  <span class="opacity-0 group-hover:opacity-100 transition-opacity">
                    <ExternalLinkIcon />
                  </span>
                </a>
                <span class="text-sm text-text-faint">
                  by {status().author}
                </span>
              </div>

              {/* CI Checks */}
              <ChecksIndicator checks={status().checks} />

              {/* Mergeable status */}
              <Show when={status().state === "open" && status().mergeable !== null}>
                <div class="flex items-center gap-1">
                  <Show when={status().mergeable} fallback={
                    <span class="text-sm text-error">Conflicts</span>
                  }>
                    <span class="text-sm text-success">Mergeable</span>
                  </Show>
                </div>
              </Show>
              
              {/* Description toggle */}
              <Show when={hasDescription()}>
                <button
                  type="button"
                  onClick={() => setShowDescription(!showDescription())}
                  class="flex items-center gap-1 text-sm text-text-faint hover:text-text transition-colors"
                  title={showDescription() ? "Hide description" : "Show description"}
                >
                  <span class={`transform transition-transform ${showDescription() ? "rotate-180" : ""}`}>
                    <ChevronDownIcon />
                  </span>
                  <span>Description</span>
                </button>
              </Show>
            </div>
            
            {/* Description panel */}
            <Show when={showDescription() && hasDescription()}>
              <div 
                class="text-[11px] text-text-muted bg-bg-elevated border border-border p-3 leading-relaxed max-h-[200px] overflow-y-auto markdown-content"
                innerHTML={marked.parse(status().body, { async: false }) as string}
              />
            </Show>
          </div>
        );
      }}
    </Show>
  );
};
