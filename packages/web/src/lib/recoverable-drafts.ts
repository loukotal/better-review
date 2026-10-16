import { createEffect, createSignal, on, type Accessor } from "solid-js";

const PREFIX = "better-review-unsent-draft-v1:";
/** Read-only migration recovery. Legacy text cannot prove it was never admitted. */
export function legacyGithubDraftRecovery(url: string): Array<{ key: string; body: string }> {
  try {
    return Object.keys(localStorage)
      .filter(
        (key) =>
          key.startsWith(PREFIX) &&
          key.toLowerCase().includes(url.toLowerCase()) &&
          !key.endsWith(":edit-expected-body"),
      )
      .flatMap((key) => {
        const body = localStorage.getItem(key);
        return body ? [{ key, body }] : [];
      });
  } catch {
    return [];
  }
}
/** Unsent editor content is separate from query caches and admitted commands. */
export function createRecoverableDraft(key: Accessor<string | undefined>, initial = "") {
  const [body, setBody] = createSignal(initial);
  const [storageError, setStorageError] = createSignal<string>();
  let activeKey: string | undefined;
  const load = (next: string | undefined) => {
    activeKey = next;
    try {
      setBody(next ? (localStorage.getItem(PREFIX + next) ?? initial) : initial);
    } catch {
      setStorageError(
        "Draft recovery storage is unavailable. Keep this editor open until saved locally.",
      );
    }
  };
  load(key());
  createEffect(
    on(key, (next) => {
      if (next !== activeKey) load(next);
    }),
  );
  const update = (value: string) => {
    setBody(value);
    if (!activeKey) return;
    try {
      if (value) localStorage.setItem(PREFIX + activeKey, value);
      else localStorage.removeItem(PREFIX + activeKey);
      setStorageError(undefined);
    } catch {
      setStorageError(
        "Draft recovery storage failed. Keep this editor open; this text is not saved yet.",
      );
    }
  };
  return { body, setBody: update, storageError };
}
