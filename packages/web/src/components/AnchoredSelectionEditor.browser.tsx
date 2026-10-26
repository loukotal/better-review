/** Real editor/portal contract with a live controller interface and mock durable admission. */
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";

import { createAssertions } from "../browser-tests/assertions";
import {
  createSelectionDraft,
  createSelectionSender,
  type SelectionChatController,
} from "../lib/ask-ai-selection";
import { textSelectionAnchor } from "../lib/selection-bubble";
import { AnchoredSelectionEditor, type SelectionEditorDraft } from "./AnchoredSelectionEditor";
import { createSelectionQuestionState } from "./AskSelectionComposer";
import { SelectionBubble } from "./SelectionBubble";

export async function testAnchoredSelectionEditorInBrowser() {
  const { check, result } = createAssertions(3000);
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
  };
  const modal = document.createElement("dialog");
  modal.style.cssText =
    "margin:20px;padding:16px;width:440px;max-width:calc(100vw - 40px);height:380px;overflow:auto";
  const source = document.createElement("div");
  source.style.cssText = "height:180px;overflow:auto;font:12px/20px monospace;white-space:pre";
  const lines = Array.from({ length: 12 }, (_, i) =>
    i === 0 ? "very long first highlighted line ".repeat(8) : `line ${i + 1}`,
  );
  for (const text of lines) {
    const row = document.createElement("div");
    row.textContent = text;
    source.append(row);
  }
  modal.append(source);
  document.body.append(modal);
  modal.showModal();
  const host = document.createElement("div");
  modal.append(host);
  const [openModal, setOpenModal] = createSignal(true);
  const [scope, setScope] = createSignal("same-scope");
  const [draft, setDraft] = createSignal<SelectionEditorDraft | null>(null);
  const [compact, setCompact] = createSignal(true);
  const range = document.createRange();
  range.setStart(source.firstElementChild!.firstChild!, 0);
  range.setEnd(source.children[5]!.firstChild!, 6);
  const selection = createSelectionDraft(
    { file: "a.ts", side: "LEFT", startLine: 1, endLine: 6, text: lines.slice(0, 6).join("\n") },
    "historical-head",
    "same-scope",
  );
  let creates = 0;
  let loseReceipt = true;
  const admissions: { id: string; body: string; key: string }[] = [];
  const sender = createSelectionSender();
  const controller: SelectionChatController = {
    currentSessionId: () => "busy-current",
    currentBusy: () => true,
    disabled: () => false,
    sessions: () => [],
    send: (selected, body, target, isCurrent) =>
      sender
        .send({
          draftId: selected.draftId,
          body,
          target,
          isCurrent,
          createSession: async () => `fresh-${++creates}`,
          client: (id) => ({
            history: async () => ({
              sessionId: id,
              messages: [],
              settlements: [],
              running: id === "busy-current",
              compacting: false,
            }),
            send: async (body, key) => {
              admissions.push({ id, body, key });
              if (loseReceipt) {
                loseReceipt = false;
                throw new Error("lost receipt");
              }
              return { submissionId: "accepted" };
            },
          }),
        })
        .then((id) => !!id),
  };
  let dispose = () => {};
  try {
    await settle();
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    const anchor = textSelectionAnchor(document)!;
    const initialRect = anchor.rect()!;
    const anchored = { ...anchor, fallbackRect: initialRect };
    dispose = render(
      () => (
        <>
          <Show when={compact()}>
            <SelectionBubble
              anchor={anchored}
              label="Lines 1–6"
              onHide={() => setCompact(false)}
              onDismiss={() => setCompact(false)}
              onAsk={() => {
                setCompact(false);
                setDraft({ selection, anchor: anchored, state: createSelectionQuestionState() });
              }}
            />
          </Show>
          <Show when={draft()} keyed>
            {(current) => (
              <AnchoredSelectionEditor
                draft={current}
                controller={controller}
                scope={scope()}
                sourceDialogOpen={openModal()}
                isCurrent={() => draft() === current && scope() === current.selection.scope}
                onDismiss={() => setDraft(null)}
              />
            )}
          </Show>
        </>
      ),
      host,
    );
    await settle();
    const bubble = document.querySelector<HTMLElement>('[aria-label="Selection actions"]')!;
    check(
      !!bubble &&
        !bubble.textContent?.includes("RIGHT") &&
        bubble.textContent!.includes("Lines 1–6"),
      "compact UI must use readable line information only",
    );
    const caretX = (initialRect.left + initialRect.right) / 2;
    const bubbleBounds = bubble.getBoundingClientRect();
    check(
      Math.abs((bubbleBounds.left + bubbleBounds.right) / 2 - caretX) < 100,
      "long multiline selection must anchor near the short endpoint fragment",
    );
    bubble.querySelector<HTMLButtonElement>("button")!.click();
    await settle();
    const editor = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[popover][aria-label="Ask about selection"]'),
      ).find((element) => element.querySelector('[title="a.ts"]'));
    const question = () => editor()!.querySelector<HTMLTextAreaElement>("textarea")!;
    check(
      !!editor() && modal.contains(editor()!) && editor()!.matches(":popover-open"),
      "click must expand inside source modal, not the sidebar",
    );
    check(
      document.activeElement === question(),
      "expanded question must auto-focus after the popover becomes visible",
    );
    check(!editor()!.querySelector("details")!.open, "snippet must be collapsed by default");
    question().value = "Explain selected source";
    question().dispatchEvent(new InputEvent("input", { bubbles: true }));
    editor()!.querySelector("select")!.focus();
    const picker = editor()!.querySelector<HTMLSelectElement>("select")!;
    check(
      editor()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled,
      "busy current must keep draft and disable submission",
    );
    picker.value = "new";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    source.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await settle();
    check(!editor(), "outside click must close the expanded editor");
    const resume = Array.from(
      document.querySelectorAll<HTMLElement>('[aria-label="Selection actions"]'),
    ).find((element) => element.textContent?.includes("Resume question"))!;
    resume.querySelector<HTMLButtonElement>("button")!.click();
    await settle();
    check(
      question().value === "Explain selected source" &&
        editor()!.querySelector<HTMLSelectElement>("select")!.value === "new",
      "reopening after outside close must preserve question and target",
    );
    editor()!.querySelector<HTMLFormElement>("form")!.requestSubmit();
    editor()!.querySelector<HTMLFormElement>("form")!.requestSubmit();
    await settle();
    check(
      admissions.length === 1 && creates === 1 && editor()!.innerText.includes("lost receipt"),
      "new target must route once and retain failure",
    );
    check(
      question().value === "Explain selected source",
      "failure must preserve editable question",
    );
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await settle();
    check(!editor(), "failed historical-modal draft must collapse before modal close");
    modal.close();
    source.remove();
    modal.remove();
    setOpenModal(false);
    await settle();
    const relocatedResume = Array.from(
      document.querySelectorAll<HTMLElement>('[aria-label="Selection actions"]'),
    ).find((element) => element.textContent?.includes("Resume question"));
    check(
      !!relocatedResume &&
        relocatedResume.matches(":popover-open") &&
        getComputedStyle(relocatedResume).visibility === "visible" &&
        relocatedResume.getBoundingClientRect().width > 0,
      "collapsed retained draft must stay visible after historical source modal and anchor are removed",
    );
    relocatedResume!.querySelector<HTMLButtonElement>("button")!.click();
    await settle();
    check(
      !!editor() &&
        !modal.contains(editor()!) &&
        question().value === "Explain selected source" &&
        editor()!.innerText.includes("lost receipt"),
      "closing source modal must relocate, not erase, editor state",
    );
    check(
      editor()!.querySelector<HTMLSelectElement>("select")!.value === "new",
      "target must survive portal relocation",
    );
    setScope("other-pr");
    await settle();
    check(
      editor()!.innerText.includes("PR or revision changed") &&
        editor()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled,
      "navigation must retain but disable stale draft",
    );
    setScope("same-scope");
    await settle();
    editor()!.querySelector<HTMLFormElement>("form")!.requestSubmit();
    await settle();
    check(
      !editor() &&
        admissions.length === 2 &&
        creates === 1 &&
        admissions[0]!.key === admissions[1]!.key,
      "retry must reuse the created conversation and admission key, then dismiss on success",
    );
    const context = JSON.parse(admissions[0]!.body.slice(admissions[0]!.body.indexOf("\n{")));
    check(
      context.side === "LEFT" &&
        context.sourceRevision === "historical-head" &&
        context.text === selection.text,
      "UI wording must not change exact internal side/revision/source context",
    );
    return result();
  } finally {
    dispose();
    getSelection()?.removeAllRanges();
    modal.close();
    modal.remove();
  }
}
