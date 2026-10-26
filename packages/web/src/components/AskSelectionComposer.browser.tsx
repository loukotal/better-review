/** Browser UI contract checks with mock admission only; never starts a paid LLM request. */
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

import type { StoredSession } from "@better-review/shared";

import { createAssertions } from "../browser-tests/assertions";
import { createSelectionDraft, createSelectionSender } from "../lib/ask-ai-selection";
import { AskSelectionComposer, createSelectionQuestionState } from "./AskSelectionComposer";

export async function testBusyNewConversationInBrowser() {
  const { check, result } = createAssertions(3000);
  const sender = createSelectionSender();
  const sends: { id: string; body: string; key: string }[] = [];
  let creates = 0;
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
  return { ...result(), creates, admissions: sends.length };
}

export async function testSelectionConversationPickerInBrowser() {
  const { check, result } = createAssertions(3000);
  const [current, setCurrent] = createSignal<string | null>("session-a");
  const state = createSelectionQuestionState();
  const sessions = ["session-a", "session-b"].map(
    (id) => ({ id, createdAt: 0, headSha: "0123456" }) as StoredSession,
  );
  const host = document.createElement("div");
  document.body.append(host);
  const sends: string[] = [];
  const dispose = render(
    () => (
      <AskSelectionComposer
        selection={createSelectionDraft(
          { file: "a.ts", side: "RIGHT", startLine: 1, endLine: 1, text: "source" },
          "head",
          "scope",
        )}
        state={state}
        stale={false}
        disabled={false}
        currentBusy={false}
        currentSessionId={current()}
        sessions={sessions}
        onDismiss={() => {}}
        onSend={async (_body, target) => {
          sends.push(target);
          return true;
        }}
      />
    ),
    host,
  );
  try {
    const picker = host.querySelector("select")!;
    const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const form = host.querySelector("form")!;
    const choose = (value: string) => {
      picker.value = value;
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    };
    state.setQuestion("Keep this draft");
    check(!picker.querySelector('[value="session-a"]'), "current session is not duplicated");
    choose("session-b");
    setCurrent("session-b");
    check(
      picker.value === "session-b",
      "explicit saved target stays selected when it becomes current",
    );
    check(
      !!picker.querySelector('[value="session-b"]'),
      "selected current session option is retained",
    );
    setCurrent("session-a");
    check(picker.value === "session-b", "switching current does not redirect a saved target");
    form.requestSubmit();
    await Promise.resolve();
    check(sends[0] === "session-b", "saved destination is used for sending");
    choose("new");
    setCurrent(null);
    check(picker.value === "new", "new target survives loss of current session");
    state.setTarget("current");
    check(
      picker.value === "current" && submit.disabled,
      "missing current remains explicit and cannot send",
    );
    check(picker.selectedOptions[0]?.disabled, "missing current option is unavailable");
    check(
      picker.selectedOptions[0]?.textContent?.includes("unavailable") === true,
      "missing current has an honest label",
    );
    setCurrent("session-a");
    check(
      picker.value === "current" && !submit.disabled,
      "current alias remains current when restored",
    );
    check(state.question() === "Keep this draft", "session switches preserve question");
    for (const width of [240, 320]) {
      host.style.width = `${width}px`;
      await new Promise(requestAnimationFrame);
      check(host.scrollWidth <= width, `composer fits ${width}px`);
    }
    return result();
  } finally {
    dispose();
    host.remove();
  }
}
