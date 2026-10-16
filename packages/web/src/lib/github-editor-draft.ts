import { createEffect, createSignal, on, type Accessor } from "solid-js";

import { githubEditorService } from "./github-editor-service";
import type { GithubDraft } from "./github-outbox-journal";

/** Slot identity is reusable; the journal's UUID intent is not. No localStorage cleanup is involved. */
export function createGithubEditorDraft(options: {
  slot: Accessor<string | undefined>;
  url: Accessor<string | null | undefined>;
  initial?: Accessor<{ body: string; context?: Record<string, string> }>;
  lazy?: boolean;
}) {
  const [body, setBodyValue] = createSignal("");
  const [context, setContext] = createSignal<Record<string, string>>({});
  const [ready, setReady] = createSignal(false);
  const [error, setError] = createSignal<string>();
  let draft: GithubDraft | undefined;
  let generation = 0;
  let submitted = false;
  let writes: Promise<void> = Promise.resolve();
  let writeFailure: unknown;
  const open = async (initial?: { body: string; context?: Record<string, string> }) => {
    const slot = options.slot(),
      url = options.url(),
      token = ++generation;
    setReady(false);
    setError(undefined);
    if (!slot || !url) return;
    try {
      await writes;
      if (writeFailure && draft && !submitted && draft.editorSlot === slot) {
        setReady(true);
        setError("This draft has not been persisted. Keep the editor open and retry saving.");
        return;
      }
      const service = githubEditorService();
      const loaded = await service.journal.openEditor(slot, service.scope(url), initial);
      if (token !== generation) return;
      draft = loaded;
      submitted = false;
      writeFailure = undefined;
      setBodyValue(loaded.body);
      setContext(loaded.context ?? {});
      setReady(true);
    } catch {
      if (token === generation)
        setError(
          "Could not open durable draft storage. Keep this editor open; nothing has been queued.",
        );
    }
  };
  createEffect(
    on(
      () => `${options.url() ?? ""}|${options.slot() ?? ""}`,
      () => {
        generation++;
        draft = undefined;
        submitted = false;
        setBodyValue("");
        setContext({});
        setReady(false);
        void open();
      },
      { defer: true },
    ),
  );
  // Cached diff form state is also constructed by a non-Solid annotation renderer.
  // Initial hydration must not depend on an effect being scheduled by an owner.
  void open(options.lazy ? undefined : options.initial?.());
  const setBody = (value: string) => {
    // A caller clearing its editor after admission cannot write into the rotated intent.
    if (submitted) {
      if (!value) setBodyValue("");
      return;
    }
    setBodyValue(value);
    const captured = draft;
    if (!captured || !ready()) {
      setError("Draft storage is not ready. Keep this editor open; nothing has been queued.");
      return;
    }
    writes = writes
      .then(() => githubEditorService().journal.saveEditor(captured.key, value))
      .catch((cause) => {
        writeFailure = cause;
        setError(
          "Could not persist this draft. Keep the editor open and retry saving; nothing has been queued.",
        );
      });
  };
  const submit = async <T>(
    save: (body: string, draftKey: string, context: Record<string, string>) => Promise<T>,
  ): Promise<T> => {
    if (!draft || !ready())
      throw new Error(
        error() ?? "Durable draft storage is not ready. Your editor has not been submitted.",
      );
    const captured = draft,
      text = body(),
      metadata = context();
    await writes;
    if (writeFailure) {
      // Retry the latest text explicitly; never submit a stale persisted body.
      await githubEditorService().journal.saveEditor(captured.key, text);
      writeFailure = undefined;
      setError(undefined);
    }
    const result = await save(text, captured.key, metadata);
    submitted = true;
    setBodyValue("");
    setReady(false);
    // Admission already rotated the slot atomically. Failure to load its empty successor
    // must not turn durable success into a submission error or invite a duplicate intent.
    void open(options.lazy ? undefined : options.initial?.());
    return result;
  };
  return { body, setBody, context, ready, error, open, submit };
}
