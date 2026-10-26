/** Browser-only regression checks; run via Vite import(...).testSelectionInBrowser(). */
import { FileDiff, parseDiffFromFile, parsePatchFiles } from "@pierre/diffs";

import { createAssertions } from "../browser-tests/assertions";
import { extractLines, extractTextSelection } from "./ask-ai-selection";

export function testSelectionInBrowser() {
  const { check, result } = createAssertions(3000);
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const file = parsePatchFiles(
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n",
  )[0]!.files[0]!;
  root.innerHTML =
    '<code data-code data-deletions><div data-line="1" data-line-type="change-deletion">old</div></code><code data-code data-additions><div data-line="1" data-line-type="change-addition"><span>ne</span><span>w</span></div><div data-line="2" data-line-type="context"> context</div></code>';
  const selection = window.getSelection()!;
  const left = root.querySelector("[data-deletions] [data-line]")!;
  const rows = root.querySelectorAll("[data-additions] [data-line]");
  const first = rows[0]!.firstChild!.firstChild!;
  const last = rows[0]!.lastChild!.firstChild!;
  function range(start: Node, from: number, end: Node, to: number) {
    selection.removeAllRanges();
    const value = document.createRange();
    value.setStart(start, from);
    value.setEnd(end, to);
    selection.addRange(value);
  }
  function rejects(message: string) {
    let threw = false;
    try {
      extractTextSelection(root, file);
    } catch {
      threw = true;
    }
    check(threw, message);
  }
  try {
    range(first, 1, last, 1);
    check(extractTextSelection(root, file)?.text === "ew", "exact partial syntax-token selection");
    selection.setBaseAndExtent(last, 1, first, 1);
    check(extractTextSelection(root, file)?.text === "ew", "backward shadow selection");
    range(first, 0, rows[1]!.firstChild!, 4);
    const multi = extractTextSelection(root, file);
    check(
      multi?.text === "new\n con" && multi.endLine === 2,
      "multiline selection and side coordinates",
    );
    range(left.firstChild!, 0, last, 1);
    rejects("reject mixed-side range");
    const outside = document.createTextNode("outside");
    host.append(outside);
    selection.setBaseAndExtent(first, 0, outside, 4);
    // Chromium can collapse an impossible cross-shadow-root native selection.
    // Either null or an explicit validation error rejects it; neither may quote text.
    let crossRootRejected = false;
    try {
      crossRootRejected = extractTextSelection(root, file) === null;
    } catch {
      crossRootRejected = true;
    }
    check(crossRootRejected, "reject cross-file/root range");
    range(first, 0, rows[1]!.firstChild!, 4);
    rows[1]!.setAttribute("data-line", "8");
    rejects("reject virtualized/unloaded gap");
    rows[1]!.setAttribute("data-line", "2");
    root.querySelector("[data-additions]")!.removeAttribute("data-additions");
    rows[0]!.setAttribute("data-line-type", "context");
    range(first, 0, last, 1);
    rejects("reject ambiguous unified context side");
    selection.removeAllRanges();
    check(extractTextSelection(root, file) === null, "collapsed selection is no action");
    return result();
  } finally {
    selection.removeAllRanges();
    host.remove();
  }
}

/** Render Pierre's real expanded source, not hand-authored DOM, in both layouts. */
export async function testExpandedSelectionInBrowser() {
  const { check, wait, result } = createAssertions(2000);
  const oldLines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);
  const newLines = [...oldLines];
  newLines[14] = "changed 15";
  newLines[44] = "changed 45";
  const file = parseDiffFromFile(
    { name: "a.ts", contents: oldLines.join("\n") },
    { name: "a.ts", contents: newLines.join("\n") },
  );
  for (const diffStyle of ["split", "unified"] as const) {
    const host = document.createElement("div");
    document.body.append(host);
    const diff = new FileDiff({ diffStyle, expandUnchanged: true, disableFileHeader: true });
    try {
      diff.render({ fileDiff: file, containerWrapper: host });
      await wait(
        () =>
          !!host.querySelector("diffs-container")?.shadowRoot?.querySelector('[data-line="60"]'),
        `${diffStyle}: expanded line 60 not rendered`,
      );
      const root = host.querySelector("diffs-container")?.shadowRoot;
      check(root, `${diffStyle}: no rendered shadow root`);
      for (const line of [1, 30, 60]) {
        for (const side of ["LEFT", "RIGHT"] as const) {
          const column =
            diffStyle === "split" ? `[data-${side === "LEFT" ? "deletions" : "additions"}] ` : "";
          const row = root!.querySelector(`${column}[data-line="${line}"]`);
          check(row, `${diffStyle}: expanded line ${line} not rendered`);
          const gutter = extractLines(file, side, line, line);
          check(gutter.text === `line ${line}`, `${diffStyle}: incorrect gutter source`);
          const range = document.createRange();
          range.selectNodeContents(row!);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
          if (diffStyle === "split") {
            const text = extractTextSelection(root!, file);
            check(
              !(text?.text !== `line ${line}` || text.side !== side || text.startLine !== line),
              `split: incorrect expanded ${side} text at line ${line}`,
            );
          } else {
            let rejected = false;
            try {
              extractTextSelection(root!, file);
            } catch {
              rejected = true;
            }
            check(rejected, "unified context must keep its explicit gutter-only side rule");
          }
        }
      }
    } finally {
      window.getSelection()?.removeAllRanges();
      diff.cleanUp();
      host.remove();
    }
  }
  return result();
}
