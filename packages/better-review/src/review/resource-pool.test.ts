import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { ResourcePool } from "./resource-pool";

test("pool shares leased resources, evicts only idle LRU entries, and waits at capacity", async () => {
  const removed: string[] = [];
  const pool = new ResourcePool<string>(2, 60000, async (key) => {
    removed.push(key);
  });
  const a = await pool.acquire("a", async () => "a");
  const again = await pool.acquire("a", async () => {
    throw new Error("must reuse");
  });
  const b = await pool.acquire("b", async () => "b");
  let admitted = false;
  const pending = pool.acquire("c", async () => {
    admitted = true;
    return "c";
  });
  await a.release();
  assert.equal(await pool.evict("a"), "active");
  assert.equal(admitted, false);
  await b.release();
  const c = await pending;
  assert.deepEqual(removed, ["b"]);
  await again.release();
  await c.release();
  await pool.close();
  assert.deepEqual(removed.sort(), ["a", "b", "c"]);
});

test("idle expiry preserves active leases and capacity timeout leaves the pool usable", async () => {
  const removed: string[] = [];
  const pool = new ResourcePool<string>(1, 10, async (key) => {
    removed.push(key);
  });
  const a = await pool.acquire("a", async () => "a");
  await assert.rejects(
    pool.acquire("b", async () => "b", 20),
    /busy/,
  );
  assert.deepEqual(removed, []);
  await a.release();
  await sleep(30);
  assert.deepEqual(removed, ["a"]);
  const b = await pool.acquire("b", async () => "b");
  await b.release();
  await pool.close();
});
