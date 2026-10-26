import { render } from "solid-js/web";

import type { ResolvedSource } from "@better-review/shared";

import { InlineSourceView } from "../components/InlineSourceView";
import type { SelectedSource } from "../lib/ask-ai-selection";
import { createSourceNavigation, type SourceWindow } from "../lib/review-interactions";
import { createAssertions } from "./assertions";
import { askSourceRows, sourceWindow } from "./source-fixture";

declare global {
  interface Window {
    resolveBrowserSourceWindow: (content: string, range: SourceWindow) => Promise<ResolvedSource>;
  }
}

export async function testActualResolverSourceLineBoundsInBrowser() {
  const assertions = createAssertions(3000);
  const { check, wait, result } = assertions;
  const cases = [
    {
      name: "interior",
      content: Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join("\n"),
      first: 1,
      last: 200,
      blank: [],
    },
    {
      name: "interior blank boundary",
      content:
        Array.from({ length: 600 }, (_, i) => (i === 448 ? "" : `line ${i + 1}`)).join("\n") + "\n",
      first: 250,
      last: 449,
      blank: [449],
    },
    { name: "newline EOF", content: "first\nlast\n", first: 1, last: 2, blank: [] },
    { name: "genuine blanks", content: "first\n\nlast\n\n", first: 1, last: 4, blank: [2, 4] },
    { name: "empty file", content: "", first: 1, last: 1, blank: [1] },
    { name: "single newline", content: "\n", first: 1, last: 1, blank: [1] },
    { name: "CRLF blank", content: "first\r\n\r\nlast\r\n", first: 1, last: 3, blank: [2] },
  ];
  for (const fixture of cases) {
    const host = document.createElement("div");
    host.style.cssText =
      "position:fixed;inset:10px;overflow:auto;background:var(--color-bg);z-index:20";
    document.body.append(host);
    const selections: SelectedSource[] = [];
    const navigation = createSourceNavigation(
      () => "contract",
      async (_target, range) => {
        const actual = await window.resolveBrowserSourceWindow(fixture.content, range);
        check(actual.status === "found", `${fixture.name}: real backend did not find source`);
        if (actual.status === "found") {
          const expected = sourceWindow(fixture.content, range);
          check(
            Object.entries(expected).every(
              ([key, value]) => actual[key as keyof typeof actual] === value,
            ),
            `${fixture.name}: mock newline/count contract differs from actual resolver`,
          );
        }
        return actual;
      },
    );
    const target = {
      sessionId: "contract",
      path: "src/contract.ts",
      ref: "a".repeat(40),
      side: "RIGHT" as const,
      line: fixture.first === 1 ? 1 : fixture.first + 100,
    };
    const dispose = render(
      () => (
        <InlineSourceView
          target={target}
          navigation={navigation}
          onClose={navigation.close}
          onChoose={() => {}}
          onResolved={() => {}}
          onAskAi={(selection) => selections.push(selection)}
        />
      ),
      host,
    );
    try {
      await navigation.openSource(target);
      await wait(
        () => !!host.querySelector('[data-source-ready="true"]'),
        "Actual source not rendered",
      );
      const rows = Array.from(host.querySelectorAll<HTMLElement>("[data-source-line]"));
      check(
        rows.length === fixture.last - fixture.first + 1,
        `${fixture.name}: expected ${fixture.last - fixture.first + 1} real rows, rendered ${rows.length}`,
      );
      check(
        rows.every((row, index) => Number(row.dataset.sourceLine) === fixture.first + index),
        `${fixture.name}: fabricated absolute line label`,
      );
      check(
        !host.querySelector(`[data-source-line="${fixture.last + 1}"]`),
        `${fixture.name}: phantom row after supplied bounds`,
      );
      for (const line of fixture.blank)
        check(
          host.querySelector(`[data-source-line="${line}"] code`)?.textContent === "",
          `${fixture.name}: genuine blank line ${line} lost`,
        );
      if (fixture.last > 1) {
        // Include every valid row (including blank lines) in a real DOM selection.
        await askSourceRows(assertions, host, fixture.first, fixture.last);
        const selection = selections.at(-1);
        check(
          selection?.startLine === fixture.first && selection?.endLine === fixture.last,
          `${fixture.name}: valid selection could not ask about all rows`,
        );
        const expectedText = fixture.content
          .split(/\r?\n/)
          .slice(fixture.first - 1, fixture.last)
          .join("\n");
        check(
          selection?.text === expectedText,
          `${fixture.name}: selection altered genuine blank lines`,
        );
      } else {
        // An empty quote intentionally has no Ask action, but its line remains real.
        check(
          navigation.presentation()?.startLine === 1 && navigation.presentation()?.endLine === 1,
          `${fixture.name}: empty file bounds changed`,
        );
      }
    } finally {
      dispose();
      navigation.close();
      host.remove();
      getSelection()?.removeAllRanges();
    }
  }
  return result();
}
