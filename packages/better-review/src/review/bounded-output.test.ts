import assert from "node:assert/strict";
import test from "node:test";

import { BoundedOutput } from "./bounded-output";

test("draining large output retains a bounded tail and counts omitted bytes", () => {
  const output = new BoundedOutput(32);
  for (let index = 0; index < 10000; index++) output.append(Buffer.alloc(1000, "a"));
  output.append(Buffer.from("END"));
  assert.equal(output.totalBytes, 10000003);
  assert.ok(output.text().endsWith("END"));
  assert.ok(Buffer.byteLength(output.text()) < 100);
  assert.match(output.text(), /9999971 earlier output bytes omitted/);
});

test("UTF-8 characters split across chunks survive and truncated prefixes do not corrupt output", () => {
  const bytes = Buffer.from("abc🌍hello");
  const output = new BoundedOutput(9);
  output.append(bytes.subarray(0, 5));
  output.append(bytes.subarray(5));
  assert.ok(output.text().endsWith("🌍hello"));
  const shorter = new BoundedOutput(7);
  shorter.append(bytes);
  assert.ok(shorter.text().endsWith("hello"));
  assert.ok(!shorter.text().includes("�"));
});
