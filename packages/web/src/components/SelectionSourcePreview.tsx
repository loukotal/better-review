import { For } from "solid-js";

import { Dialog } from "../design-system";
import type { SelectionSourceContext } from "../lib/selection-question-message";

/** Exact persisted source snapshot when a link cannot safely target the visible revision/side. */
export function SelectionSourcePreview(props: {
  selection: SelectionSourceContext;
  onClose: () => void;
  reason?: string;
}) {
  return (
    <Dialog
      open
      onClose={props.onClose}
      title={`${props.selection.file} · ${props.selection.side === "LEFT" ? "Previous version" : "Selected version"}`}
      wide
    >
      <p class="mb-2 break-all text-xs text-text-muted">
        Captured source at {props.selection.revision}. Lines {props.selection.startLine}–
        {props.selection.endLine}; read-only, not a PR comment.
      </p>
      {props.reason && (
        <p role="status" class="mb-2 text-xs text-warning">
          {props.reason}
        </p>
      )}
      <div
        data-selection-source-side={props.selection.side}
        data-selection-source-ref={props.selection.revision}
        class="max-h-[65dvh] overflow-auto rounded border border-border bg-bg font-mono text-xs"
      >
        <For each={props.selection.text.split("\n")}>
          {(text, index) => (
            <div
              data-source-line={props.selection.startLine + index()}
              class="flex whitespace-pre px-3 leading-6"
            >
              <span class="mr-4 w-12 shrink-0 select-none text-right text-text-faint">
                {props.selection.startLine + index()}
              </span>
              <code>{text}</code>
            </div>
          )}
        </For>
      </div>
    </Dialog>
  );
}
