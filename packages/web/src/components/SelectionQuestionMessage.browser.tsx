/** Run via Vite in a real browser: no model calls, source APIs, or comment composer. */
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

import { formatSelectionQuestion } from "../lib/ask-ai-selection";
import type { SelectionSourceContext } from "../lib/selection-question-message";
import { SelectionQuestionMessage } from "./SelectionQuestionMessage";

export async function testSelectionQuestionMessageInBrowser() {
  const source = {
    file: "packages/very/long/path/with/components/SelectedCode.tsx",
    side: "LEFT" as const,
    startLine: 120,
    endLine: 128,
    revision: "0123456789abcdef0123456789abcdef01234567",
    text: '<img src=x onerror="throw 1">\n  second\n\nfour\nfive\nsix\nseven\neight\nnine',
  };
  const raw = formatSelectionQuestion(
    { ...source, draftId: "draft", scope: "scope" },
    "Why?\n<script>bad()</script>",
  );
  const [content, setContent] = createSignal(raw);
  const calls: SelectionSourceContext[] = [];
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;top:10px;left:10px;width:240px;background:var(--color-bg)";
  document.body.append(host);
  const dispose = render(
    () => (
      <SelectionQuestionMessage
        content={content()}
        onNavigate={(selection) => calls.push(selection)}
      />
    ),
    host,
  );
  let passed = 0;
  const check = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message);
    passed++;
  };
  try {
    await new Promise(requestAnimationFrame);
    check(!host.querySelector("img,script"), "source and question must remain inert text");
    check(
      host.querySelector("p")?.textContent === "Why?\n<script>bad()</script>",
      "question preserves newlines",
    );
    const link = host.querySelector<HTMLButtonElement>("button[title]")!;
    check(link.title === `${source.file}:120–128`, "full path and range remain discoverable");
    check(
      link.textContent?.includes("SelectedCode.tsx") && link.textContent.includes("120–128"),
      "compact basename includes full range",
    );
    check(
      !host.textContent?.includes("LEFT") && !host.textContent?.includes("RIGHT"),
      "no diff-side jargon",
    );
    check(host.textContent?.includes("Previous version"), "old source is identified");
    link.click();
    check(
      JSON.stringify(calls) === JSON.stringify([source]),
      "navigation receives exact version, side, path and range",
    );
    const preview = host.querySelector("pre")!;
    check(
      preview.querySelectorAll('[aria-hidden="true"]').length === 6,
      "preview has six numbered lines",
    );
    check(!preview.textContent?.includes("seven"), "preview is compact");
    const toggle = host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    toggle.click();
    check(toggle.getAttribute("aria-expanded") === "true", "expansion is accessible");
    check(preview.textContent?.includes("nine"), "entire source available on expansion");
    check(
      preview.querySelectorAll('[aria-hidden="true"]').length === 9,
      "expanded line numbers preserved",
    );
    toggle.click();
    check(!preview.textContent?.includes("seven"), "collapse restores short preview");
    for (const width of [240, 320, 600]) {
      host.style.width = `${width}px`;
      await new Promise(requestAnimationFrame);
      check(
        host.scrollWidth <= host.clientWidth,
        `${width}px: code must not overflow the transcript`,
      );
    }
    for (const fallback of ["Ordinary\nmessage <b>literal</b>", raw + "\nDo not hide this."]) {
      setContent(fallback);
      check(host.textContent === fallback, "unrecognized messages preserve every character");
      check(!host.querySelector("button"), "fallback must not fabricate a source link");
    }
    setContent(raw);
    check(
      host.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded") === "false",
      "new message resets expansion",
    );
    return { passed, navigation: calls };
  } finally {
    dispose();
    host.remove();
  }
}
