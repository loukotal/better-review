import type { Message } from "@earendil-works/pi-ai";
import type { EntryRecord, SubmissionRecord } from "@earendil-works/pi-durable";

import type { ReviewMessage, ReviewPart } from "@better-review/shared";

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function assistantParts(message: Extract<Message, { role: "assistant" }>): ReviewPart[] {
  return message.content.flatMap((part): ReviewPart[] => {
    if (part.type === "text") return [{ type: "text", text: part.text }];
    if (part.type === "thinking") return [{ type: "reasoning", text: part.thinking }];
    if (part.type === "toolCall")
      return [
        {
          type: "dynamic-tool",
          toolCallId: part.id,
          toolName: part.name,
          input: part.arguments,
          state: "input-available",
        },
      ];
    return [];
  });
}

/** Durable transcript only. Live overlays and settlements never mutate this projection.
 * Normal commits project only pending entries. Publishing/copy-on-write still copies the
 * message array; exceptional replacement/out-of-order entries replay the durable history.
 */
export class TranscriptProjection {
  private readonly entries = new Map<number, EntryRecord>();
  private readonly inputEntries = new Map<number, number>();
  private readonly byEntry = new Map<number, number>();
  private readonly tools = new Map<string, { message: number; part: number }>();
  private readonly pending = new Map<number, EntryRecord>();
  private messages: ReviewMessage[] = [];
  private ref: string;
  private submissionId: string | undefined;
  private lastEntry = -1;
  private replay = false;
  private published = false;

  constructor(private readonly initialRef: string) {
    this.ref = initialRef;
  }

  hasEntry(id: number) {
    return this.entries.has(id);
  }

  get entryCount() {
    return this.entries.size;
  }

  addEntry(entry: EntryRecord) {
    if (this.entries.get(entry.id) === entry) return;
    if (entry.id <= this.lastEntry) this.replay = true;
    this.entries.set(entry.id, entry);
    this.pending.set(entry.id, entry);
  }

  addSubmission(record: SubmissionRecord) {
    const oldEntry = this.inputEntries.get(record.id);
    const newEntry = record.type === "input" ? record.entry : undefined;
    if (oldEntry === newEntry) return; // Settlement changes cannot change history.
    if (newEntry === undefined) this.inputEntries.delete(record.id);
    else this.inputEntries.set(record.id, newEntry);
    if (oldEntry !== undefined) this.byEntry.delete(oldEntry);
    if (newEntry !== undefined) this.byEntry.set(newEntry, record.id);
    if (
      (oldEntry !== undefined && oldEntry <= this.lastEntry) ||
      (newEntry !== undefined && newEntry <= this.lastEntry)
    )
      this.replay = true;
  }

  history() {
    const previous = this.replay ? new Map(this.messages.map((m) => [m.id, m])) : undefined;
    if (this.replay) {
      this.messages = [];
      this.ref = this.initialRef;
      this.submissionId = undefined;
      this.tools.clear();
      this.lastEntry = -1;
      this.published = false;
    }
    const entries = this.replay ? this.entries : this.pending;
    for (const entry of [...entries.values()].sort((a, b) => a.id - b.id)) this.project(entry);
    if (previous) {
      // Rare defensive replay only; no history serialization on the append path.
      this.messages = this.messages.map((message) => {
        const old = previous.get(message.id);
        return old && JSON.stringify(old) === JSON.stringify(message) ? old : message;
      });
    }
    this.pending.clear();
    this.replay = false;
    this.published = true;
    return { messages: this.messages, ref: this.ref, submissionId: this.submissionId };
  }

  private writable() {
    if (this.published) {
      this.messages = [...this.messages];
      this.published = false;
    }
  }

  private project(entry: EntryRecord) {
    this.lastEntry = entry.id;
    if (entry.kind === "review.revision") {
      this.ref = (entry.data as { ref: string }).ref;
      return;
    }
    if (entry.kind === "review.legacy") {
      const message: ReviewMessage = JSON.parse(entry.data as string);
      message.metadata.revision ??= this.ref;
      this.writable();
      this.messages.push(message);
      return;
    }
    if (
      entry.kind !== "pi.user" &&
      entry.kind !== "pi.assistant" &&
      entry.kind !== "pi.tool-result"
    )
      return;
    const submission = this.byEntry.get(entry.id);
    if (submission !== undefined) this.submissionId = String(submission);
    for (const model of entry.model ?? []) {
      if (model.role === "user" || model.role === "assistant") {
        const message: ReviewMessage = {
          id: `pi:${entry.id}`,
          role: model.role,
          submissionId: this.submissionId,
          metadata: { timestamp: new Date(model.timestamp).toISOString(), revision: this.ref },
          parts:
            model.role === "user"
              ? [{ type: "text", text: textContent(model.content) }]
              : assistantParts(model),
        };
        this.writable();
        const index = this.messages.length;
        this.messages.push(message);
        message.parts.forEach((part, i) => {
          if (part.type === "dynamic-tool")
            this.tools.set(part.toolCallId, { message: index, part: i });
        });
      } else if (model.role === "toolResult") {
        const slot = this.tools.get(model.toolCallId);
        if (!slot) continue;
        const message = this.messages[slot.message]!;
        const tool = message.parts[slot.part]!;
        if (tool.type !== "dynamic-tool") continue;
        const output = textContent(model.content);
        const updated: ReviewPart = {
          ...tool,
          state: model.isError ? "output-error" : "output-available",
          output,
          ...(model.isError ? { errorText: output } : {}),
        };
        if (!model.isError) delete updated.errorText;
        if (
          tool.state === updated.state &&
          tool.output === updated.output &&
          tool.errorText === updated.errorText
        )
          continue;
        this.writable();
        this.messages[slot.message] = {
          ...message,
          parts: message.parts.map((part, i) => (i === slot.part ? updated : part)),
        };
      }
    }
  }
}
