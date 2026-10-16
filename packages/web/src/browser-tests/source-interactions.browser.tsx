import { parsePatchFiles } from "@pierre/diffs";
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";

import type { ResolvedSource } from "@better-review/shared";

import { AnchoredSelectionEditor } from "../components/AnchoredSelectionEditor";
import { InlineFindingComment } from "../components/InlineFindingComment";
import { InlineSourceView } from "../components/InlineSourceView";
import type { SourceTarget } from "../lib/annotation-navigation";
import type { SelectedSource, SelectionChatController } from "../lib/ask-ai-selection";
import {
  createReviewInteractions,
  createSourceNavigation,
  type ReviewInteractionContext,
} from "../lib/review-interactions";
import { parseSelectionQuestionMessage } from "../lib/selection-question-message";
import { trpc } from "../lib/trpc";
import {
  askSourceRows,
  browserWait,
  sourceJson,
  sourceRequest,
  sourceWindow,
  type SourceFixtureRequest,
} from "./source-fixture";

const head = "a".repeat(40),
  previous = "b".repeat(40);
const content = Array.from({ length: 850 }, (_, i) => `source line ${i + 1}`).join("\n");
const target: SourceTarget = {
  sessionId: "browser-source",
  path: "src/large.ts",
  ref: previous,
  side: "LEFT",
  line: 350,
};
const found = (request: SourceFixtureRequest, text = content): ResolvedSource => ({
  status: "found",
  path: request.path,
  ref: request.ref!,
  side: request.side ?? "RIGHT",
  line: request.line ?? 1,
  ...sourceWindow(text, request.range),
  approximate: false,
  notice: null,
});
const button = (host: HTMLElement, text: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
    (item) => item.textContent?.trim() === text,
  )!;
function setupHost() {
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;inset:10px;overflow:auto;background:var(--color-bg);z-index:20";
  document.body.append(host);
  return host;
}
function assertions() {
  let passed = 0;
  return {
    check(ok: unknown, message: string) {
      if (!ok) throw new Error(message);
      passed++;
    },
    result: () => ({ passed }),
  };
}

export async function testSourcePaginationAbsoluteSelectionInBrowser() {
  const { check, result } = assertions();
  const host = setupHost(),
    originalFetch = window.fetch;
  const reads: SourceFixtureRequest[] = [];
  const questions: SelectedSource[] = [];
  const [current, setCurrent] = createSignal(target);
  window.fetch = async (input, init) => {
    if (!String(input).includes("/prReview.navigateSource")) return originalFetch(input, init);
    const request = sourceRequest(input);
    reads.push(request);
    return sourceJson(found(request));
  };
  const dispose = render(
    () => (
      <InlineSourceView
        target={current()}
        onChoose={setCurrent}
        onClose={() => {}}
        onResolved={() => {}}
        onAskAi={(selection) => questions.push(selection)}
      />
    ),
    host,
  );
  const pageReady = (first: number, last: number) =>
    browserWait(
      () =>
        host.querySelectorAll("code").length === last - first + 1 &&
        !!host.querySelector(`[data-source-line="${first}"]`) &&
        !!host.querySelector(`[data-source-line="${last}"]`),
      `Source page ${first}–${last} did not render`,
    );
  try {
    await pageReady(250, 449);
    check(
      JSON.stringify(reads[0].range) === JSON.stringify({ startLine: 250, endLine: 449 }),
      "initial source request must be bounded around the absolute target line",
    );
    check(
      host.querySelector("nav")?.textContent?.includes("Lines 250–449 of 850"),
      "page summary must use absolute coordinates",
    );
    await askSourceRows(host, 350, 351);
    check(
      questions[0]?.startLine === 350 &&
        questions[0]?.endLine === 351 &&
        questions[0]?.text === "source line 350\nsource line 351" &&
        questions[0]?.revision === previous &&
        questions[0]?.side === "LEFT",
      "initial selection must retain absolute previous-version coordinates and exact text",
    );
    button(host, "Load later lines").click();
    await pageReady(450, 649);
    await askSourceRows(host, 475, 476);
    check(
      questions[1]?.startLine === 475 &&
        questions[1]?.endLine === 476 &&
        questions[1]?.revision === previous &&
        questions[1]?.file === target.path &&
        questions[1]?.text === "source line 475\nsource line 476",
      "later-page Ask AI must not reset coordinates or source provenance",
    );
    check(
      !host.querySelector('[data-source-line="350"]'),
      "pagination replaces the bounded window instead of appending a full file",
    );
    button(host, "Load earlier lines").click();
    await pageReady(250, 449);
    button(host, "Load earlier lines").click();
    await pageReady(50, 249);
    await askSourceRows(host, 75);
    check(
      questions[2]?.startLine === 75 &&
        questions[2]?.text === "source line 75" &&
        questions[2]?.revision === previous,
      "earlier-page selection must remain absolute",
    );
    setCurrent({ ...target, line: 1 });
    await pageReady(1, 200);
    check(
      button(host, "Load earlier lines").disabled,
      "earlier page must disable at first source line",
    );
    setCurrent({ ...target, line: 850 });
    await pageReady(750, 850);
    check(
      button(host, "Load later lines").disabled,
      "later page must disable at final source line",
    );
    check(
      reads.every(
        (read) =>
          read.ref === previous &&
          read.side === "LEFT" &&
          read.range.endLine - read.range.startLine < 200,
      ),
      "every page must carry immutable original ref/side and at most 200 lines",
    );
    check(
      !host.querySelector("form,dialog"),
      "read-only page navigation never creates a comment editor",
    );
    return result();
  } finally {
    dispose();
    host.remove();
    window.fetch = originalFetch;
    getSelection()?.removeAllRanges();
  }
}

export async function testSourceAbortPreservesOtherReaderInBrowser() {
  const { check, result } = assertions();
  const host = setupHost(),
    originalFetch = window.fetch;
  const left = document.createElement("div"),
    right = document.createElement("div");
  host.append(left, right);
  const pending: { signal: AbortSignal; release: () => void }[] = [];
  const sharedLoads = new Map<string, { promise: Promise<void>; release: () => void }>();
  const [current, setCurrent] = createSignal({ ...target, path: "shared.ts" });
  window.fetch = async (input, init) => {
    if (!String(input).includes("/prReview.navigateSource")) return originalFetch(input, init);
    const request = sourceRequest(input);
    if (request.path === "fast.ts") return sourceJson(found(request));
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (!signal) throw new Error("Source tRPC request did not propagate its AbortSignal");
    let load = sharedLoads.get(request.path);
    if (!load) {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      load = { promise, release };
      sharedLoads.set(request.path, load);
    }
    // Simulate two RPC readers of one immutable cache fill: cancelling one request
    // must not cancel the load or the other reader. Backend cache semantics have separate tests.
    return new Promise<Response>((resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Reader cancelled", "AbortError")),
        { once: true },
      );
      pending.push({ signal, release: load.release });
      void load.promise.then(() => resolve(sourceJson(found(request))));
    });
  };
  let disposeLeft = render(
    () => (
      <InlineSourceView
        target={current()}
        onChoose={() => {}}
        onClose={() => {}}
        onResolved={() => {}}
      />
    ),
    left,
  );
  const disposeRight = render(
    () => (
      <InlineSourceView
        target={{ ...target, path: "shared.ts" }}
        onChoose={() => {}}
        onClose={() => {}}
        onResolved={() => {}}
      />
    ),
    right,
  );
  try {
    await browserWait(() => pending.length === 2, "two independent source readers did not start");
    check(
      sharedLoads.size === 1,
      "both readers must be waiting on the same mocked immutable cache fill",
    );
    setCurrent({ ...target, path: "fast.ts" });
    await browserWait(
      () => !!left.querySelector('[data-source-ready="true"]'),
      "superseding source did not render",
    );
    check(
      pending[0].signal.aborted && !pending[1].signal.aborted,
      "superseding one view must abort only its own tRPC reader",
    );
    check(
      !right.querySelector('[data-source-ready="true"]'),
      "other reader must still be waiting on the shared fill",
    );
    pending[1].release();
    await browserWait(
      () => !!right.querySelector('[data-source-ready="true"]'),
      "other shared reader did not complete after first reader cancellation",
    );
    check(
      left.textContent?.includes("fast.ts") && !left.textContent?.includes("shared.ts"),
      "late superseded response must not replace the new source",
    );
    check(
      right.textContent?.includes("shared.ts") && !right.querySelector('[role="alert"]'),
      "other reader must retain successful source without a cancellation error",
    );
    setCurrent({ ...target, path: "close-before-resolution.ts" });
    await browserWait(() => pending.length === 3, "closing-source request did not start");
    disposeLeft();
    disposeLeft = () => {};
    check(
      pending[2].signal.aborted && !pending[1].signal.aborted,
      "unmount must abort its pending request without affecting the completed other reader",
    );
    pending[2].release();
    return result();
  } finally {
    disposeLeft();
    disposeRight();
    host.remove();
    window.fetch = originalFetch;
  }
}

export async function testAmbiguousCandidatePaginationProvenanceInBrowser() {
  const { check, result } = assertions();
  const host = setupHost(),
    originalFetch = window.fetch;
  const reads: SourceFixtureRequest[] = [];
  const navigation = createSourceNavigation(
    () => "fixture",
    (original, range, signal) =>
      trpc.prReview.navigateSource.query(
        {
          sessionId: original.sessionId,
          path: original.lookup?.path ?? original.path,
          ref: original.lookup?.ref ?? original.ref,
          side: original.lookup?.side ?? original.side,
          line: original.line,
          range,
        },
        { signal },
      ),
  );
  const selections: SelectedSource[] = [];
  window.fetch = async (input, init) => {
    if (!String(input).includes("/prReview.navigateSource")) return originalFetch(input, init);
    const request = sourceRequest(input);
    reads.push(request);
    if (request.path === "missing.ts")
      return sourceJson({
        status: "ambiguous",
        candidates: ["src/large.ts", "other/large.ts"],
        ref: head,
        side: "RIGHT",
        approximate: true,
        notice: "Historical source unavailable; candidate correspondence is approximate.",
      });
    return sourceJson(found(request));
  };
  const dispose = render(
    () => (
      <Show when={navigation.target()}>
        {(original) => (
          <InlineSourceView
            target={original()}
            navigation={navigation}
            onClose={navigation.close}
            onChoose={(next) => void navigation.openSource(next)}
            onResolved={() => {
              throw new Error("Approximate lookup must not focus a current comment location");
            }}
            onAskAi={(selection) => selections.push(selection)}
          />
        )}
      </Show>
    ),
    host,
  );
  try {
    for (const captured of [false, true]) {
      await navigation.openSource({
        ...target,
        path: "missing.ts",
        ...(captured
          ? {
              captured: {
                startLine: 350,
                endLine: 351,
                text: "original captured 350\noriginal captured 351",
              },
            }
          : {}),
      });
      button(host, "src/large.ts").click();
      await browserWait(
        () => navigation.destination()?.result.status === "found",
        "candidate lookup did not resolve",
      );
      check(
        navigation.target()?.ref === previous &&
          navigation.target()?.side === "LEFT" &&
          navigation.target()?.lookup?.ref === head &&
          navigation.target()?.lookup?.side === "RIGHT",
        "candidate lookup must retain original LEFT revision separately from current RIGHT lookup",
      );
      if (captured) {
        check(
          !host.querySelector('nav[aria-label="Source pages"]'),
          "unverified fallback must not offer current-source paging as captured historical source",
        );
        await navigation.page("later");
        await askSourceRows(host, 350, 351);
        const selection = selections.at(-1)!;
        check(
          selection.revision === previous &&
            selection.side === "LEFT" &&
            selection.startLine === 350 &&
            selection.text === "original captured 350\noriginal captured 351",
          "even a programmatic fallback page request must not relabel captured historical text/ref/coordinates",
        );
      } else {
        button(host, "Load later lines").click();
        await browserWait(
          () => !!host.querySelector('[data-source-line="475"]'),
          "chosen candidate did not load its later page",
        );
        await askSourceRows(host, 475, 476);
        const selection = selections.at(-1)!;
        check(
          selection.revision === head &&
            selection.side === "RIGHT" &&
            selection.startLine === 475 &&
            selection.endLine === 476 &&
            selection.text === "source line 475\nsource line 476",
          "fallback-page selection must describe the actual displayed current source, not stamp historical provenance on it",
        );
        check(
          host.textContent?.includes("approximate"),
          "candidate approximation notice must survive pagination",
        );
      }
      check(
        navigation.target()?.ref === previous &&
          reads.at(-1)?.range.startLine === 450 &&
          reads.at(-1)?.range.endLine === 649 &&
          reads.at(-1)?.ref === head &&
          reads.at(-1)?.side === "RIGHT",
        "pagination must use candidate lookup revision/range without overwriting original target provenance",
      );
      navigation.close();
      getSelection()?.removeAllRanges();
    }
    return result();
  } finally {
    dispose();
    navigation.close();
    host.remove();
    window.fetch = originalFetch;
    getSelection()?.removeAllRanges();
  }
}

function interactionContext(): ReviewInteractionContext {
  return {
    prUrl: "https://github.com/browser-fixture/isolated/pull/1",
    loadedPrUrl: "https://github.com/browser-fixture/isolated/pull/1",
    scope: "fixture-current",
    headSha: head,
    comparisonBaseSha: previous,
    commitScope: false,
    loading: false,
    files: parsePatchFiles(
      "diff --git a/src/large.ts b/src/large.ts\n--- a/src/large.ts\n+++ b/src/large.ts\n@@ -1 +1 @@\n-old\n+new\n",
    ).flatMap((patch) => patch.files),
  };
}

export async function testPagedQuestionDraftAndDeliveryInBrowser() {
  const { check, result } = assertions();
  const host = setupHost(),
    originalFetch = window.fetch;
  const [context, setContext] = createSignal(interactionContext());
  const interactions = createReviewInteractions(context, {
    resolve: (original, range, signal) =>
      trpc.prReview.navigateSource.query(
        {
          sessionId: original.sessionId,
          path: original.path,
          ref: original.ref,
          side: original.side,
          line: original.line,
          range,
        },
        { signal },
      ),
    focus: () => false,
  });
  const sends: { id: string; body: string; key: string }[] = [];
  let creates = 0,
    fail = true;
  const controller: SelectionChatController = {
    currentSessionId: () => "current-other",
    currentBusy: () => false,
    disabled: () => false,
    sessions: () => [{ id: "saved", headSha: head, createdAt: 0, hidden: false }],
    send: (selection, body, destination, isCurrent) =>
      interactions
        .askAbout(selection, body, {
          target: destination,
          isCurrent,
          createSession: async () => `new-${++creates}`,
          client: (id) => ({
            history: async () => ({
              sessionId: id,
              messages: [],
              settlements: [],
              running: sends.some((send) => send.id === id),
              compacting: false,
            }),
            send: async (body, key) => {
              sends.push({ id, body, key });
              if (fail) {
                fail = false;
                throw new Error("Fixture lost admission receipt");
              }
              return { submissionId: `receipt-${sends.length}` };
            },
          }),
        })
        .then(Boolean),
  };
  window.fetch = async (input, init) => {
    if (String(input).includes("/prReview.navigateSource"))
      return sourceJson(found(sourceRequest(input)));
    return originalFetch(input, init);
  };
  const dispose = render(
    () => (
      <>
        <Show when={interactions.source.target()}>
          {(original) => (
            <InlineSourceView
              target={original()}
              navigation={interactions.source}
              onChoose={(next) => void interactions.openSource(next)}
              onClose={() => interactions.source.close()}
              onResolved={() => {}}
              askEditorOpen={!!interactions.question()}
              onAskAi={(selection, anchor, ref) =>
                interactions.selectSource(selection, anchor, ref)
              }
            />
          )}
        </Show>
        <Show when={interactions.question()}>
          {(draft) => (
            <AnchoredSelectionEditor
              draft={draft()}
              controller={controller}
              scope={context().scope}
              sourceDialogOpen={false}
              isCurrent={() =>
                !!interactions.question() && context().scope === draft().selection.scope
              }
              onDismiss={interactions.dismissSelection}
            />
          )}
        </Show>
      </>
    ),
    host,
  );
  try {
    for (const destination of ["new", "saved"]) {
      await interactions.openSource(target);
      await interactions.source.page("later");
      await browserWait(
        () => !!host.querySelector('[data-source-line="475"]'),
        "question fixture did not page source",
      );
      await askSourceRows(host, 475, 476);
      await browserWait(
        () => !!document.querySelector('form[aria-label="Ask about selection"]'),
        "paged-source question composer did not open",
      );
      const draft = interactions.question()!;
      const form = () =>
        document.querySelector<HTMLFormElement>('form[aria-label="Ask about selection"]')!;
      const input = form().querySelector("textarea")!;
      input.value = `Why these paged lines in ${destination}?`;
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      const picker = form().querySelector("select")!;
      picker.value = destination;
      picker.dispatchEvent(new Event("change", { bubbles: true }));
      await interactions.source.page("earlier");
      interactions.source.close();
      check(
        interactions.question() === draft &&
          draft.state.question() === input.value &&
          draft.state.target() === destination &&
          draft.selection.startLine === 475 &&
          draft.selection.revision === previous,
        "paging/closing source must preserve the original selected quote, typed question and explicit destination",
      );
      const initial = sends.length;
      fail = true;
      form().requestSubmit();
      form().requestSubmit();
      await browserWait(
        () => !!draft.state.error() && !draft.state.sending(),
        "ambiguous admission failure did not retain a visible question error",
      );
      check(
        sends.length === initial + 1,
        "duplicate native submissions must admit only once while the first question is pending",
      );
      check(
        interactions.question() === draft &&
          form().querySelector("textarea")!.value === draft.state.question(),
        "failed send must preserve the rendered question draft",
      );
      form().requestSubmit();
      await browserWait(
        () => !interactions.question(),
        "retry did not complete and dismiss question",
      );
      check(
        sends.length === initial + 2 &&
          sends[initial].key === sends[initial + 1].key &&
          sends[initial].body === sends[initial + 1].body,
        "ambiguous retry must preserve admission key/body through the real interaction delivery module",
      );
      const parsed = parseSelectionQuestionMessage(sends[initial].body)!;
      check(
        parsed.selection.startLine === 475 &&
          parsed.selection.endLine === 476 &&
          parsed.selection.revision === previous &&
          parsed.selection.side === "LEFT" &&
          parsed.selection.text === "source line 475\nsource line 476",
        "question delivery must serialize the paged absolute source selection, not a local row offset",
      );
      check(
        sends[initial].id === (destination === "new" ? "new-1" : "saved"),
        "question must reach the selected new or existing conversation",
      );
    }
    check(
      creates === 1,
      "retry and existing conversation delivery must not create duplicate sessions",
    );
    await interactions.openSource(target);
    await askSourceRows(host, 350);
    const draft = interactions.question()!;
    draft.state.setQuestion("Retain me after revision change");
    setContext({ ...context(), scope: "different-revision", headSha: "c".repeat(40) });
    const count = sends.length;
    document
      .querySelector<HTMLFormElement>('form[aria-label="Ask about selection"]')!
      .requestSubmit();
    await new Promise(requestAnimationFrame);
    check(
      sends.length === count &&
        interactions.question() === draft &&
        draft.state.question() === "Retain me after revision change" &&
        !!document.querySelector('form[aria-label="Ask about selection"] [role="alert"]'),
      "stale question must be visibly blocked without sending or dropping the draft",
    );
    return result();
  } finally {
    dispose();
    interactions.source.close();
    host.remove();
    window.fetch = originalFetch;
    getSelection()?.removeAllRanges();
  }
}

export async function testCurrentCommentGuardRetainsBrowserDraftInBrowser() {
  const { check, result } = assertions();
  const host = setupHost(),
    originalFetch = window.fetch;
  const [context, setContext] = createSignal(interactionContext());
  const interactions = createReviewInteractions(context, {
    resolve: async () => {
      throw new Error("Unexpected source navigation");
    },
    focus: () => false,
  });
  const finding = {
    id: "outside-patch",
    file: target.path,
    line: 350,
    severity: "warning" as const,
    message: "Check current source",
    origin: { sessionId: target.sessionId, revision: head },
  };
  const posts: string[] = [];
  window.fetch = async (input, init) => {
    if (String(input).includes("/prReview.source"))
      return sourceJson({ path: target.path, ref: head, content });
    return originalFetch(input, init);
  };
  const dispose = render(
    () => (
      <Show when={interactions.inlineFinding()}>
        {(entry) => (
          <InlineFindingComment
            entry={entry()}
            isCurrent={() => interactions.currentComment(entry().request)}
            onCancel={() => interactions.finishComment(entry())}
            onSubmit={async (body) => {
              interactions.assertCurrentComment(entry().request);
              posts.push(body);
            }}
          />
        )}
      </Show>
    ),
    host,
  );
  try {
    interactions.prepareComment(finding, target.sessionId, head);
    await browserWait(
      () => host.querySelector('[data-source-ready="true"]') !== null,
      "verified current comment source did not load",
    );
    const entry = interactions.inlineFinding()!;
    await browserWait(
      () => !!host.querySelector("textarea:not(:disabled)"),
      "Durable inline draft did not hydrate",
    );
    const textarea = host.querySelector("textarea")!;
    textarea.value = "User-edited current source draft";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    interactions.prepareComment({ ...finding, line: 360 }, target.sessionId, head);
    interactions.prepareComment(finding, target.sessionId, head);
    check(
      interactions.inlineFinding()!.draft === entry.draft &&
        host.querySelector("textarea")!.value === "User-edited current source draft",
      "switching findings must retain the edited comment draft through real form remounts",
    );
    setContext({ ...context(), headSha: "c".repeat(40), scope: "changed" });
    host.querySelector("form")!.requestSubmit();
    await new Promise(requestAnimationFrame);
    check(
      posts.length === 0 &&
        host.querySelector("fieldset")!.disabled &&
        entry.draft.body === "User-edited current source draft",
      "head/scope change must disable current-comment submission without losing the body",
    );
    let rejected = false;
    try {
      interactions.assertCurrentComment(entry.request);
    } catch {
      rejected = true;
    }
    check(
      rejected,
      "last-moment comment guard must reject stale validated locations even if a consumer bypasses disabled UI",
    );
    setContext(interactionContext());
    await browserWait(
      () => !host.querySelector("fieldset")!.disabled,
      "restoring exact source context did not re-enable the draft",
    );
    host.querySelector("form")!.requestSubmit();
    await browserWait(
      () => posts.length === 1,
      "current validated comment did not reach local submission spy",
    );
    check(
      posts[0] === "User-edited current source draft",
      "only explicitly submitted current draft may reach the comment transport boundary",
    );
    interactions.prepareComment(
      { ...finding, origin: { ...finding.origin, revision: previous } },
      target.sessionId,
      previous,
    );
    check(
      interactions.inlineFinding()!.draft === entry.draft &&
        interactions.notice()?.includes("historical"),
      "historical finding must not replace or authorize an existing current-source draft",
    );
    return result();
  } finally {
    dispose();
    host.remove();
    window.fetch = originalFetch;
  }
}
