import type { ReviewSnapshot } from "@better-review/shared";

import { AUTO_ORDER_PREFERENCE_KEY } from "../lib/automatic-review-order";
import { mountAppFixture } from "./mount-app";

const head = "a".repeat(40);
const paths = ["src/alpha.ts", "src/bravo.ts", "src/charlie.ts", "src/delta.ts"];
const ai = [...paths].reverse();
const diff = paths
  .map((path, index) => {
    const count = 600 + index * 100;
    return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${count} +1,${count} @@\n${Array.from({ length: count }, (_, line) => `-const file${index}_old${line} = ${line};\n+const file${index}_new${line} = ${line + 1};`).join("\n")}\n`;
  })
  .join("");

function snapshot(sessionId: string, running = false, files = ai): ReviewSnapshot {
  return {
    sessionId,
    revision: head,
    running,
    compacting: false,
    settlements: [],
    messages: [
      {
        id: "render-order",
        role: "assistant",
        metadata: { timestamp: "2026-01-01", revision: head },
        parts: [
          { type: "text", text: `<<REVIEW_ORDER>>${JSON.stringify(files)}<</REVIEW_ORDER>>` },
        ],
      },
    ],
  };
}

function assertions() {
  let passed = 0;
  const check = (value: unknown, message: string) => {
    if (!value) throw Error(message);
    passed++;
  };
  const wait = async (predicate: () => boolean, message: string) => {
    for (let n = 0; n < 240 && !predicate(); n++) await new Promise(requestAnimationFrame);
    check(predicate(), message);
  };
  return { check, wait, result: () => ({ passed }) };
}

const fileElements = () => [...document.querySelectorAll<HTMLElement>('[id^="file-src"]')];
const order = () =>
  fileElements()
    .map((element) => decodeURIComponent(element.id.slice(5)))
    .join(",");
function visibleRows(scroll: HTMLElement) {
  const viewport = scroll.getBoundingClientRect();
  return [...document.querySelectorAll("diffs-container")].flatMap((container) =>
    [...(container.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]") ?? [])].filter(
      (row) => {
        const box = row.getBoundingClientRect();
        return (
          box.height > 0 &&
          box.width > 0 &&
          box.bottom > viewport.top + 100 &&
          box.top < viewport.bottom - 20
        );
      },
    ),
  );
}

export async function testManualReviewOrderPaintedRowsInBrowser() {
  return liveOrderFixture(false);
}

export async function testAutomaticReviewOrderPaintedRowsInBrowser() {
  return liveOrderFixture(true);
}

export async function testManualReviewOrderUnchangedViewportInBrowser() {
  return liveOrderFixture(false, true);
}

async function liveOrderFixture(automatic: boolean, keepFirst = false) {
  const { check, wait, result } = assertions();
  if (automatic) localStorage.removeItem(AUTO_ORDER_PREFERENCE_KEY);
  else
    localStorage.setItem(AUTO_ORDER_PREFERENCE_KEY, JSON.stringify({ version: 1, enabled: false }));
  localStorage.removeItem("better-review:applied-review-orders");
  let running = automatic;
  const expected = keepFirst ? [paths[0], paths[3], paths[2], paths[1]] : ai;
  await mountAppFixture({
    diff,
    reviewSnapshot: (sessionId) => snapshot(sessionId, running, expected),
  });
  const original = fileElements();
  const renderers = [...document.querySelectorAll("diffs-container")];
  const first = original[0];
  const scroll = first.closest<HTMLElement>(".overflow-y-auto.pb-3")!;
  const apply = () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Apply order",
    );
  document.querySelector<HTMLButtonElement>('[aria-controls="chat-panel"]')!.click();
  await wait(() => !!apply(), "Manual order control missing");
  scroll.scrollTop = 800;
  await wait(() => visibleRows(scroll).length > 5, "Initial viewport has no painted source rows");
  // Finish the chat width transition before ordering: its ResizeObserver update
  // otherwise masks stale virtual positions in the unchanged-size file list.
  for (let frame = 0; frame < 5; frame++) await new Promise(requestAnimationFrame);
  const offset = first.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
  if (automatic) {
    running = false;
    await wait(() => order() === expected.join(","), "Completed automatic order did not apply");
  } else apply()!.click();
  check(order() === expected.join(","), "Manual order did not apply");
  for (let frame = 0; frame < 20; frame++) {
    await new Promise(requestAnimationFrame);
    const rows = visibleRows(scroll);
    check(rows.length > 5, `Blank source viewport after reorder at frame ${frame}`);
    check(
      rows.some((row) => row.textContent?.includes("file0_")),
      `Wrong source painted at frame ${frame}`,
    );
    check(
      Math.abs(first.getBoundingClientRect().top - scroll.getBoundingClientRect().top - offset) < 3,
      `Visible file moved at frame ${frame}`,
    );
  }
  check(
    original.every((node) => node.isConnected),
    "Ordering remounted file renderers",
  );
  check(
    renderers.every((node) => node.isConnected),
    "Ordering replaced retained diff hosts",
  );
  const target = keepFirst ? fileElements()[1] : fileElements()[0];
  scroll.scrollTop += target.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 800;
  await wait(
    () => visibleRows(scroll).some((row) => row.textContent?.includes("file3_")),
    "New first file did not paint after scrolling",
  );
  // The browser runner closes this isolated context. Keep failed fixtures
  // mounted so its failure screenshot captures the source viewport.
  return result();
}

export async function testInitialAutomaticOrderPaintedRowsInBrowser() {
  const { check, wait, result } = assertions();
  localStorage.removeItem(AUTO_ORDER_PREFERENCE_KEY);
  localStorage.removeItem("better-review:applied-review-orders");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  const rendered: string[] = [];
  const observer = new MutationObserver(() => {
    const value = order();
    if (value) rendered.push(value);
  });
  observer.observe(document.getElementById("root")!, { childList: true, subtree: true });
  const dispose = await mountAppFixture({
    diff,
    waitForFiles: false,
    reviewSnapshot: async (sessionId) => {
      requested = true;
      await held;
      return snapshot(sessionId);
    },
  });
  try {
    await wait(() => requested, "Saved history request did not start");
    for (let frame = 0; frame < 3; frame++) {
      await new Promise(requestAnimationFrame);
      check(
        !document.querySelector("diffs-container"),
        "Diff renderer mounted before saved order resolved",
      );
    }
    release();
    await wait(() => fileElements().length === paths.length, "Ordered diff did not mount");
    check(
      rendered.every((value) => value === ai.join(",")),
      "Default order flashed before saved order",
    );
    const scroll = fileElements()[0].closest<HTMLElement>(".overflow-y-auto.pb-3")!;
    await wait(() => visibleRows(scroll).length > 5, "Initial ordered source did not paint");
    check(
      visibleRows(scroll).some((row) => row.textContent?.includes("file3_")),
      "First painted source does not match saved order",
    );
    for (let frame = 0; frame < 20; frame++) {
      await new Promise(requestAnimationFrame);
      check(visibleRows(scroll).length > 5, `Initial ordered source blanked at frame ${frame}`);
    }
    return result();
  } finally {
    release();
    observer.disconnect();
    dispose();
  }
}
