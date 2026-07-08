import { createSignal, onCleanup, onMount, Show } from "solid-js";

type StopFindAction = "clearSelection" | "keepSelection" | "activateSelection";

interface DesktopFindOptions {
  forward?: boolean;
  findNext?: boolean;
  matchCase?: boolean;
}

interface DesktopFindResult {
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}

interface DesktopFindApi {
  findInPage(text: string, options?: DesktopFindOptions): Promise<number>;
  stopFindInPage(action?: StopFindAction): Promise<void>;
  onFoundInPage(callback: (result: DesktopFindResult) => void): () => void;
}

declare global {
  interface Window {
    betterReviewDesktopFind?: DesktopFindApi;
  }
}

export function DesktopFindBar() {
  const [visible, setVisible] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [activeMatch, setActiveMatch] = createSignal(0);
  const [matchCount, setMatchCount] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;
  let shouldRestoreInputFocus = false;

  const api = () => window.betterReviewDesktopFind;

  const focusInput = () => {
    queueMicrotask(() => {
      inputRef?.focus({ preventScroll: true });
      inputRef?.select();
    });
  };

  const restoreInputFocus = () => {
    if (!shouldRestoreInputFocus || !visible()) return;

    requestAnimationFrame(() => {
      if (!shouldRestoreInputFocus || !visible() || document.activeElement === inputRef) return;
      inputRef?.focus({ preventScroll: true });
    });
  };

  const open = () => {
    if (!api()) return;
    setVisible(true);
    focusInput();
  };

  const close = () => {
    setVisible(false);
    shouldRestoreInputFocus = false;
    setActiveMatch(0);
    setMatchCount(0);
    void api()?.stopFindInPage("clearSelection");
  };

  const find = (text = query(), options: DesktopFindOptions = {}) => {
    const findApi = api();
    if (!findApi) return;

    shouldRestoreInputFocus = document.activeElement === inputRef;

    if (!text) {
      setActiveMatch(0);
      setMatchCount(0);
      void findApi.stopFindInPage("clearSelection").finally(restoreInputFocus);
      return;
    }

    void findApi
      .findInPage(text, {
        forward: true,
        findNext: false,
        ...options,
      })
      .finally(restoreInputFocus);
  };

  const findNext = (forward: boolean) => {
    if (!query()) return;
    find(query(), { forward, findNext: true });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const isFindShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f";
    if (isFindShortcut && api()) {
      event.preventDefault();
      open();
      return;
    }

    if (!visible()) return;

    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  onMount(() => {
    document.addEventListener("keydown", onKeyDown, true);
    const removeFindListener = api()?.onFoundInPage((result) => {
      if (!visible()) return;
      setActiveMatch(result.activeMatchOrdinal);
      setMatchCount(result.matches);
      restoreInputFocus();
    });

    onCleanup(() => {
      document.removeEventListener("keydown", onKeyDown, true);
      removeFindListener?.();
    });
  });

  return (
    <Show when={api() && visible()}>
      <div class="fixed right-3 top-3 z-[1000] flex items-center gap-1 border border-border bg-bg-surface px-2 py-1.5 shadow-lg [-webkit-app-region:no-drag]">
        <input
          ref={(element) => {
            inputRef = element;
          }}
          value={query()}
          onInput={(event) => {
            const value = event.currentTarget.value;
            setQuery(value);
            find(value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              findNext(!event.shiftKey);
            }
          }}
          class="w-56 border border-border bg-bg px-2 py-1 text-sm text-text"
          placeholder="Find on page"
        />
        <span class="min-w-14 text-center text-xs text-text-faint">
          <Show when={query()} fallback="">
            {matchCount() === 0 ? "0/0" : `${activeMatch()}/${matchCount()}`}
          </Show>
        </span>
        <button
          type="button"
          class="px-2 py-1 text-sm text-text-faint hover:text-text"
          title="Previous match (Shift+Enter)"
          onClick={() => findNext(false)}
        >
          Prev
        </button>
        <button
          type="button"
          class="px-2 py-1 text-sm text-text-faint hover:text-text"
          title="Next match (Enter)"
          onClick={() => findNext(true)}
        >
          Next
        </button>
        <button
          type="button"
          class="px-2 py-1 text-sm text-text-faint hover:text-text"
          title="Close search (Esc)"
          onClick={close}
        >
          x
        </button>
      </div>
    </Show>
  );
}
