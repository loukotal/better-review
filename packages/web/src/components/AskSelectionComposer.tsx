import { createSignal, For, onMount, Show } from "solid-js";

import type { StoredSession } from "@better-review/shared";

import { Button, MessageForm, Textarea } from "../design-system";
import { formatSelectionQuestion, type SourceSelection } from "../lib/ask-ai-selection";

/** App-owned so portal relocation (e.g. closing historical source) cannot erase a draft. */
export function createSelectionQuestionState() {
  const [question, setQuestion] = createSignal("");
  const [target, setTarget] = createSignal("current");
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [collapsed, setCollapsed] = createSignal(false);
  return {
    question,
    setQuestion,
    target,
    setTarget,
    sending,
    setSending,
    error,
    setError,
    collapsed,
    setCollapsed,
  };
}

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
    <MessageForm onSubmit={send} aria-label="Ask about selection" class="space-y-2 p-3 text-xs">
      <div class="flex items-center justify-between gap-2">
        <h3 class="font-semibold text-sm">Ask about selection</h3>
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
      <p class="flex min-w-0 gap-2 text-text-muted">
        <span class="truncate" title={props.selection.file}>
          {props.selection.file}
        </span>
        <span class="shrink-0">
          Lines {props.selection.startLine}–{props.selection.endLine}
        </span>
      </p>
      <label class="block">
        Question
        <Textarea
          ref={(element) => {
            textarea = element;
          }}
          rows={2}
          class="w-full"
          value={question()}
          disabled={sending()}
          onInput={(e) => setQuestion(e.currentTarget.value)}
          aria-label="Question about selection"
        />
      </label>
      <details class="text-text-muted">
        <summary class="cursor-pointer">Selected code</summary>
        <p class="mt-1 break-all">Source: {props.selection.revision}</p>
        <pre class="mt-1 max-h-28 overflow-auto whitespace-pre-wrap rounded border border-border p-2">
          {props.selection.text}
        </pre>
      </details>
      <label class="block">
        Conversation
        <select
          aria-label="Selection conversation"
          class="mt-1 w-full rounded border border-border bg-bg p-1 text-text"
          value={target()}
          disabled={sending()}
          onChange={(e) => setTarget(e.currentTarget.value)}
        >
          <option value="current">Current conversation{props.currentBusy ? " (busy)" : ""}</option>
          <option value="new">New conversation</option>
          <For each={props.sessions}>
            {(session) => (
              <option value={session.id}>
                {session.id === props.currentSessionId ? "Current · " : ""}
                {new Date(session.createdAt).toLocaleString()} · {session.headSha?.slice(0, 7)} ·{" "}
                {session.id.slice(0, 8)}
              </option>
            )}
          </For>
        </select>
      </label>
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
      <Button
        type="submit"
        variant="primary"
        size="xs"
        disabled={sending() || props.disabled || props.stale || busy() || !question().trim()}
      >
        {sending() ? "Sending…" : "Send question"}
      </Button>
    </MessageForm>
  );
}
