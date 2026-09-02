import { For, Show, createSignal, type Component } from "solid-js";

import { Button } from "../design-system";
import { ChevronDownIcon } from "../icons/chevron-down-icon";
import { ChevronRightIcon } from "../icons/chevron-right-icon";
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

const kindTone: Record<CallstackNode["kind"], string> = {
  entry: "bg-accent text-accent",
  boundary: "bg-warning text-warning",
  service: "bg-info text-info",
  persistence: "bg-success text-success",
  side_effect: "bg-error text-error",
  other: "bg-text-faint text-text-faint",
};

function compactEvidencePath(path: string): string {
  const parts = path.split("/");
  return parts.at(-1) || path;
}

function countDescendants(item: CallstackTreeNode): number {
  return item.children.reduce((count, child) => count + 1 + countDescendants(child), 0);
}

const CallstackNodeBody: Component<{ node: CallstackNode }> = (props) => (
  <>
    <span class="min-w-0 [overflow-wrap:anywhere] font-mono text-xs font-medium leading-5 text-text">
      {props.node.label}
    </span>
    <span class="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.6875rem] leading-4 text-text-faint">
      <span class="inline-flex items-center gap-1.5">
        <span class={`size-1.5 rounded-full ${kindTone[props.node.kind]}`} aria-hidden="true" />
        {kindLabel[props.node.kind]}
      </span>
      <Show when={props.node.evidence}>
        {(evidence) => (
          <span class="min-w-0 truncate font-mono" title={evidence().file}>
            {compactEvidencePath(evidence().file)}
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

const CallstackBranch: Component<{
  item: CallstackTreeNode;
  depth: number;
  onNavigate: (file: string, line?: number) => void;
}> = (props) => {
  const hasChildren = () => props.item.children.length > 0;
  const [expanded, setExpanded] = createSignal(props.depth < 2);
  const node = () => props.item.node;
  const locationTitle = () => {
    const evidence = node().evidence;
    if (!evidence) return node().detail;
    return `${node().detail ? `${node().detail}\n` : ""}Open ${evidence.file}${evidence.line ? `:${evidence.line}` : ""} in the diff`;
  };

  return (
    <li class="relative min-w-0 py-0.5">
      <div class="grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)] items-start">
        <Show
          when={hasChildren()}
          fallback={<span class="mt-2.5 ml-2 size-1 rounded-full bg-border" aria-hidden="true" />}
        >
          <button
            type="button"
            class="mt-1 inline-flex size-6 items-center justify-center text-text-faint hover:bg-bg-elevated hover:text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            aria-label={`${expanded() ? "Collapse" : "Expand"} ${node().label}`}
            aria-expanded={expanded()}
            onClick={() => setExpanded((value) => !value)}
          >
            <Show when={expanded()} fallback={<ChevronRightIcon size={13} />}>
              <ChevronDownIcon size={13} />
            </Show>
          </button>
        </Show>

        <Show
          when={node().evidence}
          fallback={
            <div class="min-w-0 px-2 py-1.5" title={locationTitle()}>
              <CallstackNodeBody node={node()} />
            </div>
          }
        >
          {(evidence) => (
            <button
              type="button"
              class="min-w-0 px-2 py-1.5 text-left hover:bg-bg-elevated focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              title={locationTitle()}
              onClick={() => props.onNavigate(evidence().file, evidence().line)}
            >
              <CallstackNodeBody node={node()} />
            </button>
          )}
        </Show>
      </div>

      <Show when={hasChildren() && expanded()}>
        <ul class="ml-3 border-l border-border pl-3">
          <For each={props.item.children}>
            {(child) => (
              <CallstackBranch item={child} depth={props.depth + 1} onNavigate={props.onNavigate} />
            )}
          </For>
        </ul>
      </Show>
      <Show when={hasChildren() && !expanded()}>
        <button
          type="button"
          class="ml-6 px-2 py-1 text-left text-[0.6875rem] text-text-faint hover:text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          onClick={() => setExpanded(true)}
        >
          {countDescendants(props.item)} hidden{" "}
          {countDescendants(props.item) === 1 ? "call" : "calls"}
        </button>
      </Show>
    </li>
  );
};

const FeatureCallstack: Component<{
  feature: Feature;
  onNavigate: (file: string, line?: number) => void;
}> = (props) => {
  const roots = () => buildCallstackTree(props.feature.nodes);

  return (
    <section class="min-w-0 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <h3 class="mb-2 text-sm font-semibold text-text text-balance">{props.feature.title}</h3>
      <Show
        when={roots().length > 0}
        fallback={<p class="text-xs text-text-faint">No supported call path found.</p>}
      >
        <ul class="min-w-0 space-y-1" aria-label={props.feature.title}>
          <For each={roots()}>
            {(root) => <CallstackBranch item={root} depth={0} onNavigate={props.onNavigate} />}
          </For>
        </ul>
      </Show>
    </section>
  );
};

export const ReadingDiffSummary: Component<ReadingDiffSummaryProps> = (props) => (
  <section class="mb-4 border-y border-border bg-bg-surface" aria-labelledby="feature-callstacks">
    <div class="flex items-start justify-between gap-4 border-b border-border px-3 py-3 sm:px-4">
      <div class="min-w-0">
        <h2 id="feature-callstacks" class="text-base font-semibold text-text">
          Feature callstacks
        </h2>
        <p class="mt-1 max-w-3xl text-sm leading-5 text-text-muted text-pretty">
          {props.result.summary}
        </p>
      </div>
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
