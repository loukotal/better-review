import { createMemo, Show } from "solid-js";
import { Portal } from "solid-js/web";

import type { SelectionChatController, SourceSelection } from "../lib/ask-ai-selection";
import type { SelectionBubbleAnchor } from "../lib/selection-bubble";
import { AskSelectionComposer, createSelectionQuestionState } from "./AskSelectionComposer";
import { SelectionBubble } from "./SelectionBubble";

export interface SelectionEditorDraft {
  selection: SourceSelection;
  anchor: SelectionBubbleAnchor;
  state: ReturnType<typeof createSelectionQuestionState>;
}

export function AnchoredSelectionEditor(props: {
  draft: SelectionEditorDraft;
  controller: SelectionChatController | null;
  scope: string;
  sourceDialogOpen: boolean;
  isCurrent: () => boolean;
  onDismiss: () => void;
}) {
  // Keep the popover in a source modal's focus subtree. Closing that modal moves
  // it to the page; the App-owned question/target/error state survives relocation.
  const mount = createMemo(() =>
    props.sourceDialogOpen && props.draft.anchor.container?.isConnected
      ? props.draft.anchor.container
      : document.body,
  );
  return (
    <Show when={mount()} keyed>
      {(container) => (
        <Portal mount={container}>
          <SelectionBubble
            anchor={props.draft.anchor}
            retained
            expanded={!props.draft.state.collapsed()}
            label="Resume question"
            onAsk={() => props.draft.state.setCollapsed(false)}
            onClose={() => props.draft.state.setCollapsed(true)}
            onHide={() => {}}
            onDismiss={props.onDismiss}
          >
            <Show when={!props.draft.state.collapsed()}>
              <AskSelectionComposer
                selection={props.draft.selection}
                state={props.draft.state}
                stale={props.draft.selection.scope !== props.scope}
                currentSessionId={props.controller?.currentSessionId() ?? null}
                currentBusy={props.controller?.currentBusy() ?? false}
                sessions={props.controller?.sessions() ?? []}
                disabled={!props.controller || props.controller.disabled()}
                onDismiss={props.onDismiss}
                onSend={async (body, target) => {
                  const result = await props.controller?.send(
                    props.draft.selection,
                    body,
                    target,
                    props.isCurrent,
                  );
                  if (result && props.isCurrent()) props.onDismiss();
                  return !!result;
                }}
              />
            </Show>
          </SelectionBubble>
        </Portal>
      )}
    </Show>
  );
}
