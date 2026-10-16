import { githubPrScope, githubWrites } from "../lib/github-writes";
import { api, type PrExtrasData } from "../lib/query";
import { mountAppFixture } from "./mount-app";

/** Real App, outbox polling, Pierre source DOM and anchored editor; all HTTP is fixtured. */
export async function testAppDelayedSelectionInBrowser(activate?: () => Promise<void>) {
  let passed = 0;
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    passed++;
  };
  const settle = async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  };
  let polls = 0;
  let extras: PrExtrasData = { comments: [], issueComments: [], status: null };
  const scope = githubPrScope("https://github.com/browser-fixture/isolated/pull/1");
  await mountAppFixture({
    procedures: {
      "pr.extras": () => extras,
      "githubOutbox.snapshot": () => {
        polls++;
        return { scope, revision: 0, operations: [] };
      },
    },
  });
  await githubWrites.recover(scope);
  // Let initial source highlighting and queued annotation renders finish.
  for (let frame = 0; frame < 15; frame++) await settle();
  const findRow = () =>
    document
      .querySelector("diffs-container")
      ?.shadowRoot?.querySelector('[data-additions] [data-line="9"]');
  for (let frame = 0; frame < 180 && !findRow(); frame++) await settle();
  const row = findRow()!;
  const range = document.createRange();
  const text = document.createTreeWalker(row, NodeFilter.SHOW_TEXT).nextNode()!;
  range.selectNodeContents(text);
  getSelection()!.removeAllRanges();
  getSelection()!.addRange(range);
  row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, composed: true }));
  await settle();
  const bubble = () => document.querySelector<HTMLElement>('[aria-label="Selection actions"]');
  check(bubble()?.matches(":popover-open"), "Actual diff selection must offer Ask AI");
  const before = polls;
  await githubWrites.recover(scope);
  await settle();
  check(polls > before, "Must force an actual App outbox refresh");
  check(bubble(), "Unchanged outbox refresh must not dismiss Ask AI");
  check(text.isConnected, "Unchanged outbox refresh must not force a source rerender");
  // Cross the production 2-second polling period, rather than only a synthetic refresh.
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await settle();
  check(polls > before + 1, "Must exercise production outbox polling while idle");
  check(bubble(), "Ask AI must remain usable after idle polling");
  check(text.isConnected, "Unchanged transcript polling must not force a source rerender");
  extras = {
    comments: [
      {
        id: 1,
        node_id: "fixture-inline-1",
        canEdit: false,
        path: "src/example.ts",
        line: 9,
        original_line: 9,
        side: "RIGHT",
        body: "A newly fetched inline comment",
        html_url: `${scope.url}#discussion_r1`,
        user: { login: "browser-fixture", avatar_url: "" },
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
    issueComments: [],
    status: null,
  };
  await api.fetchPrExtras(scope.url);
  await settle();
  check(!text.isConnected, "Changed comments must exercise a genuine source DOM replacement");
  check(bubble(), "Genuine annotation refresh must preserve the captured selection");
  if (activate) await activate();
  else bubble()!.querySelector<HTMLButtonElement>("button")!.click();
  await settle();
  const editor = document.querySelector('[aria-label="Ask about selection"]');
  check(editor, "Delayed Ask AI must open the anchored editor");
  const disclosure = [...editor!.querySelectorAll("summary")].find((node) =>
    node.textContent?.includes("Selected code"),
  );
  disclosure?.click();
  check(
    editor!.querySelector("pre")?.textContent === "new",
    "Delayed editor must retain exact original text",
  );
  check(editor!.querySelector('[title="src/example.ts"]'), "Delayed editor must retain file");
  check(editor!.textContent?.includes("Line 9"), "Delayed editor must retain original coordinates");
  check(
    editor!.querySelector(`p[title="${"a".repeat(40)}"]`),
    "Delayed editor must retain original revision",
  );
  return { passed };
}

export async function testSourceDelayedSelectionInBrowser() {
  let passed = 0;
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    passed++;
  };
  const settle = async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  };
  const ref = "c".repeat(40);
  await mountAppFixture({
    procedures: {
      "prReview.source": () => ({ content: "original source text\nsecond line", ref }),
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  let asked: { selection: SelectedSource; revision: string } | undefined;
  const dispose = render(
    () => (
      <SourceDialog
        target={{ sessionId: "bootstrap", path: "src/history.ts", ref }}
        onClose={() => {}}
        onAskAi={(selection, _anchor, revision) => {
          asked = { selection, revision };
        }}
      />
    ),
    host,
  );
  try {
    const row = () => document.querySelector('dialog code[data-source-line="1"]');
    for (let frame = 0; frame < 180 && !row(); frame++) await settle();
    await settle();
    const select = (end = 8) => {
      const range = document.createRange();
      range.setStart(row()!.firstChild!, 0);
      range.setEnd(row()!.firstChild!, end);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      row()!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    };
    const bubble = () => document.querySelector<HTMLElement>('[aria-label="Selection actions"]');
    select();
    await settle();
    check(bubble(), "Historical source selection must offer Ask AI");
    row()!.replaceChildren(document.createTextNode("original source text"));
    await settle();
    await githubWrites.recover(githubPrScope("https://github.com/browser-fixture/isolated/pull/1"));
    await settle();
    check(bubble(), "Historical source candidate must survive identical DOM and App refresh");
    bubble()!.querySelector<HTMLButtonElement>("button")!.click();
    check(
      asked?.selection.text === "original",
      "Delayed source action must retain partial text exactly",
    );
    check(
      asked?.selection.startLine === 1 &&
        asked.selection.endLine === 1 &&
        asked.selection.file === "src/history.ts" &&
        asked.revision === ref,
      "Delayed source action must retain original coordinates and revision",
    );
    select();
    await settle();
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    check(!bubble(), "Explicit outside pointer must dismiss source candidate");
    select();
    await settle();
    const range = document.createRange();
    range.setStart(row()!.firstChild!, 0);
    range.setEnd(row()!.firstChild!, 3);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    await settle();
    check(!bubble(), "A new native source selection must invalidate the previous snapshot");
    select();
    await settle();
    row()!.replaceChildren(document.createTextNode("different source text"));
    await settle();
    check(!bubble(), "Changed source text must invalidate the captured anchor");
    return { passed };
  } finally {
    dispose();
    host.remove();
    getSelection()?.removeAllRanges();
  }
}
import { render } from "solid-js/web";

import { SourceDialog } from "../components/SourceDialog";
import type { SelectedSource } from "../lib/ask-ai-selection";
