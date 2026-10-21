import { createSignal, Show } from "solid-js";

import { Button, MessageForm, Textarea } from "../design-system";
import { createGithubEditorDraft } from "../lib/github-editor-draft";
import { queueGithubWrite } from "../lib/github-writes";

export function PrReviewActions(props: { url: string; headSha?: string; canSubmit: boolean }) {
  const [kind, setKind] = createSignal<"request-changes" | "review-comment">("review-comment");
  const [open, setOpen] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const commentDraft = createGithubEditorDraft({
    slot: () => `${props.url}:review-comment`,
    url: () => props.url,
    lazy: true,
  });
  const changesDraft = createGithubEditorDraft({
    slot: () => `${props.url}:request-changes`,
    url: () => props.url,
    lazy: true,
  });
  const draft = () => (kind() === "request-changes" ? changesDraft : commentDraft);
  const start = (value: ReturnType<typeof kind>) => {
    setKind(value);
    setError(undefined);
    void draft().open({
      body: "",
      context: props.headSha ? { expectedHeadSha: props.headSha } : {},
    });
    setOpen(true);
  };
  const submit = async () => {
    if (saving() || !props.canSubmit || !draft().body().trim()) return;
    setSaving(true);
    setError(undefined);
    const actionKind = kind();
    const url = props.url;
    try {
      await draft().submit((body, key, context) => {
        if (!context.expectedHeadSha) throw new Error("No verified PR head. Reopen this editor.");
        return queueGithubWrite(
          url,
          { kind: actionKind, body: body.trim(), expectedHeadSha: context.expectedHeadSha },
          key,
        );
      });
      if (props.url === url) setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save review. Draft retained.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div class="space-y-3">
      <div class="flex gap-2">
        <Button
          size="sm"
          disabled={!props.canSubmit || !props.headSha}
          onClick={() => start("request-changes")}
        >
          Request changes
        </Button>
        <Button
          size="sm"
          disabled={!props.canSubmit || !props.headSha}
          onClick={() => start("review-comment")}
        >
          Comment review
        </Button>
      </div>
      <Show when={open()}>
        <MessageForm
          class="space-y-2"
          aria-label={kind() === "request-changes" ? "Request changes review" : "Comment review"}
          onSubmit={submit}
        >
          <p class="text-xs text-text-muted">
            Reviewing head {draft().context().expectedHeadSha?.slice(0, 7) ?? "unavailable"}. Saved
            reviews wait in the GitHub outbox.
          </p>
          <Textarea
            aria-label="Review body"
            value={draft().body()}
            onInput={(event) => draft().setBody(event.currentTarget.value)}
            disabled={!draft().ready() || saving()}
          />
          <Show when={error() || draft().error()}>
            <p role="alert">{error() || draft().error()}</p>
          </Show>
          <Button type="button" size="sm" onClick={() => setOpen(false)}>
            Close
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={
              saving() ||
              !draft().ready() ||
              !draft().body().trim() ||
              !props.canSubmit ||
              !draft().context().expectedHeadSha
            }
          >
            {saving() ? "Saving locally…" : "Submit review"}
          </Button>
        </MessageForm>
      </Show>
    </div>
  );
}
