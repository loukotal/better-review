import { For, onMount, Show } from "solid-js";

import type { StoredSession } from "@better-review/shared";

import { Button, Field, MessageForm, Textarea } from "../design-system";
import { formatSelectionQuestion, type SourceSelection } from "../lib/ask-ai-selection";
import { createSelectionQuestionState } from "../lib/interaction-drafts";
import { selectionRevisionLabel } from "../lib/selection-question-message";
export { createSelectionQuestionState } from "../lib/interaction-drafts";

/** App-owned so portal relocation (e.g. closing historical source) cannot erase a draft. */

export function AskSelectionComposer(props: {
  selection: SourceSelection;
  stale: boolean;
  currentSessionId: string | null;
  currentBusy: boolean;
  disabled: boolean;
  sessions: StoredSession[];
  onSend: (body: string, target: string) => Promise<boolean>;
  onDismiss: () => void;
  state?: ReturnType<typeof createSelectionQuestionState>;
}) {
  const { question, setQuestion, target, setTarget, sending, setSending, error, setError } =
    props.state ?? createSelectionQuestionState();
  let textarea: HTMLTextAreaElement | undefined;
  onMount(() => textarea?.focus({ preventScroll: true }));
  const busy = () =>
    (target() === "current" || target() === props.currentSessionId) && props.currentBusy;
  const unavailable = () => target() === "current" && !props.currentSessionId;
  // An explicitly chosen session must stay selectable even when it becomes current.
  const savedSessions = () =>
    props.sessions.filter(
      (session) => session.id !== props.currentSessionId || session.id === target(),
    );
  async function send(event: SubmitEvent) {
    event.preventDefault();
    if (sending() || props.disabled || props.stale || busy()) return;
    const destination = target() === "current" ? props.currentSessionId : target();
    if (!destination) {
      setError("Wait for the current conversation or choose a new one.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const success = await props.onSend(
        formatSelectionQuestion(props.selection, question()),
        destination,
      );
      if (!success) setError("Could not send. Your selection and question are preserved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send selection.");
    } finally {
      setSending(false);
    }
  }
  return (
    <MessageForm
      onSubmit={send}
      aria-label="Ask about selection"
      class="min-w-0 space-y-3 p-3 text-xs"
    >
      <div class="flex items-center justify-between gap-2">
        <h3 class="min-w-0 font-semibold text-sm">Ask about selection</h3>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={sending()}
          onClick={props.onDismiss}
        >
          Dismiss
        </Button>
      </div>
      <p class="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-text-muted">
        <span class="min-w-0 truncate font-mono" title={props.selection.file}>
          {props.selection.file.split("/").pop()}
        </span>
        <span class="shrink-0">
          {props.selection.startLine === props.selection.endLine
            ? `Line ${props.selection.startLine}`
            : `Lines ${props.selection.startLine}–${props.selection.endLine}`}
        </span>
      </p>
      <Field label="Question">
        {(id) => (
          <Textarea
            id={id}
            ref={(element) => {
              textarea = element;
            }}
            rows={2}
            class="w-full min-w-0"
            placeholder="What would you like to understand?"
            value={question()}
            disabled={sending()}
            onInput={(e) => setQuestion(e.currentTarget.value)}
            aria-label="Question about selection"
          />
        )}
      </Field>
      <details class="text-text-muted">
        <summary class="cursor-pointer">Selected code</summary>
        <p class="mt-2 break-all" title={props.selection.revision}>
          {selectionRevisionLabel(props.selection)}
        </p>
        <pre class="mt-1 max-h-28 overflow-auto whitespace-pre-wrap rounded border border-border p-2">
          {props.selection.text}
        </pre>
      </details>
      <Field label="Conversation">
        {(id) => (
          <select
            id={id}
            aria-label="Selection conversation"
            class="w-full min-w-0 rounded border border-border bg-bg px-2 py-1.5 text-xs text-text focus-visible:outline focus-visible:outline-accent"
            value={target()}
            disabled={sending()}
            onChange={(e) => setTarget(e.currentTarget.value)}
          >
            <option value="current" disabled={!props.currentSessionId}>
              {props.currentSessionId
                ? `Current conversation${props.currentBusy ? " (busy)" : ""}`
                : "Current conversation unavailable"}
            </option>
            <option value="new">New conversation</option>
            <For each={savedSessions()}>
              {(session) => (
                <option value={session.id}>
                  {session.id === props.currentSessionId ? "Current · " : ""}
                  {new Date(session.createdAt).toLocaleString()} · {session.headSha?.slice(0, 7)} ·{" "}
                  {session.id.slice(0, 8)}
                </option>
              )}
            </For>
          </select>
        )}
      </Field>
      <Show when={unavailable()}>
        <p role="status" class="text-text-muted">
          Choose a saved or new conversation to send.
        </p>
      </Show>
      <Show when={props.stale}>
        <p role="alert">PR or revision changed. Dismiss this draft and select source again.</p>
      </Show>
      <Show when={busy()}>
        <p role="status">Conversation is busy. Wait or choose another; your draft is preserved.</p>
      </Show>
      <Show when={error()}>
        <p role="alert" class="text-error">
          {error()}
        </p>
      </Show>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="submit"
          variant="primary"
          size="xs"
          disabled={
            sending() ||
            props.disabled ||
            props.stale ||
            busy() ||
            unavailable() ||
            !question().trim()
          }
        >
          {sending() ? "Sending…" : "Send question"}
        </Button>
        <span class="text-[11px] text-text-faint">⌘ / Ctrl + Enter</span>
      </div>
    </MessageForm>
  );
}
