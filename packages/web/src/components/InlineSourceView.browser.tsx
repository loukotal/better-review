import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";

import type { ResolvedSource } from "@better-review/shared";

import { sourceRequest, sourceWindow } from "../browser-tests/source-fixture";
import type { SourceTarget } from "../lib/annotation-navigation";
import type { SelectedSource } from "../lib/ask-ai-selection";
import { InlineSourceView } from "./InlineSourceView";

/** Read-only inline source selection preserves source text/ref; no publishing or model transport. */
export async function testInlineSourceViewInBrowser() {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:10px;overflow:auto;background:#111;z-index:9999";
  document.body.append(host);
  const originalFetch = window.fetch;
  const head = "a".repeat(40),
    old = "b".repeat(40);
  window.fetch = async (input, init) => {
    if (String(input).includes("/prReview.navigateSource")) {
      const request = sourceRequest(input);
      return new Response(
        JSON.stringify({
          result: {
            data: {
              json: {
                status: "found",
                path: "src/a.ts",
                ref: head,
                side: "RIGHT",
                ...sourceWindow("one\ntwo", request.range),
                line: 1,
                approximate: true,
                notice: "Showing current fallback code",
              },
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return originalFetch(input, init);
  };
  const settle = async () => {
    for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
  };
  let dispose = () => {},
    passed = 0;
  let question: { selection: SelectedSource; ref: string } | undefined;
  const check = (ok: unknown, message: string) => {
    if (!ok) throw new Error(message);
    passed++;
  };
  try {
    dispose = render(
      () => (
        <InlineSourceView
          target={{ path: "src/a.ts", ref: head, sessionId: "inline-source-test", line: 1 }}
          onClose={() => {}}
          onChoose={() => {}}
          onResolved={() => {}}
          onAskAi={(selection, _anchor, ref) => {
            question = { selection, ref };
          }}
        />
      ),
      host,
    );
    await settle();
    const codes = host.querySelectorAll("code");
    const range = document.createRange();
    range.setStart(codes[0].firstChild!, 0);
    range.setEnd(codes[1].firstChild!, 3);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    host.querySelector("section")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await settle();
    document.querySelector<HTMLButtonElement>('[aria-label="Selection actions"] button')!.click();
    check(
      question?.selection.text === "one\ntwo" && question.ref === head,
      "Inline source Ask AI must exclude line-number text and preserve actual immutable revision",
    );
    check(
      !host.querySelector("form") && !host.querySelector("dialog"),
      "Read-only source must not expose a PR-comment form or modal",
    );
    dispose();
    host.replaceChildren();
    getSelection()?.removeAllRanges();
    dispose = render(
      () => (
        <InlineSourceView
          target={{
            path: "old/a.ts",
            ref: old,
            side: "LEFT",
            sessionId: "inline-source-test",
            line: 7,
            captured: { startLine: 7, endLine: 7, text: "exact previous text" },
          }}
          onClose={() => {}}
          onChoose={() => {}}
          onResolved={() => {
            throw new Error("Captured previous source must not focus a current source row");
          }}
        />
      ),
      host,
    );
    await settle();
    check(
      host.querySelector("[data-source-ref]")?.getAttribute("data-source-ref") === old &&
        host.querySelector("[data-source-side]")?.getAttribute("data-source-side") === "LEFT",
      "Captured fallback lost previous side/ref",
    );
    check(
      host.querySelector("code")?.textContent === "exact previous text" &&
        !host.textContent?.includes("Showing current fallback code"),
      "Captured source must not be mislabeled as the current fallback file",
    );
    return { passed, posts: 0, modelCalls: 0 };
  } finally {
    dispose();
    host.remove();
    getSelection()?.removeAllRanges();
    window.fetch = originalFetch;
  }
}

export async function testInlineSourceAmbiguityInBrowser() {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:10px;overflow:auto;background:#111;z-index:9999";
  document.body.append(host);
  const originalFetch = window.fetch;
  const head = "a".repeat(40),
    old = "b".repeat(40);
  const json = (value: unknown) =>
    new Response(JSON.stringify({ result: { data: { json: value } } }), {
      headers: { "content-type": "application/json" },
    });
  window.fetch = async (input, init) => {
    const url = new URL(String(input), location.href);
    if (url.pathname.endsWith("/prReview.navigateSource")) {
      const request = sourceRequest(input);
      if (request.path === "missing.ts" || request.path === "removed/config.ts")
        return json({
          status: "ambiguous",
          candidates:
            request.path === "removed/config.ts"
              ? ["a/config.ts", "b/config.ts"]
              : ["a/file.ts", "b/file.ts"],
          ref: head,
          side: "RIGHT",
          approximate: true,
          notice:
            request.path === "removed/config.ts"
              ? "Requested directory is unavailable. Basename-only candidates at the same revision; correspondence is approximate."
              : "Historical source unavailable. Choose current source; correspondence is approximate.",
        });
      return json({
        status: "found",
        path: request.path,
        ref: request.ref,
        side: request.side,
        ...sourceWindow("current chosen source", request.range),
        line: 1,
        approximate: false,
        notice: null,
      });
    }
    return originalFetch(input, init);
  };
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise(requestAnimationFrame);
  };
  let dispose = () => {},
    passed = 0;
  const check = (ok: unknown, message: string) => {
    if (!ok) throw new Error(message);
    passed++;
  };
  try {
    for (const { captured, staleDirectory } of [
      { captured: false, staleDirectory: false },
      { captured: true, staleDirectory: false },
      { captured: false, staleDirectory: true },
      { captured: true, staleDirectory: true },
    ]) {
      const originalRef = staleDirectory ? head : old;
      const originalSide = staleDirectory ? "RIGHT" : "LEFT";
      const [target, setTarget] = createSignal<SourceTarget>({
        sessionId: "ambiguous-source",
        path: staleDirectory ? "removed/config.ts" : "missing.ts",
        ref: originalRef,
        side: originalSide,
        line: 1,
        ...(captured
          ? { captured: { text: "original captured source", startLine: 1, endLine: 1 } }
          : {}),
      });
      let question: { selection: SelectedSource; ref: string } | undefined;
      let resolved: Extract<ResolvedSource, { status: "found" }> | undefined;
      dispose = render(
        () => (
          <Show when={target()} keyed>
            {(current) => (
              <InlineSourceView
                target={current}
                onChoose={setTarget}
                onClose={() => {}}
                onResolved={(source) => {
                  resolved = source;
                }}
                onAskAi={(selection, _anchor, ref) => {
                  question = { selection, ref };
                }}
              />
            )}
          </Show>
        ),
        host,
      );
      await settle();
      const choice = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent === (staleDirectory ? "a/config.ts" : "b/file.ts"),
      );
      if (!choice) throw new Error(`Ambiguity fixture did not load: ${host.textContent}`);
      choice.click();
      await settle();
      check(
        target().ref === originalRef && target().side === originalSide,
        "Candidate choice must not replace original revision/side provenance",
      );
      check(
        target().lookup?.approximate === true && target().lookup?.side === "RIGHT",
        "Chosen lookup target lost resolved side or fallback approximation",
      );
      const pane = host.querySelector<HTMLElement>("[data-inline-source]")!;
      if (captured) {
        check(
          pane.dataset.sourceRef === originalRef &&
            pane.dataset.sourceSide === originalSide &&
            pane.querySelector("code")?.textContent === "original captured source" &&
            !resolved,
          "Candidate choice dropped captured historical source or relabeled it current",
        );
        if (staleDirectory)
          check(
            pane.textContent?.includes("approximate"),
            "Same-revision captured source must retain the chosen path's approximation notice",
          );
      } else {
        check(
          pane.dataset.sourceRef === head &&
            pane.dataset.sourceSide === "RIGHT" &&
            pane.textContent?.includes("approximate") &&
            resolved?.approximate &&
            resolved.side === "RIGHT",
          "Current fallback candidate lost resolved RIGHT side/approximation notice",
        );
      }
      const text = pane.querySelector("code")!.firstChild!;
      const range = document.createRange();
      range.selectNodeContents(text);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      pane.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      await settle();
      document.querySelector<HTMLButtonElement>('[aria-label="Selection actions"] button')!.click();
      check(
        question?.ref === (captured ? originalRef : head) &&
          question?.selection.side === (captured ? originalSide : "RIGHT") &&
          question.selection.text ===
            (captured ? "original captured source" : "current chosen source"),
        "Ask AI serialized incorrect side/ref/text after ambiguous fallback choice",
      );
      dispose();
      host.replaceChildren();
      getSelection()?.removeAllRanges();
    }
    return { passed, posts: 0, modelCalls: 0 };
  } finally {
    dispose();
    host.remove();
    window.fetch = originalFetch;
    getSelection()?.removeAllRanges();
  }
}

export async function testInlineSourceRetryInBrowser() {
  const host = document.createElement("div");
  document.body.append(host);
  const originalFetch = window.fetch;
  const head = "a".repeat(40);
  let reads = 0;
  window.fetch = async (input, init) => {
    if (!String(input).includes("/prReview.navigateSource")) return originalFetch(input, init);
    const request = sourceRequest(input);
    reads++;
    return new Response(
      JSON.stringify(
        reads === 1
          ? {
              error: {
                json: {
                  message:
                    "Source repository read failed (ls-tree). Retry after checkout preparation finishes.",
                  code: -32603,
                  data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
                },
              },
            }
          : {
              result: {
                data: {
                  json: {
                    status: "found",
                    path: "ready.ts",
                    ref: head,
                    side: "RIGHT",
                    ...sourceWindow("prepared source", request.range),
                    line: 1,
                    approximate: false,
                    notice: null,
                  },
                },
              },
            },
      ),
      { headers: { "content-type": "application/json" } },
    );
  };
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise(requestAnimationFrame);
  };
  const dispose = render(
    () => (
      <InlineSourceView
        target={{ sessionId: "source-retry", path: "ready.ts", ref: head, line: 1 }}
        onClose={() => {}}
        onChoose={() => {}}
        onResolved={() => {}}
      />
    ),
    host,
  );
  try {
    await settle();
    if (
      !host
        .querySelector('[role="alert"]')
        ?.textContent?.includes("Source repository read failed") ||
      host.textContent?.includes("No source matching")
    )
      throw new Error("Repository failure was hidden as missing source");
    Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Retry")!
      .click();
    await settle();
    if (
      reads !== 2 ||
      host.querySelector("code")?.textContent !== "prepared source" ||
      host.querySelector("[data-source-ref]")?.getAttribute("data-source-ref") !== head ||
      host.querySelector("form,dialog")
    )
      throw new Error("Retry did not replace repository error with read-only prepared source");
    return { passed: 2, posts: 0, modelCalls: 0 };
  } finally {
    dispose();
    host.remove();
    window.fetch = originalFetch;
  }
}
