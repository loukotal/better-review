import { For, Show, type Component } from "solid-js";

import { Button } from "../design-system";
import { SpinnerIcon } from "../icons/spinner-icon";
import type { ReadingDiffResult } from "../lib/query";

interface ReadingDiffEmptyProps {
  loading: boolean;
  error: string | null;
  scopeLabel: string;
  onGenerate: () => void;
}

export const ReadingDiffEmpty: Component<ReadingDiffEmptyProps> = (props) => (
  <div class="flex flex-1 items-start justify-center px-6 pt-16">
    <div class="w-full max-w-xl border-y border-border py-8">
      <div class="flex items-start justify-between gap-6">
        <div>
          <h2 class="text-base font-semibold text-text">Feature callstacks</h2>
          <p class="mt-2 max-w-lg text-sm leading-relaxed text-text-muted">
            Trace the {props.scopeLabel}'s changed features from their entry points through runtime
            calls and side effects.
          </p>
        </div>
        <Button
          type="button"
          variant="primary"
          size="md"
          disabled={props.loading}
          onClick={props.onGenerate}
        >
          <Show when={props.loading} fallback={<>Generate</>}>
            <SpinnerIcon class="animate-spin" size={14} />
            Tracing
          </Show>
        </Button>
      </div>

      <Show when={props.loading}>
        <div class="mt-6 space-y-2" aria-live="polite">
          <div class="h-2 w-3/4 animate-pulse bg-bg-elevated" />
          <div class="h-2 w-1/2 animate-pulse bg-bg-elevated" />
          <p class="pt-2 font-mono text-xs text-text-faint">
            Inspecting changed code and connected repository paths. Large diffs can take a minute.
          </p>
        </div>
      </Show>

      <Show when={props.error}>
        {(message) => (
          <div
            class="mt-6 border border-error/50 bg-diff-remove-bg px-3 py-2 text-sm text-error"
            role="alert"
          >
            <div>{message()}</div>
            <Button
              type="button"
              variant="danger"
              size="xs"
              class="mt-2"
              onClick={props.onGenerate}
            >
              Try again
            </Button>
          </div>
        )}
      </Show>
    </div>
  </div>
);

interface ReadingDiffSummaryProps {
  result: ReadingDiffResult;
  regenerating: boolean;
  error: string | null;
  onRegenerate: () => void;
  onNavigateEvidence: (file: string, line?: number) => void;
}

type Feature = ReadingDiffResult["report"]["features"][number];
type CallstackNode = Feature["nodes"][number];

interface CallstackTreeNode {
  node: CallstackNode;
  children: CallstackTreeNode[];
}

export function buildCallstackTree(nodes: CallstackNode[]): CallstackTreeNode[] {
  const byId = new Map(
    nodes.map((node) => [node.id, { node, children: [] as CallstackTreeNode[] }]),
  );
  const roots: CallstackTreeNode[] = [];

  for (const node of nodes) {
    const treeNode = byId.get(node.id)!;
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(treeNode);
    else roots.push(treeNode);
  }

  return roots;
}

const kindLabel: Record<CallstackNode["kind"], string> = {
  entry: "entry",
  boundary: "boundary",
  service: "service",
  persistence: "persistence",
  side_effect: "side effect",
  other: "call",
};

const CallstackNodeContent: Component<{
  node: CallstackNode;
  onNavigate: (file: string, line?: number) => void;
}> = (props) => {
  const content = () => (
    <>
      <span class="min-w-0 break-words font-mono text-xs font-medium text-text">
        {props.node.label}
      </span>
      <span class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[0.6875rem] text-text-faint">
        <span>{kindLabel[props.node.kind]}</span>
        <Show when={props.node.evidence}>
          {(evidence) => (
            <span>
              {evidence().file}
              {evidence().line ? `:${evidence().line}` : ""}
            </span>
          )}
        </Show>
        <Show when={props.node.inferred}>
          <span class="text-warning">inferred</span>
        </Show>
      </span>
    </>
  );

  return (
    <Show
      when={props.node.evidence}
      fallback={
        <div
          class="inline-flex max-w-full flex-col border border-border bg-bg-elevated px-3 py-2"
          title={props.node.detail}
        >
          {content()}
        </div>
      }
    >
      {(evidence) => (
        <button
          type="button"
          class="inline-flex max-w-full flex-col border border-border bg-bg-elevated px-3 py-2 text-left hover:border-accent/60 hover:bg-accent/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          title={`${props.node.detail ? `${props.node.detail}\n` : ""}Open ${evidence().file}${evidence().line ? `:${evidence().line}` : ""} in the diff`}
          onClick={() => props.onNavigate(evidence().file, evidence().line)}
        >
          {content()}
        </button>
      )}
    </Show>
  );
};

const CallstackBranches: Component<{
  nodes: CallstackTreeNode[];
  nested?: boolean;
  onNavigate: (file: string, line?: number) => void;
}> = (props) => (
  <ul class={props.nested ? "ml-3 border-l border-border pl-5" : "space-y-3"}>
    <For each={props.nodes}>
      {(item) => (
        <li
          class={
            props.nested
              ? "relative pb-3 before:absolute before:-left-5 before:top-4 before:w-5 before:border-t before:border-border last:pb-0"
              : "pb-3 last:pb-0"
          }
        >
          <CallstackNodeContent node={item.node} onNavigate={props.onNavigate} />
          <Show when={item.children.length > 0}>
            <div class="pt-3">
              <CallstackBranches nodes={item.children} nested onNavigate={props.onNavigate} />
            </div>
          </Show>
        </li>
      )}
    </For>
  </ul>
);

const FeatureCallstack: Component<{
  feature: Feature;
  onNavigate: (file: string, line?: number) => void;
}> = (props) => {
  const roots = () => buildCallstackTree(props.feature.nodes);

  return (
    <section class="min-w-0 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <h3 class="mb-3 text-sm font-semibold text-text">{props.feature.title}</h3>
      <Show
        when={roots().length > 0}
        fallback={<p class="text-xs text-text-faint">No supported call path found.</p>}
      >
        <div class="overflow-x-auto pb-1">
          <CallstackBranches nodes={roots()} onNavigate={props.onNavigate} />
        </div>
      </Show>
    </section>
  );
};

export const ReadingDiffSummary: Component<ReadingDiffSummaryProps> = (props) => (
  <section class="mb-4 border-y border-border bg-bg-surface" aria-labelledby="feature-callstacks">
    <div class="flex items-center justify-between gap-4 border-b border-border px-3 py-3 sm:px-4">
      <h2 id="feature-callstacks" class="text-base font-semibold text-text">
        Feature callstacks
      </h2>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={props.regenerating}
        onClick={props.onRegenerate}
        title="Ignore the cached result and trace this scope again"
      >
        <Show when={props.regenerating} fallback={<>Regenerate</>}>
          <SpinnerIcon class="animate-spin" size={12} />
          Tracing
        </Show>
      </Button>
    </div>

    <Show when={props.error}>
      {(message) => (
        <div
          class="mx-3 mt-3 border border-error/50 bg-diff-remove-bg px-2.5 py-1.5 text-xs text-error sm:mx-4"
          role="alert"
        >
          Regeneration failed: {message()}
        </div>
      )}
    </Show>

    <div class="space-y-5 px-3 py-4 sm:px-4">
      <For
        each={props.result.report.features}
        fallback={
          <p class="text-sm text-text-muted">
            No feature callstack could be established from the available evidence.
          </p>
        }
      >
        {(feature) => <FeatureCallstack feature={feature} onNavigate={props.onNavigateEvidence} />}
      </For>
    </div>
  </section>
);
