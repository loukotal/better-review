import assert from "node:assert/strict";
import { test } from "node:test";

import { createHighlightCache } from "./highlight-cache";

const limits = { maxEntries: 500, maxBytes: 8 * 1024 * 1024 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("deduplicates pending aliases and caches successful empty output", async () => {
  const result = deferred<string>();
  const calls: Array<{ code: string; lang: string; theme: string }> = [];
  const cache = createHighlightCache((code, options) => {
    calls.push({ code, ...options });
    return result.promise;
  }, limits);

  const first = cache.highlight("const x = 1", " JS ", "github-dark");
  const second = cache.highlight("const x = 1", "javascript", "github-dark");
  assert.equal(first, second);
  await Promise.resolve();
  assert.deepEqual(calls, [{ code: "const x = 1", lang: "javascript", theme: "github-dark" }]);
  result.resolve("");
  assert.deepEqual(await Promise.all([first, second]), ["", ""]);
  assert.equal(await cache.highlight("const x = 1", "js", "github-dark"), "");
  assert.equal(calls.length, 1);
});

test("keys include language, theme, and code without delimiter collisions", async () => {
  let calls = 0;
  const cache = createHighlightCache(async () => String(++calls), limits);
  assert.equal(await cache.highlight("c", "a:b", "d"), "1");
  assert.equal(await cache.highlight("b:c", "a", "d"), "2");
  assert.equal(await cache.highlight("c", "a:b", "light"), "3");
  assert.equal(await cache.highlight("c", "a:b", "d"), "1");
  assert.equal(await cache.highlight("c", "constructor", "d"), "4");
});

test("shares failures without caching them and retries successfully", async () => {
  const result = deferred<string>();
  let calls = 0;
  const cache = createHighlightCache(() => {
    calls += 1;
    return calls === 1 ? result.promise : Promise.resolve("recovered");
  }, limits);
  const first = cache.highlight("x", "ts", "dark");
  const second = cache.highlight("x", "typescript", "dark");
  assert.equal(first, second);
  const failure = new Error("unavailable");
  const rejection = assert.rejects(first, (error) => error === failure);
  result.reject(failure);
  await rejection;
  assert.equal(await cache.highlight("x", "ts", "dark"), "recovered");
  assert.equal(await cache.highlight("x", "ts", "dark"), "recovered");
  assert.equal(calls, 2);
});

test("synchronous highlighter errors also allow retry", async () => {
  let calls = 0;
  const cache = createHighlightCache(() => {
    if (++calls === 1) throw new Error("sync failure");
    return Promise.resolve("ok");
  }, limits);
  await assert.rejects(cache.highlight("x", "js", "dark"), /sync failure/);
  assert.equal(await cache.highlight("x", "js", "dark"), "ok");
});

test("enforces the exact entry limit and refreshes recency on hits", async () => {
  const calls: string[] = [];
  const cache = createHighlightCache(
    async (code) => {
      calls.push(code);
      return code;
    },
    { ...limits, maxEntries: 2 },
  );
  await cache.highlight("a", "js", "dark");
  await cache.highlight("b", "js", "dark");
  await cache.highlight("a", "js", "dark");
  await cache.highlight("c", "js", "dark");
  await cache.highlight("a", "js", "dark");
  assert.deepEqual(calls, ["a", "b", "c"]);
  await cache.highlight("b", "js", "dark");
  assert.deepEqual(calls, ["a", "b", "c", "b"]);
});

test("counts UTF-8 bytes of both serialized keys and HTML, allowing exact fits", async () => {
  const code = "😀";
  const html = "<b>é</b>";
  const size = new TextEncoder().encode(JSON.stringify(["text", "dark", code]) + html).byteLength;
  for (const maxBytes of [size, size - 1]) {
    let calls = 0;
    const cache = createHighlightCache(
      async () => {
        calls += 1;
        return html;
      },
      { ...limits, maxBytes },
    );
    assert.equal(await cache.highlight(code, "text", "dark"), html);
    assert.equal(await cache.highlight(code, "text", "dark"), html);
    assert.equal(calls, maxBytes === size ? 1 : 2);
  }
});

test("evicts by byte budget and skips oversized entries without evicting existing ones", async () => {
  const calls: string[] = [];
  const size = new TextEncoder().encode(JSON.stringify(["text", "dark", "a"]) + "a").byteLength;
  const cache = createHighlightCache(
    async (code) => {
      calls.push(code);
      return code;
    },
    { ...limits, maxBytes: size * 2 },
  );
  for (const code of ["a", "b", "a", "c", "a", "x".repeat(100), "a", "c"]) {
    await cache.highlight(code, "text", "dark");
  }
  assert.deepEqual(calls, ["a", "b", "c", "x".repeat(100)]);
  await cache.highlight("b", "text", "dark");
  assert.equal(calls.at(-1), "b");
});

test("zero entry capacity still deduplicates pending work but retains no results", async () => {
  let calls = 0;
  const cache = createHighlightCache(async () => String(++calls), { ...limits, maxEntries: 0 });
  const first = cache.highlight("x", "text", "dark");
  assert.equal(first, cache.highlight("x", "text", "dark"));
  assert.equal(await first, "1");
  assert.equal(await cache.highlight("x", "text", "dark"), "2");
});

test("clear removes completed results", async () => {
  let calls = 0;
  const cache = createHighlightCache(async () => String(++calls), limits);
  assert.equal(await cache.highlight("x", "text", "dark"), "1");
  cache.clear();
  assert.equal(await cache.highlight("x", "text", "dark"), "2");
});

test("clear prevents stale pending writes or removal of a new pending request", async () => {
  const oldResult = deferred<string>();
  const newResult = deferred<string>();
  let calls = 0;
  const cache = createHighlightCache(
    () => (++calls === 1 ? oldResult.promise : newResult.promise),
    limits,
  );
  const oldRequest = cache.highlight("x", "text", "dark");
  await Promise.resolve();
  cache.clear();
  const newRequest = cache.highlight("x", "text", "dark");
  assert.notEqual(oldRequest, newRequest);
  oldResult.resolve("old");
  assert.equal(await oldRequest, "old");
  assert.equal(cache.highlight("x", "text", "dark"), newRequest);
  newResult.resolve("new");
  assert.equal(await newRequest, "new");
  assert.equal(await cache.highlight("x", "text", "dark"), "new");
  assert.equal(calls, 2);
});

test("an old pending completion cannot overwrite a newer cached result", async () => {
  const oldResult = deferred<string>();
  let calls = 0;
  const cache = createHighlightCache(
    () => (++calls === 1 ? oldResult.promise : Promise.resolve("new")),
    limits,
  );
  const oldRequest = cache.highlight("x", "text", "dark");
  await Promise.resolve();
  cache.clear();
  assert.equal(await cache.highlight("x", "text", "dark"), "new");
  oldResult.resolve("old");
  assert.equal(await oldRequest, "old");
  assert.equal(await cache.highlight("x", "text", "dark"), "new");
});
