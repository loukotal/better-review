import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openReviewEngine } from "./engine";
import { fixtureModels, fixtureSandbox, fixtureSession } from "./fixtures";
import { readLegacyHistory } from "./legacy-history";

test("imports chunked legacy history once, preserving user messages, findings, tools and settlements without modifying the old database", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-import-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "legacy.sqlite");
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE flue_conversation_stream_batches(path TEXT, seq INTEGER, data TEXT); CREATE TABLE flue_conversation_stream_batch_chunks(path TEXT, seq INTEGER, chunk_index INTEGER, data TEXT)",
  );
  const records = [
    { type: "user_message", messageId: "u", content: [{ type: "text", text: "Review carefully" }] },
    { type: "assistant_message_started", messageId: "a" },
    { type: "assistant_text_started", messageId: "a", blockId: "text" },
    { type: "assistant_text_delta", messageId: "a", blockId: "text", delta: "Existing finding" },
    {
      type: "assistant_tool_call",
      messageId: "a",
      toolCallId: "tool",
      name: "read",
      arguments: { path: "source.ts" },
    },
    {
      type: "tool_outcome",
      assistantMessageId: "a",
      toolCallId: "tool",
      content: [{ type: "text", text: "old source" }],
      isError: false,
    },
    { type: "submission_settled", outcome: "completed" },
  ].map((record, index) => ({
    ...record,
    id: `record-${index}`,
    harness: "default",
    session: "default",
    submissionId: "old-request",
    timestamp: "2026-10-14T00:00:00Z",
  }));
  const raw = JSON.stringify(records);
  const stream = `agents/pr-reviewer/${fixtureSession.id}`;
  db.prepare("INSERT INTO flue_conversation_stream_batches VALUES (?, 1, NULL)").run(stream);
  db.prepare("INSERT INTO flue_conversation_stream_batch_chunks VALUES (?, 1, 0, ?)").run(
    stream,
    raw.slice(0, 100),
  );
  db.prepare("INSERT INTO flue_conversation_stream_batch_chunks VALUES (?, 1, 1, ?)").run(
    stream,
    raw.slice(100),
  );
  db.close();
  const before = await readFile(file);
  const legacy = readLegacyHistory(fixtureSession.id, file);
  assert.equal(legacy.messages.length, 2);
  assert.equal(legacy.settlements[0]?.outcome, "completed");
  const { models, model } = fixtureModels();
  const options = {
    database: path.join(dir, "pi.sqlite"),
    session: fixtureSession,
    models,
    model,
    legacy,
    sandbox: async () => fixtureSandbox("A"),
  };
  const engine = await openReviewEngine(options);
  const history = await engine.snapshot();
  await engine.close();
  assert.equal(history.messages[1]?.parts[0]?.type, "text");
  assert.match(JSON.stringify(history), /Existing finding/);
  assert.match(JSON.stringify(history), /old source/);
  const reopened = await openReviewEngine(options);
  assert.equal((await reopened.snapshot()).messages.length, 2);
  await reopened.close();
  assert.deepEqual(await readFile(file), before);
});
