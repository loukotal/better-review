import assert from "node:assert/strict";
import test from "node:test";

import { DiffHunksRenderer, parseDiffFromFile, parsePatchFiles } from "@pierre/diffs";

import { centerFocusRow, focusRenderedLine, focusRowSelector } from "./focus-line";

const file = parsePatchFiles(`diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -373,3 +373,3 @@
 before
-old
+new
 after
`)[0]!.files[0]!;

test("focuses the rendered changed row after a 372-line collapsed gap, not logical index * 20", async () => {
  const renderer = new DiffHunksRenderer({ diffStyle: "split" });
  const result = await renderer.asyncRender(file);
  const html = renderer.renderFullHTML(result);
  assert.match(html, /data-line="374"/);
  assert.match(html, /data-line-index="374,373"/);
  const scrolls: number[] = [];
  const cancel = focusRenderedLine({
    findRow: () => ({ getBoundingClientRect: () => ({ top: 92, height: 20 }) }),
    center: (row) => scrolls.push(row.getBoundingClientRect().top),
    renderAll: () => assert.fail("already rendered"),
    failed: () => assert.fail("target exists"),
  });
  assert.deepEqual(scrolls, [92]);
  cancel();
  renderer.cleanUp();
});

test("same line on both sides uses the requested column and logical row identity", async () => {
  for (const diffStyle of ["split", "unified"] as const) {
    const renderer = new DiffHunksRenderer({ diffStyle });
    const result = await renderer.asyncRender(file);
    const html = renderer.renderFullHTML(result);
    assert.match(html, /data-line-index="373,373"/);
    assert.match(html, /data-line-index="374,373"/);
    const selector = focusRowSelector([374, 373], "additions", 374);
    assert.ok(selector.includes("[data-additions]"));
    assert.ok(!selector.includes("[data-deletions]"));
    assert.ok(selector.includes('[data-line-index="374,373"]'));
    renderer.cleanUp();
  }
});

test("centering uses measured annotation/expanded-context heights and scroll-container position", () => {
  let top = 0;
  centerFocusRow(
    { getBoundingClientRect: () => ({ top: 592, height: 24 }) },
    {
      scrollTop: 1000,
      clientHeight: 600,
      clientTop: 2,
      getBoundingClientRect: () => ({ top: 100 }),
      scrollTo: (options) => {
        top = options.top;
      },
    },
  );
  assert.equal(top, 1202);
});

test("retries delayed rendering, settles layout, and stops after success", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let available = false;
  let fallback = 0;
  let centered = 0;
  focusRenderedLine({
    findRow: () => (available ? {} : undefined),
    center: () => {
      centered++;
    },
    renderAll: () => {
      fallback++;
    },
    failed: () => assert.fail("late row exists"),
  });
  for (let i = 0; i < 8; i++) t.mock.timers.tick(32);
  available = true;
  for (let i = 0; i < 60; i++) t.mock.timers.tick(32);
  assert.equal(fallback, 1);
  assert.equal(centered, 3);
});

test("missing target reports failure once; cancellation suppresses pending work", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let failures = 0;
  const start = () =>
    focusRenderedLine({
      findRow: () => undefined,
      center: () => assert.fail("must not select the other side"),
      renderAll: () => {},
      failed: () => {
        failures++;
      },
    });
  start()();
  start();
  for (let i = 0; i < 100; i++) t.mock.timers.tick(32);
  assert.equal(failures, 1);
});

test("full rendering retains manually expanded leading context and annotation rows in both styles", async () => {
  const oldLines = Array.from({ length: 400 }, (_, i) => `line ${i + 1}\n`);
  const newLines = [...oldLines];
  newLines[373] = "changed\n";
  const fullFile = parseDiffFromFile(
    { name: file.name, contents: oldLines.join("") },
    { name: file.name, contents: newLines.join("") },
  );
  for (const diffStyle of ["split", "unified"] as const) {
    const virtualRenderer = new DiffHunksRenderer({ diffStyle });
    virtualRenderer.expandHunk(0, "up", 10);
    virtualRenderer.expandHunk(0, "down", 20);
    const fullRenderer = new DiffHunksRenderer<string>({ diffStyle });
    for (const [index, region] of virtualRenderer.getExpandedHunksMap()) {
      fullRenderer.getExpandedHunksMap().set(index, region);
    }
    fullRenderer.setLineAnnotations([
      { side: "additions", lineNumber: 373, metadata: "tall annotation" },
      { side: "deletions", lineNumber: 373, metadata: "other side" },
    ]);
    const result = await fullRenderer.asyncRender(fullFile);
    const html = fullRenderer.renderFullHTML(result);
    assert.match(html, /data-line="10"/);
    assert.match(html, /data-line="374"/);
    assert.match(html, /data-line-annotation/);
    assert.deepEqual(fullRenderer.getExpandedHunk(0), { fromStart: 10, fromEnd: 20 });
    fullRenderer.cleanUp();
    virtualRenderer.cleanUp();
  }
});

test("a repeated request centers again while a replaced request cannot center or fail", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let oldAvailable = false;
  const centered: string[] = [];
  const cancel = focusRenderedLine({
    findRow: () => (oldAvailable ? "old" : undefined),
    center: (row) => centered.push(row),
    renderAll: () => {},
    failed: () => assert.fail("replaced request"),
  });
  cancel();
  oldAvailable = true;
  const start = () =>
    focusRenderedLine({
      findRow: () => "new",
      center: (row) => centered.push(row),
      renderAll: () => assert.fail("visible"),
      failed: () => assert.fail("visible"),
    });
  start()();
  start()();
  for (let i = 0; i < 100; i++) t.mock.timers.tick(32);
  assert.deepEqual(centered, ["new", "new"]);
});
