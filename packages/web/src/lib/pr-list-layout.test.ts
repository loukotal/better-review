import assert from "node:assert/strict";
import { test } from "node:test";

import { loadPrListLayout, PR_LIST_LAYOUT_KEY, savePrListLayout } from "./pr-list-layout";

test("review list defaults to title-first and restores only known layout choices", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  assert.equal(loadPrListLayout(storage), "title-first");
  savePrListLayout("table", storage);
  assert.equal(loadPrListLayout(storage), "table");
  savePrListLayout("title-first", storage);
  assert.equal(loadPrListLayout(storage), "title-first");
  values.set(PR_LIST_LAYOUT_KEY, "unknown-future-layout");
  assert.equal(loadPrListLayout(storage), "title-first");
});

test("unavailable browser storage cannot break layout selection", () => {
  const storage = {
    getItem: (): never => {
      throw new Error("blocked");
    },
    setItem: (): never => {
      throw new Error("blocked");
    },
  };
  assert.equal(loadPrListLayout(storage), "title-first");
  assert.doesNotThrow(() => savePrListLayout("table", storage));
});
