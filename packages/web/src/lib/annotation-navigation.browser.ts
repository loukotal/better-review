/** Transport-fixtured integration against the mounted real App, not a copied click handler.
 * Run on a loaded full-PR /review page. No model calls or saved-session writes are made.
 */
import { parsePatchFiles } from "@pierre/diffs";
import superjson from "superjson";

import type { ReviewSnapshot } from "@better-review/shared";

import { getFileElementId } from "../DiffViewer";
import { formatAnnotationForComment } from "../utils/formatAnnotationForClipboard";
import { formatSelectionQuestion } from "./ask-ai-selection";
import { queryClient, queryKeys, type PrCoreData } from "./query";

export async function testAppAnnotationNavigationInBrowser(
  mode: "navigation" | "prefill" | "links" | "inline" | "dismissal" = "navigation",
) {
  const originalUrl = location.href;
  const url = new URL(originalUrl);
  const prUrl = url.searchParams.get("prUrl");
  if (!prUrl || url.searchParams.get("mode") === "commit")
    throw new Error("Run on a loaded full-PR review page");
  const core = queryClient.getQueryData<PrCoreData>(queryKeys.pr.core(prUrl));
  if (!core?.headSha) throw new Error("The displayed PR core must have known head metadata");
  const files = parsePatchFiles(core.diff).flatMap((patch) => patch.files);
  const file = files.find((file) =>
    file.hunks.some((hunk) => hunk.additionCount > 0 && hunk.additionStart > 1),
  );
  if (!file) throw new Error("Fixture needs a changed file with leading unchanged source");
  const line = file.hunks.find((hunk) => hunk.additionCount > 0)!.additionStart;
  let sessionId = `annotation-navigation-${crypto.randomUUID()}`;
  const fixtureSessionId = sessionId;
  const oldRef = "0".repeat(40);
  let snapshotStream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const fixtures = [
    {
      label: "current-visible",
      path: mode === "inline" || mode === "dismissal" ? file.name : file.name.split("/").pop()!,
      line,
      ref: core.headSha,
      expected: "diff",
    },
    { label: "historical-visible", path: file.name, line, ref: oldRef, expected: "source" },
    { label: "current-unchanged", path: file.name, line: 1, ref: core.headSha, expected: "source" },
    {
      label: "unavailable-file",
      path: "unchanged-only.ts",
      line: 1,
      ref: core.headSha,
      expected: "source",
    },
    { label: "unknown-revision", path: file.name, line, ref: undefined, expected: "source" },
  ];
  const snapshot: ReviewSnapshot = {
    sessionId,
    revision: core.headSha,
    running: false,
    compacting: false,
    settlements: [],
    messages: fixtures.map((fixture, index) => ({
      id: `fixture-${index}`,
      role: "assistant",
      metadata: { timestamp: new Date().toISOString(), revision: fixture.ref },
      parts: [
        {
          type: "text",
          text: `<<ANNOTATION file="${fixture.path}" line="${fixture.line}" severity="${index === 0 ? "critical" : "warning"}">>navigation-fixture-${fixture.label}<</ANNOTATION>>`,
        },
      ],
    })),
  };
  snapshot.messages.push(
    {
      id: "selection-right",
      role: "user",
      metadata: { timestamp: new Date().toISOString() },
      parts: [
        {
          type: "text",
          text: formatSelectionQuestion(
            {
              draftId: "right",
              scope: "fixture",
              file: file.name,
              side: "RIGHT",
              startLine: line,
              endLine: line,
              revision: core.headSha,
              text: file.additionLines[file.hunks[0].additionLineIndex] ?? "current selection",
            },
            "selection-right-fixture",
          ),
        },
      ],
    },
    {
      id: "selection-left",
      role: "user",
      metadata: { timestamp: new Date().toISOString() },
      parts: [
        {
          type: "text",
          text: formatSelectionQuestion(
            {
              draftId: "left",
              scope: "fixture",
              file: file.name,
              side: "LEFT",
              startLine: 7,
              endLine: 7,
              revision: oldRef,
              text: "old version selection fixture",
            },
            "selection-left-fixture",
          ),
        },
      ],
    },
    {
      id: "ordinary-links",
      role: "assistant",
      metadata: { timestamp: new Date().toISOString(), revision: core.headSha },
      parts: [
        {
          type: "text",
          text: `File token [[file:${file.name}:${line}]]. Markdown [markdown-link-fixture](./${file.name}#L${line}). Inline \`${file.name.split("/").pop()}:${line}\`. Expanded [[file:${file.name}:1]]. Unsafe [[file:../${file.name}:${line}]].`,
        },
      ],
    },
    {
      id: "historical-link",
      role: "assistant",
      metadata: { timestamp: new Date().toISOString(), revision: oldRef },
      parts: [{ type: "text", text: `Historical-link-fixture [[file:${file.name}:${line}]].` }],
    },
  );
  const originalFetch = window.fetch;
  const sourceReads: { path: string; ref?: string; sessionId: string }[] = [];
  let writes = 0;
  const commentPosts: Record<string, unknown>[] = [];
  const originalInput =
    document.querySelector<HTMLTextAreaElement>('[aria-label="Message review assistant"]')?.value ??
    "";
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  window.fetch = async (input, init) => {
    const request = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      location.origin,
    );
    if (request.pathname.endsWith("/prReview.selectSession")) {
      const value = superjson.deserialize<{ sessionId: string }>(
        JSON.parse(String(init?.body ?? "{}")),
      );
      if (value.sessionId === sessionId)
        return json({
          result: {
            data: {
              json: {
                session: { id: sessionId },
                sessions: [{ id: sessionId, headSha: core.headSha, createdAt: 1, hidden: false }],
                headSha: core.headSha,
                sessionHeadSha: core.headSha,
              },
            },
          },
        });
    }
    if (request.pathname.startsWith(`/api/review/sessions/${sessionId}`)) {
      if (init?.method === "POST") {
        writes++;
        if (mode === "links") {
          const input = JSON.parse(String(init.body));
          const submissionId = `shortcut-fixture-${writes}`;
          snapshot.settlements.push({ submissionId, outcome: "completed" });
          snapshot.messages.push({
            id: `shortcut-user-${writes}`,
            submissionId,
            role: "user",
            metadata: { timestamp: new Date().toISOString(), revision: core.headSha ?? undefined },
            parts: [{ type: "text", text: input.body }],
          });
          return json({ submissionId });
        }
        throw new Error("Browser regression must never send a model request");
      }
      if (request.pathname.endsWith("/events")) {
        return new Response(
          new ReadableStream({
            start(controller) {
              snapshotStream = controller;
              controller.enqueue(
                new TextEncoder().encode(
                  `event: snapshot\ndata: ${JSON.stringify({ version: 0, snapshot })}\n\n`,
                ),
              );
              init?.signal?.addEventListener(
                "abort",
                () => {
                  if (snapshotStream === controller) snapshotStream = undefined;
                  try {
                    controller.close();
                  } catch {
                    /* already cancelled */
                  }
                },
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return json(snapshot);
    }
    if (request.pathname.endsWith("/prReview.source")) {
      const value = superjson.deserialize<{ sessionId: string; path: string; ref?: string }>(
        JSON.parse(request.searchParams.get("input") ?? "{}"),
      );
      if (value?.sessionId === sessionId) {
        sourceReads.push(value);
        return json({
          result: {
            data: {
              json: {
                path: value.path,
                content: Array.from({ length: line + 2 }, (_, i) => `fixture source ${i + 1}`).join(
                  "\n",
                ),
                ref: value.ref ?? core.headSha,
              },
            },
          },
        });
      }
    }
    if (request.pathname.endsWith("/pr.addComment")) {
      commentPosts.push(superjson.deserialize(JSON.parse(String(init?.body))));
      throw new Error("fixture comment rejected; no publish");
    }
    return originalFetch(input, init);
  };
  const waitFor = async (predicate: () => boolean, message: string) => {
    for (let frame = 0; frame < 180; frame++) {
      if (predicate()) return;
      await new Promise(requestAnimationFrame);
    }
    throw new Error(message);
  };
  const buttonFor = (label: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("#chat-panel button[title]")).find(
      (button) => button.closest(".my-5")?.textContent?.includes(`navigation-fixture-${label}`),
    );
  let passed = 0;
  try {
    document
      .querySelector<HTMLButtonElement>('dialog[open] button[aria-label="Close dialog"]')
      ?.click();
    url.searchParams.set("sessionId", sessionId);
    history.pushState(null, "", url);
    dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(
      () => !!buttonFor("current-visible"),
      "Real ChatPanel did not hydrate saved-session fixture",
    );
    if (mode === "inline" || mode === "dismissal") {
      const inlineCard = () =>
        Array.from(
          document
            .getElementById(getFileElementId(file.name))
            ?.querySelectorAll<HTMLElement>('[aria-label^="Prepare comment for"]') ?? [],
        ).find((card) => card.textContent?.includes("navigation-fixture-current-visible"));
      await waitFor(
        () => !!inlineCard(),
        "Current transcript annotation was not emitted into actual DiffViewer",
      );
      const cached = queryClient.getQueryData<
        Array<{ origin?: { sessionId: string; revision?: string } }>
      >(queryKeys.local.annotations(prUrl))!;
      if (
        !cached.length ||
        cached.some(
          (annotation) =>
            annotation.origin?.sessionId !== sessionId ||
            annotation.origin?.revision !== core.headSha,
        )
      )
        throw new Error("Active inline annotations lost transcript source revision/session");
      passed++;
      if (mode === "dismissal") {
        const settle = async () => {
          for (let i = 0; i < 12; i++) await new Promise(requestAnimationFrame);
        };
        let version = 0;
        const replay = async () => {
          await waitFor(() => !!snapshotStream, "Snapshot stream not attached");
          snapshotStream!.enqueue(
            new TextEncoder().encode(
              `event: snapshot\ndata: ${JSON.stringify({ version: ++version, snapshot })}\n\n`,
            ),
          );
          await settle();
        };
        inlineCard()!
          .querySelector<HTMLButtonElement>('[aria-label="Dismiss annotation"]')!
          .click();
        await waitFor(() => !inlineCard(), "Dismiss did not remove actual inline finding");
        await replay();
        if (inlineCard())
          throw new Error("Identical transcript snapshot resurrected dismissed finding");
        passed++;
        // Empty revision-filtered results must still clear every visible/cached annotation.
        for (const message of snapshot.messages)
          if (message.role === "assistant") message.metadata.revision = oldRef;
        await replay();
        if (queryClient.getQueryData<unknown[]>(queryKeys.local.annotations(prUrl))?.length)
          throw new Error("Dismissal reconciliation retained stale annotations on empty result");
        passed++;
        snapshot.messages[0].metadata.revision = core.headSha;
        await replay();
        if (inlineCard()) throw new Error("Revision filtering cleared dismissal history");
        passed++;
        const commit = core.commits[0];
        if (!commit || commit.sha === core.headSha)
          throw new Error("Dismissal revision fixture needs a non-head commit");
        const commitKey = queryKeys.pr.commitDiff(prUrl, commit.sha);
        const previousCommitDiff = queryClient.getQueryData<string>(commitKey);
        queryClient.setQueryData(commitKey, core.diff);
        try {
          snapshot.messages[0].metadata.revision = commit.sha;
          await replay();
          Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
            .find((button) => button.textContent?.startsWith("By commit ("))!
            .click();
          await waitFor(
            () => !!inlineCard(),
            "Dismissal leaked into a different source revision in the same session",
          );
          passed++;
        } finally {
          Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
            .find((button) => button.textContent?.trim() === "Full PR")
            ?.click();
          snapshot.messages[0].metadata.revision = core.headSha;
          await replay();
          if (previousCommitDiff !== undefined)
            queryClient.setQueryData(commitKey, previousCommitDiff);
          else queryClient.removeQueries({ queryKey: commitKey, exact: true });
        }
        if (inlineCard())
          throw new Error("Returning from another source revision lost original dismissal");
        passed++;
        const firstSession = sessionId;
        sessionId = `${firstSession}-other`;
        snapshot.sessionId = sessionId;
        snapshotStream = undefined;
        url.searchParams.set("sessionId", sessionId);
        history.pushState(null, "", url);
        dispatchEvent(new PopStateEvent("popstate"));
        await waitFor(
          () => !!inlineCard(),
          "Dismissal leaked into another session with identical finding content",
        );
        passed++;
        sessionId = firstSession;
        snapshot.sessionId = firstSession;
        snapshotStream = undefined;
        url.searchParams.set("sessionId", sessionId);
        history.pushState(null, "", url);
        dispatchEvent(new PopStateEvent("popstate"));
        await waitFor(() => !!snapshotStream, "Original session did not reconnect");
        await replay();
        if (inlineCard()) throw new Error("Dismissal was lost across session reconnect");
        passed++;
        if (writes || commentPosts.length) throw new Error("Dismissal test performed a mutation");
        return { passed, posts: 0, modelCalls: 0 };
      }
      inlineCard()!.click();
      const editor = () =>
        document
          .getElementById(getFileElementId(file.name))
          ?.querySelector<HTMLTextAreaElement>('textarea[placeholder="Write a comment..."]');
      await waitFor(() => !!editor(), "Inline body did not reach shared App preparation path");
      if (!editor()!.value.includes(`${file.name}:${line}`))
        throw new Error("Inline prefill lost full file reference");
      editor()!.form!.requestSubmit();
      await waitFor(
        () => commentPosts.length === 1,
        "Explicit inline form submission did not reach intercepted transport",
      );
      if (
        commentPosts[0].expectedHeadSha !== core.headSha ||
        commentPosts[0].line !== line ||
        commentPosts[0].filePath !== file.name
      )
        throw new Error("Inline submission lost validated coordinates/provenance");
      passed++;
      await waitFor(() => !editor()?.disabled, "Intercepted failure did not settle");
      Array.from(editor()!.form!.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.trim() === "Cancel")!
        .click();
      // Same message IDs, changed origin: this must invalidate annotations, not merge cached PR-wide findings.
      for (const message of snapshot.messages)
        if (message.role === "assistant") message.metadata.revision = oldRef;
      await waitFor(() => !!snapshotStream, "Snapshot stream was not attached");
      snapshotStream!.enqueue(
        new TextEncoder().encode(
          `event: snapshot\ndata: ${JSON.stringify({ version: 1, snapshot })}\n\n`,
        ),
      );
      await waitFor(
        () => !inlineCard(),
        "Historical-only transcript left stale current annotations in DiffViewer",
      );
      if (queryClient.getQueryData<unknown[]>(queryKeys.local.annotations(prUrl))?.length)
        throw new Error(
          "Empty revision-filtered transcript failed to replace persisted annotation cache",
        );
      passed++;
      const body = buttonFor("current-visible")!
        .closest(".my-5")!
        .querySelector<HTMLElement>(".whitespace-pre-wrap")!;
      body.click();
      await waitFor(
        () =>
          !!document
            .querySelector("[data-finding-comment-notice]")
            ?.textContent?.includes("historical"),
        "Historical transcript action did not explicitly reject current-line prefill",
      );
      if (editor() || commentPosts.length !== 1 || writes)
        throw new Error(
          "Historical inline/transcript transition created an unsafe draft or mutation",
        );
      passed++;
      return {
        passed,
        interceptedExplicitPosts: commentPosts.length,
        actualPosts: 0,
        modelCalls: writes,
      };
    }
    if (mode === "links") {
      const noComments = document.querySelectorAll('form[aria-label="New inline comment"]').length;
      const assertDiff = async (button: HTMLElement, label: string, targetLine = line) => {
        button.click();
        await new Promise(requestAnimationFrame);
        if (document.querySelector("dialog[open]"))
          throw new Error(`${label} opened a modal for current visible source`);
        await waitFor(
          () =>
            !!document
              .getElementById(getFileElementId(file.name))
              ?.querySelector("diffs-container")
              ?.shadowRoot?.querySelector(`[data-line="${targetLine}"][data-selected-line]`),
          `${label} did not focus code`,
        );
        if (
          document.querySelectorAll('form[aria-label="New inline comment"]').length !== noComments
        )
          throw new Error(`${label} incorrectly opened finding-prefill flow`);
        passed++;
      };
      const currentGroup = Array.from(
        document.querySelectorAll<HTMLElement>("#chat-panel .wrap-break-word"),
      ).find(
        (node) =>
          node.textContent?.includes("markdown-link-fixture") &&
          node.querySelector("[data-chat-file]"),
      )!;
      const token = currentGroup.querySelector<HTMLButtonElement>("button:not([data-chat-file])")!;
      await assertDiff(token, "ordinary FileLink token");
      const markdown = Array.from(
        currentGroup.querySelectorAll<HTMLElement>("[data-chat-file]"),
      ).find((button) => button.textContent === "markdown-link-fixture")!;
      await assertDiff(markdown, "ordinary markdown source link");
      const code = Array.from(currentGroup.querySelectorAll<HTMLElement>("[data-chat-file]")).find(
        (button) => button.textContent?.startsWith(file.name.split("/").pop()!),
      )!;
      await assertDiff(code, "ordinary inline-code source reference");
      const fileHost = document.getElementById(getFileElementId(file.name))!;
      if (
        fileHost.querySelector<HTMLElement>("diffs-container")?.dataset.expandedHead !==
        core.headSha
      ) {
        fileHost.querySelector<HTMLElement>(".hunk-sep")?.click();
        await waitFor(
          () =>
            fileHost.querySelector<HTMLElement>("diffs-container")?.dataset.expandedHead ===
            core.headSha,
          "Full-file read did not verify the displayed source head",
        );
      }
      for (
        let attempt = 0;
        attempt < 8 &&
        !fileHost
          .querySelector("diffs-container")
          ?.shadowRoot?.querySelector('[data-additions] [data-line="1"]');
        attempt++
      ) {
        fileHost.querySelector<HTMLElement>(".hunk-sep")?.click();
        for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame);
      }
      await waitFor(
        () =>
          !!fileHost
            .querySelector("diffs-container")
            ?.shadowRoot?.querySelector('[data-additions] [data-line="1"]'),
        "Unchanged context did not expand",
      );
      await assertDiff(
        currentGroup.querySelector<HTMLButtonElement>(`button[title="${file.name}:1"]`)!,
        "expanded unchanged source link",
        1,
      );
      const unsafe = Array.from(
        currentGroup.querySelectorAll<HTMLButtonElement>("button[title]"),
      ).find((button) => button.title.startsWith("../"))!;
      unsafe.click();
      await new Promise(requestAnimationFrame);
      if (
        !document
          .querySelector('#chat-panel [role="status"]')
          ?.parentElement?.textContent?.includes("unsafe") &&
        !document.querySelector("#chat-panel")?.textContent?.includes("ambiguous or unsafe")
      )
        throw new Error("Unresolved source links must explain ambiguity/unsafe paths");
      passed++;
      const selectionCard = (label: string) =>
        Array.from(
          document.querySelectorAll<HTMLElement>('[aria-label="Question about selected code"]'),
        ).find((node) => node.textContent?.includes(label))!;
      await assertDiff(
        selectionCard("selection-right-fixture").querySelector("button")!,
        "structured current selection link",
      );
      selectionCard("selection-left-fixture").querySelector<HTMLButtonElement>("button")!.click();
      await waitFor(
        () =>
          !!document.querySelector('[data-selection-source-side="LEFT"] [data-source-line="7"]'),
        "Previous-version selection link lost side/old line",
      );
      if (
        !document
          .querySelector('[data-selection-source-side="LEFT"]')
          ?.textContent?.includes("old version selection fixture") ||
        document.querySelectorAll('form[aria-label="New inline comment"]').length !== noComments
      )
        throw new Error("Previous selection must show exact captured old text without prefill");
      passed++;
      document
        .querySelector<HTMLButtonElement>('dialog[open] button[aria-label="Close dialog"]')!
        .click();
      const historicalGroup = Array.from(
        document.querySelectorAll<HTMLElement>("#chat-panel .wrap-break-word"),
      ).find(
        (node) =>
          node.textContent?.includes("Historical-link-fixture") && node.querySelector("button"),
      )!;
      historicalGroup.querySelector<HTMLButtonElement>("button")!.click();
      await waitFor(
        () => sourceReads.some((read) => read.ref === oldRef),
        "Historical code link lost source revision",
      );
      document
        .querySelector<HTMLButtonElement>('dialog[open] button[aria-label="Close dialog"]')!
        .click();
      passed++;
      const input = document.querySelector<HTMLTextAreaElement>(
        '[aria-label="Message review assistant"]',
      )!;
      input.value = "CmdEnter chat fixture";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitFor(
        () => writes === 1 && !input.disabled,
        "Cmd+Enter chat did not submit exactly once/settle through MessageForm",
      );
      input.value = "Keep shortcut-excluded draft";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: true,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: true,
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await new Promise(requestAnimationFrame);
      if (writes !== 1 || input.value !== "Keep shortcut-excluded draft" || commentPosts.length)
        throw new Error("Chat shortcut exclusions or navigation/prefill distinction regressed");
      passed++;
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      await waitFor(
        () => writes === 2 && !input.disabled,
        "Ordinary Enter-to-send must remain a native MessageForm submission",
      );
      passed++;
      return {
        passed,
        chain: "markdown/FileLink/SelectionQuestionMessage → ChatPanel → App → correct source side",
        interceptedChatSubmissions: writes,
        paidModelCalls: 0,
        commentPosts: commentPosts.length,
      };
    }
    if (mode === "prefill") {
      const bodyClick = (label: string) => {
        getSelection()?.removeAllRanges();
        buttonFor(label)!
          .closest(".my-5")!
          .querySelector<HTMLElement>(".whitespace-pre-wrap")!
          .click();
      };
      const nativeEditor = () =>
        document
          .getElementById(getFileElementId(file.name))
          ?.querySelector<HTMLTextAreaElement>('textarea[placeholder="Write a comment..."]');
      bodyClick("current-visible");
      await waitFor(
        () => !!nativeEditor(),
        "Finding body click failed to open inline prefilled comment editor",
      );
      const expected = formatAnnotationForComment({
        id: "fixture",
        file: file.name,
        line,
        severity: "critical",
        message: "navigation-fixture-current-visible",
      });
      if (nativeEditor()!.value !== expected || document.querySelector("dialog[open]"))
        throw new Error(
          "Finding prefill must contain full path/body at current line without a modal",
        );
      passed++;
      if (document.activeElement !== nativeEditor())
        await waitFor(
          () => document.activeElement === nativeEditor(),
          "Inline comment textarea must receive focus",
        );
      passed++;
      nativeEditor()!.value = "User-edited finding draft";
      nativeEditor()!.dispatchEvent(new InputEvent("input", { bubbles: true }));
      bodyClick("current-unchanged");
      await waitFor(
        () =>
          !!document.querySelector(
            '[data-inline-finding-comment] textarea[placeholder="Write a comment..."]',
          ),
        "Out-of-hunk finding must load source and open editor inline",
      );
      const inline = () => document.querySelector<HTMLElement>("[data-inline-finding-comment]")!;
      await waitFor(
        () => inline().getAttribute("data-source-ready") === "true",
        "Pinned inline source did not validate",
      );
      if (
        inline().getAttribute("data-file") !== file.name ||
        inline().getAttribute("data-line") !== "1" ||
        inline().getAttribute("data-side") !== "RIGHT" ||
        document.querySelector("dialog[open]")
      )
        throw new Error("Unchanged prefill location/side must be exact and non-modal");
      passed++;
      const inlineEditor = inline().querySelector<HTMLTextAreaElement>("textarea")!;
      inlineEditor.value = "User-edited unchanged draft";
      inlineEditor.dispatchEvent(new InputEvent("input", { bubbles: true }));
      bodyClick("current-visible");
      await waitFor(() => !!nativeEditor(), "Native editor missing after switching finding");
      if (nativeEditor()!.value !== "User-edited finding draft")
        throw new Error("Switching findings destroyed native draft");
      passed++;
      const originalCopy = navigator.clipboard.writeText;
      let copies = 0;
      navigator.clipboard.writeText = async () => {
        copies++;
      };
      try {
        buttonFor("historical-visible")!
          .closest(".my-5")!
          .querySelector<HTMLButtonElement>('[aria-label="Copy finding"]')!
          .click();
        await Promise.resolve();
      } finally {
        navigator.clipboard.writeText = originalCopy;
      }
      if (
        copies !== 1 ||
        document
          .querySelector("[data-finding-comment-notice]")
          ?.textContent?.includes("historical") ||
        nativeEditor()!.value !== "User-edited finding draft"
      )
        throw new Error("Copy bubbled into finding-prefill action");
      passed++;
      bodyClick("current-unchanged");
      await waitFor(
        () => !!document.querySelector("[data-inline-finding-comment] textarea"),
        "Inline editor missing on return",
      );
      if (
        inline().querySelector<HTMLTextAreaElement>("textarea")!.value !==
        "User-edited unchanged draft"
      )
        throw new Error("Switching findings destroyed unchanged draft");
      passed++;
      bodyClick("historical-visible");
      await new Promise(requestAnimationFrame);
      if (
        !document
          .querySelector("[data-finding-comment-notice]")
          ?.textContent?.includes("historical") ||
        document.querySelector("dialog[open]")
      )
        throw new Error(
          "Historical finding must be explicitly blocked, not mapped to a current-line editor/modal",
        );
      passed++;
      bodyClick("unavailable-file");
      await waitFor(
        () =>
          document.querySelector("[data-inline-finding-comment]")?.getAttribute("data-file") ===
          "unchanged-only.ts",
        "Unchanged files must load inline, not open modal",
      );
      await waitFor(
        () =>
          document
            .querySelector("[data-inline-finding-comment]")
            ?.getAttribute("data-source-ready") === "true",
        "Full-file source must validate before enabling submission",
      );
      passed++;
      if (writes) throw new Error("Finding actions auto-published");
      if (commentPosts.length)
        throw new Error("Finding actions published without explicit submission");
      bodyClick("current-visible");
      await waitFor(() => !!nativeEditor(), "Editor missing for explicit-submit transport test");
      nativeEditor()!.form!.requestSubmit();
      await waitFor(
        () => commentPosts.length === 1,
        "Explicit comment submission did not reach guarded transport",
      );
      const post = commentPosts[0];
      if (
        post.filePath !== file.name ||
        post.line !== line ||
        post.side !== "RIGHT" ||
        post.body !== "User-edited finding draft" ||
        post.expectedHeadSha !== core.headSha
      )
        throw new Error("Comment transport lost full path/line/side/body/revision");
      await waitFor(
        () => !!nativeEditor()?.closest("form")?.textContent?.includes("fixture comment rejected"),
        "Failed explicit post must retain a visible error",
      );
      if (nativeEditor()!.value !== "User-edited finding draft")
        throw new Error("Failed comment post dropped user draft");
      passed++;
      return {
        passed,
        chain: "finding body → ChatPanel → App → inline PR comment",
        autoPublishes: 0,
        interceptedExplicitPosts: commentPosts.length,
        modelCalls: writes,
      };
    }
    for (const fixture of fixtures) {
      // A prior links run may have expanded unchanged context into the visible diff.
      const expandedCurrent =
        fixture.ref === core.headSha &&
        fixture.path === file.name &&
        document
          .getElementById(getFileElementId(file.name))
          ?.querySelector<HTMLElement>("diffs-container")?.dataset.expandedHead === core.headSha &&
        !!document
          .getElementById(getFileElementId(file.name))
          ?.querySelector("diffs-container")
          ?.shadowRoot?.querySelector(`[data-additions] [data-line="${fixture.line}"]`);
      buttonFor(fixture.label)!.click();
      if (fixture.expected === "diff" || expandedCurrent) {
        await new Promise(requestAnimationFrame);
        if (document.querySelector("dialog[open]"))
          throw new Error(
            "Current-revision visible annotation opened a source modal instead of focusing the diff",
          );
        await waitFor(
          () =>
            !!document
              .getElementById(getFileElementId(file.name))
              ?.querySelector("diffs-container")
              ?.shadowRoot?.querySelector(`[data-line="${fixture.line}"][data-selected-line]`),
          "Real FileDiffView did not focus the current annotation row",
        );
        if (sourceReads.length) throw new Error("Current annotation must not fetch modal source");
      } else {
        await waitFor(
          () => !!document.querySelector("dialog[open]"),
          `${fixture.label} must retain legitimate source fallback`,
        );
        await waitFor(
          () => sourceReads.some((read) => read.path === fixture.path && read.ref === fixture.ref),
          `${fixture.label} lost originating source revision/session`,
        );
        document
          .querySelector<HTMLButtonElement>('dialog[open] button[aria-label="Close dialog"]')!
          .click();
      }
      passed++;
    }
    if (writes) throw new Error("Unexpected model submission");
    return {
      passed,
      chain: "AnnotationBlock → ChatPanel → App → FileDiffView/SourceDialog",
      sourceReads: sourceReads.length,
      modelCalls: writes,
    };
  } finally {
    if (mode === "dismissal") {
      const key = queryKeys.local.annotationDismissals(prUrl);
      const records = queryClient.getQueryData<string[]>(key) ?? [];
      // Remove only this run's synthetic tombstones, preserving all real-user dismissals.
      queryClient.setQueryData(
        key,
        records.filter((record) => {
          const [sourceSession] = JSON.parse(record);
          return (
            sourceSession !== fixtureSessionId && sourceSession !== `${fixtureSessionId}-other`
          );
        }),
      );
    }
    if (mode === "prefill" || mode === "inline") {
      const editor = document
        .getElementById(getFileElementId(file.name))
        ?.querySelector<HTMLTextAreaElement>('textarea[placeholder="Write a comment..."]');
      if (
        editor &&
        (editor.value === "User-edited finding draft" ||
          editor.value.includes("navigation-fixture-"))
      ) {
        Array.from(editor.form?.querySelectorAll<HTMLButtonElement>("button") ?? [])
          .find((button) => button.textContent?.trim() === "Cancel")
          ?.click();
      }
    }
    document
      .querySelector<HTMLButtonElement>('dialog[open] button[aria-label="Close dialog"]')
      ?.click();
    history.replaceState(null, "", originalUrl);
    dispatchEvent(new PopStateEvent("popstate"));
    window.fetch = originalFetch;
    const input = document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Message review assistant"]',
    );
    if (input) {
      input.value = originalInput;
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
  }
}
