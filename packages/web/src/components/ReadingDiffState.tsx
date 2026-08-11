import { For, Show, type Component } from "solid-js";

import { Badge, Button } from "../design-system";
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
          <h2 class="text-base font-semibold text-text">Reading diff</h2>
          <p class="mt-2 max-w-lg text-sm leading-relaxed text-text-muted">
            Map the {props.scopeLabel}'s runtime paths, blast radius, and review focus. The
            source-derived report is cached, and the original diff remains fully reviewable below.
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
            Analyzing
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

type Evidence = ReadingDiffResult["report"]["blastRadius"][number]["evidence"][number];
type Risk = ReadingDiffResult["report"]["blastRadius"][number]["risk"];

const riskClass = (risk: Risk) =>
  risk === "high" ? "text-error" : risk === "medium" ? "text-warning" : "text-success";

const EvidenceLinks: Component<{
  evidence: Evidence[];
  onNavigate: (file: string, line?: number) => void;
}> = (props) => (
  <Show when={props.evidence.length > 0}>
    <div class="mt-1 flex min-w-0 max-w-full flex-wrap gap-x-2 gap-y-1 font-mono text-[0.6875rem] leading-4">
      <For each={props.evidence}>
        {(evidence) => (
          <button
            type="button"
            class="block max-w-full truncate text-text-faint underline decoration-border underline-offset-2 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            title={`Open ${evidence.file}${evidence.line ? `:${evidence.line}` : ""} in the diff`}
            onClick={() => props.onNavigate(evidence.file, evidence.line)}
          >
            {evidence.file}
            {evidence.line ? `:${evidence.line}` : ""}
          </button>
        )}
      </For>
    </div>
  </Show>
);

export const ReadingDiffSummary: Component<ReadingDiffSummaryProps> = (props) => {
  const generatedAt = () => new Date(props.result.generatedAt).toLocaleString();

  return (
    <section class="mb-4 border-y border-border bg-bg-surface" aria-labelledby="reading-overview">
      <div class="grid grid-cols-2 border-b border-border md:grid-cols-4">
        <div class="border-b border-r border-border px-3 py-2 md:border-b-0">
          <div class="text-xs text-text-faint">Source head</div>
          <div class="mt-0.5 font-mono text-xs text-text">
            {props.result.sourceHeadSha === "unknown"
              ? "Unknown"
              : props.result.sourceHeadSha.slice(0, 7)}
          </div>
        </div>
        <div class="border-b border-border px-3 py-2 md:border-b-0 md:border-r">
          <div class="text-xs text-text-faint">Generated</div>
          <div class="mt-0.5 text-xs text-text" title={generatedAt()}>
            {generatedAt()}
          </div>
        </div>
        <div class="border-r border-border px-3 py-2">
          <div class="text-xs text-text-faint">Model</div>
          <div class="mt-0.5 truncate font-mono text-xs text-text" title={props.result.model}>
            {props.result.model}
          </div>
        </div>
        <div class="px-3 py-2">
          <div class="text-xs text-text-faint">Analysis</div>
          <div class="mt-0.5 flex flex-wrap items-center gap-1.5">
            <Badge variant="accent">Current</Badge>
            <Show when={props.result.cached}>
              <Badge>Cached</Badge>
            </Show>
            <span class="font-mono text-[0.6875rem] text-text-faint">
              {props.result.selectedSkills.join(", ")}
            </span>
          </div>
        </div>
      </div>

      <div class="px-3 py-4 sm:px-4">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <h2 id="reading-overview" class="text-base font-semibold text-text">
              Overview
            </h2>
            <p class="mt-2 max-w-[75ch] text-sm leading-6 text-text-muted">
              {props.result.report.overview}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={props.regenerating}
            onClick={props.onRegenerate}
            title="Ignore the cached result and analyze this scope again"
          >
            <Show when={props.regenerating} fallback={<>Regenerate</>}>
              <SpinnerIcon class="animate-spin" size={12} />
              Analyzing
            </Show>
          </Button>
        </div>

        <Show when={props.error}>
          {(message) => (
            <div
              class="mt-3 border border-error/50 bg-diff-remove-bg px-2.5 py-1.5 text-xs text-error"
              role="alert"
            >
              Regeneration failed: {message()}
            </div>
          )}
        </Show>

        <div class="mt-5 border-t border-border pt-4">
          <h3 class="text-sm font-semibold text-text">Program design</h3>
          <Show
            when={props.result.report.flows.length > 0}
            fallback={
              <p class="mt-2 text-sm text-text-muted">
                No runtime flow could be established from the available evidence.
              </p>
            }
          >
            <div class="mt-3 space-y-5 font-mono text-xs leading-5">
              <For each={props.result.report.flows}>
                {(flow) => (
                  <div>
                    <h4 class="font-semibold text-text">{flow.title}</h4>
                    <ol class="mt-1">
                      <For each={flow.steps}>
                        {(step) => (
                          <li class="grid grid-cols-[1rem_minmax(0,1fr)] gap-1.5">
                            <span class="select-none text-text-faint" aria-hidden="true">
                              →
                            </span>
                            <div class="min-w-0">
                              <Show
                                when={step.evidence}
                                fallback={
                                  <span class="break-words text-text-muted">{step.label}</span>
                                }
                              >
                                {(evidence) => (
                                  <button
                                    type="button"
                                    class="break-words text-left text-text-muted underline decoration-transparent underline-offset-2 hover:text-accent hover:decoration-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                                    title={`${step.detail ? `${step.detail}\n` : ""}Open ${evidence().file}${evidence().line ? `:${evidence().line}` : ""} in the diff`}
                                    onClick={() =>
                                      props.onNavigateEvidence(evidence().file, evidence().line)
                                    }
                                  >
                                    {step.label}
                                  </button>
                                )}
                              </Show>
                              <Show when={step.inferred}>
                                <span class="ml-2 text-warning">(inferred)</span>
                              </Show>
                            </div>
                          </li>
                        )}
                      </For>
                    </ol>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>

        <div class="mt-5 grid min-w-0 border-t border-border pt-4 xl:grid-cols-3 xl:divide-x xl:divide-border">
          <div class="min-w-0 pb-4 xl:pr-4">
            <h3 class="text-sm font-semibold text-text">Blast radius</h3>
            <div class="mt-2 divide-y divide-border">
              <For
                each={props.result.report.blastRadius}
                fallback={
                  <p class="py-2 text-xs text-text-faint">No affected consumers identified.</p>
                }
              >
                {(impact) => (
                  <div class="py-2 first:pt-0">
                    <div class="flex gap-2 text-xs leading-5">
                      <span class={`w-12 shrink-0 font-mono ${riskClass(impact.risk)}`}>
                        {impact.risk}
                      </span>
                      <div class="min-w-0">
                        <div class="font-medium text-text">{impact.area}</div>
                        <p class="text-text-muted">{impact.impact}</p>
                        <EvidenceLinks
                          evidence={impact.evidence}
                          onNavigate={props.onNavigateEvidence}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>

          <div class="min-w-0 border-t border-border py-4 xl:border-t-0 xl:px-4 xl:py-0">
            <h3 class="text-sm font-semibold text-text">Review focus</h3>
            <div class="mt-2 divide-y divide-border">
              <For
                each={props.result.report.reviewFocus}
                fallback={<p class="py-2 text-xs text-text-faint">No focused checks identified.</p>}
              >
                {(focus) => (
                  <div class="py-2 first:pt-0">
                    <div class="flex gap-2 text-xs leading-5">
                      <span class={`w-12 shrink-0 font-mono ${riskClass(focus.severity)}`}>
                        {focus.severity}
                      </span>
                      <div class="min-w-0">
                        <div class="font-medium text-text">{focus.title}</div>
                        <p class="text-text-muted">{focus.rationale}</p>
                        <EvidenceLinks
                          evidence={focus.evidence}
                          onNavigate={props.onNavigateEvidence}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>

          <div class="min-w-0 border-t border-border pt-4 xl:border-t-0 xl:pl-4 xl:pt-0">
            <h3 class="text-sm font-semibold text-text">Unknowns</h3>
            <ul class="mt-2 space-y-2 text-xs leading-5 text-text-muted">
              <For
                each={props.result.report.unknowns}
                fallback={<li class="text-text-faint">No unresolved questions reported.</li>}
              >
                {(unknown) => (
                  <li class="flex min-w-0 gap-2">
                    <span class="font-mono text-warning" aria-hidden="true">
                      ?
                    </span>
                    <span class="min-w-0 break-words">{unknown}</span>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
};
