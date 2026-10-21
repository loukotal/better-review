import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_GITHUB_SYNC_TIMEOUT_MS,
  GITHUB_QUEUE_SETTINGS_KEY,
  getGithubSyncTimeoutMs,
  setGithubSyncTimeoutMs,
} from "./github-queue-settings";

test("GitHub queue timeout defaults to five minutes and persists versioned preset choices", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
  assert.equal(getGithubSyncTimeoutMs(storage), DEFAULT_GITHUB_SYNC_TIMEOUT_MS);
  for (const minutes of [5, 15, 30, 60]) {
    setGithubSyncTimeoutMs(minutes * 60_000, storage);
    assert.equal(getGithubSyncTimeoutMs(storage), minutes * 60_000);
    assert.equal(JSON.parse(data.get(GITHUB_QUEUE_SETTINGS_KEY)!).version, 1);
  }
  for (const value of [
    "oops",
    '{"version":2,"timeoutMs":900000}',
    '{"version":1,"timeoutMs":0}',
    '{"version":1,"timeoutMs":999999999}',
  ]) {
    data.set(GITHUB_QUEUE_SETTINGS_KEY, value);
    assert.equal(getGithubSyncTimeoutMs(storage), DEFAULT_GITHUB_SYNC_TIMEOUT_MS);
  }
});
test("timeout validation and storage failures cannot silently apply a different displayed choice", () => {
  const storage = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  for (const value of [0, -1, 59_999, 3_600_001, NaN, Infinity])
    assert.throws(() => setGithubSyncTimeoutMs(value, storage), RangeError);
  setGithubSyncTimeoutMs(15 * 60_000, storage);
  assert.equal(getGithubSyncTimeoutMs(storage), 15 * 60_000);
  setGithubSyncTimeoutMs(DEFAULT_GITHUB_SYNC_TIMEOUT_MS, storage);
});
