import { createMemo, createSignal, For, Show } from "solid-js";

import { Button } from "../design-system";
import { FileIcon } from "../icons/file-icon";
import {
  parseSelectionQuestionMessage,
  SELECTION_PREVIEW_LINES,
  selectionExcerpt,
  selectionRevisionLabel,
  type SelectionSourceContext,
} from "../lib/selection-question-message";

export interface SelectionQuestionMessageProps {
  /** Original model prompt, including the source-context envelope. Never rewrite storage/transport. */
  content: string;
  /** Navigate to this exact source version; this must not open the comment composer. */
  onNavigate: (selection: SelectionSourceContext) => void;
}

/** Safe for all user messages: only exact generated selection prompts get the compact treatment. */
export function SelectionQuestionMessage(props: SelectionQuestionMessageProps) {
  const parsed = createMemo(() => parseSelectionQuestionMessage(props.content));
  return (
    <Show
      when={parsed()}
      keyed
      fallback={<p class="whitespace-pre-wrap wrap-break-word leading-relaxed">{props.content}</p>}
    >
      {(message) => {
        const [expanded, setExpanded] = createSignal(false);
        const excerpt = createMemo(() => selectionExcerpt(message.selection, expanded()));
        const selection = message.selection;
        const range =
          selection.startLine === selection.endLine
            ? `${selection.startLine}`
            : `${selection.startLine}–${selection.endLine}`;
        const reference = `${selection.file}:${range}`;
        return (
          <div class="min-w-0 space-y-2" aria-label="Question about selected code">
            <p class="whitespace-pre-wrap wrap-break-word leading-relaxed">{message.question}</p>
            <div class="min-w-0 overflow-hidden border border-border bg-bg">
              <div class="min-w-0 border-b border-border px-2 py-1.5">
                <button
                  type="button"
                  class="flex max-w-full min-w-0 items-center gap-1 font-mono text-xs font-medium text-accent hover:underline focus-visible:outline focus-visible:outline-accent"
                  title={reference}
                  aria-label={`Open ${reference} at ${selection.revision}${selection.side === "LEFT" ? " (previous version)" : ""}`}
                  onClick={() => props.onNavigate(selection)}
                >
                  <FileIcon size={12} class="shrink-0 opacity-60" />
                  <span class="min-w-0 truncate">{selection.file.split("/").pop()}</span>
                  <span class="shrink-0">:{range}</span>
                </button>
                <div class="mt-0.5 truncate text-[11px] text-text-faint" title={selection.revision}>
                  {selectionRevisionLabel(selection)}
                </div>
              </div>
              {/* Deliberately styled plain code, not Markdown/innerHTML: source is untrusted. */}
              <pre
                class="max-h-80 max-w-full overflow-auto py-2 font-mono text-xs leading-5 text-text"
                tabIndex={0}
                aria-label={expanded() ? "Full selected code" : "Selected code preview"}
              >
                <code>
                  <For each={excerpt().lines}>
                    {(line, index) => (
                      <span class="flex min-w-max px-2">
                        <span
                          class="mr-3 inline-block min-w-6 shrink-0 select-none text-right text-text-faint"
                          aria-hidden="true"
                        >
                          {line.number}
                        </span>
                        <span class="whitespace-pre">
                          {line.text}
                          {index() < excerpt().lines.length - 1 ? "\n" : ""}
                        </span>
                      </span>
                    )}
                  </For>
                </code>
              </pre>
              <Show when={excerpt().totalLines > SELECTION_PREVIEW_LINES}>
                <div class="border-t border-border px-1 py-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-expanded={expanded()}
                    onClick={() => setExpanded(!expanded())}
                  >
                    {expanded() ? "Collapse code" : `Show ${excerpt().hiddenLines} more lines`}
                  </Button>
                </div>
              </Show>
            </div>
          </div>
        );
      }}
    </Show>
  );
}
