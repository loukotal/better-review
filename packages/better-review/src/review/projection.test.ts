import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  ROOT_CONVERSATION_ID,
  type EntryId,
  type EntryRecord,
  type SubmissionId,
  type SubmissionRecord,
} from "@earendil-works/pi-durable";

import { TranscriptProjection } from "./projection";

function entry(id: number, value: Omit<EntryRecord, "id" | "conversationId">): EntryRecord {
  return { ...value, id: id as EntryId, conversationId: ROOT_CONVERSATION_ID };
}

test("out-of-order records and replacements replay safely while retaining unchanged message identities", () => {
  const projection = new TranscriptProjection("A");
  const first = entry(2, { kind: "pi.assistant", model: [fauxAssistantMessage("First")] });
  const last = entry(4, { kind: "pi.assistant", model: [fauxAssistantMessage("Last")] });
  projection.addEntry(first);
  projection.addEntry(last);
  const before = projection.history();
  projection.addEntry(entry(3, { kind: "review.revision", data: { ref: "B" } }));
  const after = projection.history();
  assert.equal(after.messages[0], before.messages[0]);
  assert.equal(after.messages[1]!.metadata.revision, "B");
  assert.equal(before.messages[1]!.metadata.revision, "A");
  projection.addEntry({ ...last, model: [fauxAssistantMessage("Replacement")] });
  const replaced = projection.history();
  assert.equal(replaced.messages[0], before.messages[0]);
  assert.deepEqual(replaced.messages[1]!.parts, [{ type: "text", text: "Replacement" }]);
  assert.deepEqual(after.messages[1]!.parts, [{ type: "text", text: "Last" }]);
});

test("late input attribution replays history, but settlement-only changes leave the history array untouched", () => {
  const projection = new TranscriptProjection("A");
  const input = entry(1, {
    kind: "pi.user",
    model: [{ role: "user", content: "Question", timestamp: 1 }],
  });
  const answer = entry(2, { kind: "pi.assistant", model: [fauxAssistantMessage("Answer")] });
  projection.addEntry(input);
  projection.addEntry(answer);
  const original = projection.history();
  const placed: SubmissionRecord = {
    id: 7 as SubmissionId,
    conversationId: ROOT_CONVERSATION_ID,
    type: "input",
    status: "placed",
    entry: input.id,
  };
  projection.addSubmission(placed);
  const attributed = projection.history();
  assert.equal(original.messages[0]!.submissionId, undefined);
  assert.equal(attributed.messages[0]!.submissionId, "7");
  assert.equal(attributed.messages[1]!.submissionId, "7");
  projection.addSubmission({ ...placed, status: "done", answer: answer.id });
  assert.equal(projection.history().messages, attributed.messages);
});

test("duplicate final results do not replace an unchanged tool message", () => {
  const projection = new TranscriptProjection("A");
  const call = fauxToolCall("read", { path: "source.ts" });
  projection.addEntry(entry(1, { kind: "pi.assistant", model: [fauxAssistantMessage(call)] }));
  const result = entry(2, {
    kind: "pi.tool-result",
    model: [
      {
        role: "toolResult",
        toolCallId: call.id,
        toolName: "read",
        content: [{ type: "text", text: "result" }],
        isError: false,
        timestamp: 1,
      },
    ],
  });
  projection.addEntry(result);
  const original = projection.history();
  projection.addEntry({ ...result, id: 3 as EntryId });
  assert.equal(projection.history().messages[0], original.messages[0]);
});

test("a corrected successful tool result clears a previous error without changing published history", () => {
  const projection = new TranscriptProjection("A");
  const call = fauxToolCall("read", { path: "source.ts" });
  projection.addEntry(entry(1, { kind: "pi.assistant", model: [fauxAssistantMessage(call)] }));
  const failure = entry(2, {
    kind: "pi.tool-result",
    model: [
      {
        role: "toolResult",
        toolCallId: call.id,
        toolName: "read",
        content: [{ type: "text", text: "failed" }],
        isError: true,
        timestamp: 1,
      },
    ],
  });
  projection.addEntry(failure);
  const failed = projection.history();
  projection.addEntry(
    entry(3, {
      kind: "pi.tool-result",
      model: [
        {
          role: "toolResult",
          toolCallId: call.id,
          toolName: "read",
          content: [{ type: "text", text: "recovered" }],
          isError: false,
          timestamp: 2,
        },
      ],
    }),
  );
  const recovered = projection.history();
  assert.deepEqual(recovered.messages[0]!.parts[0], {
    type: "dynamic-tool",
    toolCallId: call.id,
    toolName: "read",
    input: { path: "source.ts" },
    state: "output-available",
    output: "recovered",
  });
  assert.equal(failed.messages[0]!.parts[0]!.type, "dynamic-tool");
  assert.match(JSON.stringify(failed), /"errorText":"failed"/);
});

test("input attribution is independent of publication order, including intermediate snapshots", () => {
  for (const order of [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ]) {
    const projection = new TranscriptProjection("A");
    const input = entry(1, {
      kind: "pi.user",
      model: [{ role: "user", content: "Question", timestamp: 1 }],
    });
    const answer = entry(2, { kind: "pi.assistant", model: [fauxAssistantMessage("Answer")] });
    const record: SubmissionRecord = {
      id: 7 as SubmissionId,
      conversationId: ROOT_CONVERSATION_ID,
      type: "input",
      status: "placed",
      entry: input.id,
    };
    const changes = [
      () => projection.addEntry(input),
      () => projection.addEntry(answer),
      () => projection.addSubmission(record),
    ];
    const snapshots: string[] = [];
    const histories = [];
    for (const i of order) {
      changes[i]!();
      const history = projection.history();
      histories.push(history);
      snapshots.push(JSON.stringify(history));
    }
    assert.deepEqual(
      projection.history().messages.map((message) => message.submissionId),
      ["7", "7"],
    );
    assert.deepEqual(
      histories.map((history) => JSON.stringify(history)),
      snapshots,
    );
  }
});

test("context head markers never remove or reattribute the durable review transcript", () => {
  const projection = new TranscriptProjection("A");
  const original = entry(1, {
    kind: "pi.user",
    model: [{ role: "user", content: "Original", timestamp: 1 }],
  });
  projection.addEntry(original);
  const before = projection.history();
  projection.addEntry(
    entry(2, {
      kind: "pi.reset",
      head: 2 as EntryId,
      model: [{ role: "user", content: "Handoff", timestamp: 2 }],
    }),
  );
  projection.addEntry(
    entry(3, {
      kind: "pi.compaction",
      head: original.id,
      model: [{ role: "user", content: "Summary", timestamp: 3 }],
    }),
  );
  const after = projection.history();
  assert.equal(after.messages, before.messages);
  assert.equal(after.ref, "A");
  projection.addEntry(entry(4, { kind: "review.revision", data: { ref: "B" } }));
  projection.addEntry(
    entry(5, { kind: "pi.assistant", model: [fauxAssistantMessage("After reset")] }),
  );
  const appended = projection.history();
  assert.equal(appended.messages[0], before.messages[0]);
  assert.equal(appended.messages[1]!.metadata.revision, "B");
  assert.equal(before.messages.length, 1);
});
