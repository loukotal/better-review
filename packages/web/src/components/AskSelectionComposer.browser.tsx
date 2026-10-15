/** Browser UI contract checks with mock admission only; never starts a paid LLM request. */
import { render } from "solid-js/web";

import { createSelectionDraft, createSelectionSender } from "../lib/ask-ai-selection";
import { AskSelectionComposer } from "./AskSelectionComposer";

export async function testBusyNewConversationInBrowser() {
  const sender = createSelectionSender();
  const sends: { id: string; body: string; key: string }[] = [];
  let creates = 0;
  let passed = 0;
  const check = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message);
    passed++;
  };
  for (let round = 0; round < 2; round++) {
    const selection = createSelectionDraft(
      { file: "a.ts", side: "RIGHT", startLine: 1, endLine: 1, text: "same source" },
      "head",
      "same-scope",
    );
    const host = document.createElement("div");
    document.body.append(host);
    let completed!: () => void;
    let failure: unknown;
    const completion = new Promise<void>((resolve) => {
      completed = resolve;
    });
    const dispose = render(
      () => (
        <AskSelectionComposer
          selection={selection}
          stale={false}
          disabled={false}
          currentBusy
          currentSessionId="busy-old-session"
          sessions={[]}
          onDismiss={() => {}}
          onSend={async (body, target) => {
            try {
              const id = await sender.send({
                draftId: selection.draftId,
                body,
                target,
                isCurrent: () => true,
                createSession: async () => `fresh-${++creates}`,
                client: (id) => ({
                  history: async () => ({
                    sessionId: id,
                    messages: [],
                    settlements: [],
                    running: id === "busy-old-session",
                    compacting: false,
                  }),
                  send: async (body, key) => {
                    sends.push({ id, body, key });
                    return { submissionId: `receipt-${sends.length}` };
                  },
                }),
              });
              return !!id;
            } catch (cause) {
              failure = cause;
              return false;
            } finally {
              completed();
            }
          }}
        />
      ),
      host,
    );
    try {
      const question = host.querySelector("textarea")!;
      question.value = "Explain this?";
      question.dispatchEvent(new InputEvent("input", { bubbles: true }));
      const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      check(submit.disabled, "current busy target must be disabled");
      question.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      check(sends.length === round, "shortcut cannot bypass busy current target");
      const target = host.querySelector("select")!;
      target.value = "new";
      target.dispatchEvent(new Event("change", { bubbles: true }));
      check(!submit.disabled, "new conversation must remain available while current is busy");
      const form = host.querySelector("form")!;
      question.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: true,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      check(sends.length === round, "composition shortcut must not send selection");
      question.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      form.requestSubmit();
      await completion;
      if (failure) throw failure;
      check(sends.length === round + 1, "duplicate UI submission must admit once per draft");
      check(sends.at(-1)?.id === `fresh-${round + 1}`, "new draft must use a fresh destination");
    } finally {
      dispose();
      host.remove();
    }
  }
  check(creates === 2, "identical questions in separate composer drafts must create twice");
  check(sends[0]?.key !== sends[1]?.key, "separate drafts must not share admission keys");
  check(sends[0]?.body === sends[1]?.body, "fixture questions/context must be genuinely identical");
  return { passed, creates, admissions: sends.length };
}
