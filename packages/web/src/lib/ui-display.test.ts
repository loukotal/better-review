import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_UI_DISPLAY_SETTINGS,
  diffCodeMetrics,
  loadUiDisplaySettings,
  saveUiDisplaySettings,
  UI_DISPLAY_SETTINGS_KEY,
} from "./ui-display";

test("display settings default to comfortable 100% and restore only known choices", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  assert.deepEqual(loadUiDisplaySettings(storage), DEFAULT_UI_DISPLAY_SETTINGS);
  saveUiDisplaySettings({ density: "compact", zoom: 80 }, storage);
  assert.deepEqual(loadUiDisplaySettings(storage), { density: "compact", zoom: 80 });
  values.set(UI_DISPLAY_SETTINGS_KEY, '{"density":"tiny","zoom":42}');
  assert.deepEqual(loadUiDisplaySettings(storage), DEFAULT_UI_DISPLAY_SETTINGS);
  values.set(UI_DISPLAY_SETTINGS_KEY, "not json");
  assert.deepEqual(loadUiDisplaySettings(storage), DEFAULT_UI_DISPLAY_SETTINGS);
});

test("unavailable browser storage cannot break display settings", () => {
  const storage = {
    getItem: (): never => {
      throw new Error("blocked");
    },
    setItem: (): never => {
      throw new Error("blocked");
    },
  };
  assert.deepEqual(loadUiDisplaySettings(storage), DEFAULT_UI_DISPLAY_SETTINGS);
  assert.doesNotThrow(() => saveUiDisplaySettings({ density: "compact", zoom: 90 }, storage));
});

test("diff code rows scale with zoom and tighten in compact mode", () => {
  assert.deepEqual(diffCodeMetrics(DEFAULT_UI_DISPLAY_SETTINGS), { fontSize: 13, lineHeight: 20 });
  assert.deepEqual(diffCodeMetrics({ density: "compact", zoom: 100 }), {
    fontSize: 13,
    lineHeight: 18,
  });
  assert.deepEqual(diffCodeMetrics({ density: "comfortable", zoom: 80 }), {
    fontSize: 10.4,
    lineHeight: 16,
  });
});
