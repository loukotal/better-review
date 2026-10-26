import { render } from "solid-js/web";

import { SelectionQuestionMessage } from "../components/SelectionQuestionMessage";
import { formatSelectionQuestion } from "../lib/ask-ai-selection";
import { createAssertions } from "./assertions";

declare global {
  interface Window {
    captureBrowserLayout?: (name: string) => Promise<void>;
  }
}

/** Geometry assertions are the regression oracle; PNGs are review artifacts, not pixel baselines. */
export async function testNarrowChatLayoutInBrowser() {
  const { check, result } = createAssertions(3000);
  const host = document.createElement("div");
  host.id = "browser-layout-capture";
  host.className = "bg-bg p-3 text-sm text-text";
  host.style.width = "240px";
  document.body.append(host);
  const source = formatSelectionQuestion(
    {
      draftId: "layout-fixture",
      scope: "offline",
      file: "deeply/nested/very-long-directory-name/VeryLongSelectedSourceFileName.tsx",
      side: "LEFT",
      startLine: 120,
      endLine: 127,
      revision: "a".repeat(40),
      text: Array.from(
        { length: 8 },
        (_, i) => `${i + 1}: const value = "${"long source ".repeat(12)}";`,
      ).join("\n"),
    },
    "Why does this preserve the previous source version?\nKeep the complete question visible.",
  );
  const dispose = render(
    () => (
      <div class="space-y-4">
        <SelectionQuestionMessage
          content={"Ordinary chat message with a long reference: " + "unbroken".repeat(35)}
          onNavigate={() => {}}
        />
        <SelectionQuestionMessage content={source} onNavigate={() => {}} />
      </div>
    ),
    host,
  );
  try {
    for (const width of [240, 320, 600]) {
      host.style.width = `${width}px`;
      for (const expanded of [false, true]) {
        const toggle = host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
        if (toggle.getAttribute("aria-expanded") !== String(expanded)) toggle.click();
        await document.fonts.ready;
        await new Promise(requestAnimationFrame);
        const pre = host.querySelector("pre")!;
        check(host.scrollWidth <= host.clientWidth, `${width}px: transcript must not overflow`);
        check(
          pre.getBoundingClientRect().right <= host.getBoundingClientRect().right,
          `${width}px: source stays within transcript`,
        );
        check(
          pre.scrollWidth > pre.clientWidth && getComputedStyle(pre).overflowX === "auto",
          "long source scrolls locally rather than widening chat",
        );
        check(
          pre.querySelectorAll('[aria-hidden="true"]').length === (expanded ? 8 : 6),
          "expansion retains correct source line count",
        );
        await window.captureBrowserLayout?.(`chat-${width}-${expanded ? "expanded" : "collapsed"}`);
      }
    }
    return result();
  } finally {
    dispose();
    host.remove();
  }
}
