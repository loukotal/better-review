import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ReviewMessage, ReviewSnapshot } from "@better-review/shared";

import { STORE_BASE_DIR } from "../store";

/** Read-only, one-time import of the retired engine's append-only conversation log. */
export function readLegacyHistory(
  sessionId: string,
  database = path.join(STORE_BASE_DIR, "flue-v2.sqlite"),
): ReviewSnapshot {
  const snapshot: ReviewSnapshot = {
    sessionId,
    messages: [],
    settlements: [],
    running: false,
    compacting: false,
  };
  if (!existsSync(database)) return snapshot;
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const streamPath = `agents/pr-reviewer/${sessionId}`;
    const messages = new Map<string, ReviewMessage>();
    const blocks = new Map<string, { type: "text" | "reasoning"; text: string }>();
    const seen = new Set<string>();
    const batches = db
      .prepare("SELECT seq, data FROM flue_conversation_stream_batches WHERE path = ? ORDER BY seq")
      .all(streamPath);
    for (const batch of batches) {
      const chunks = db
        .prepare(
          "SELECT data FROM flue_conversation_stream_batch_chunks WHERE path = ? AND seq = ? ORDER BY chunk_index",
        )
        .all(streamPath, batch.seq!);
      const raw = chunks.length
        ? chunks.map((chunk) => String(chunk.data)).join("")
        : String(batch.data);
      for (const record of JSON.parse(raw)) {
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        if (record.harness !== "default" || record.session !== "default") continue;
        if (record.type === "user_message" || record.type === "assistant_message_started") {
          const message: ReviewMessage = {
            id: record.messageId,
            role: record.type === "user_message" ? "user" : "assistant",
            submissionId: record.submissionId,
            parts: [],
            metadata: { timestamp: record.timestamp },
          };
          for (const part of record.content ?? [])
            if (part.type === "text") message.parts.push({ type: "text", text: part.text });
          messages.set(message.id, message);
        } else if (
          record.type === "assistant_text_started" ||
          record.type === "assistant_reasoning_started"
        ) {
          const block = {
            type:
              record.type === "assistant_text_started" ? ("text" as const) : ("reasoning" as const),
            text: "",
          };
          blocks.set(record.blockId, block);
          messages.get(record.messageId)?.parts.push(block);
        } else if (
          record.type === "assistant_text_delta" ||
          record.type === "assistant_reasoning_delta"
        ) {
          const block = blocks.get(record.blockId);
          if (block) block.text += record.delta;
        } else if (record.type === "assistant_tool_call") {
          messages.get(record.messageId)?.parts.push({
            type: "dynamic-tool",
            toolCallId: record.toolCallId,
            toolName: record.name,
            input: record.arguments ?? {},
            state: "output-error",
            errorText: "Interrupted before migration",
          });
        } else if (record.type === "tool_outcome") {
          const tool = messages
            .get(record.assistantMessageId)
            ?.parts.find(
              (part) => part.type === "dynamic-tool" && part.toolCallId === record.toolCallId,
            );
          if (tool?.type === "dynamic-tool") {
            const text = (record.content ?? [])
              .filter((part: { type: string }) => part.type === "text")
              .map((part: { text: string }) => part.text)
              .join("\n");
            tool.state = record.isError ? "output-error" : "output-available";
            tool.output = text;
            tool.errorText = record.isError ? text : undefined;
          }
        } else if (record.type === "submission_settled") {
          snapshot.settlements.push({
            submissionId: record.submissionId,
            outcome: record.outcome,
            error: record.error ? JSON.stringify(record.error) : undefined,
          });
        }
      }
    }
    snapshot.messages = [...messages.values()];
    for (const message of snapshot.messages) {
      if (
        message.submissionId &&
        !snapshot.settlements.some((settled) => settled.submissionId === message.submissionId)
      ) {
        snapshot.settlements.push({
          submissionId: message.submissionId,
          outcome: "aborted",
          error:
            "The previous runtime stopped before completing this request. Continue the review to retry.",
        });
      }
    }
    return snapshot;
  } finally {
    db.close();
  }
}
