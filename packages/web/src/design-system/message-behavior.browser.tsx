/** UI contracts use local callbacks only; no GitHub mutations or LLM requests. */
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

import { CommentThread, CommentView, PendingCommentForm } from "../components/CommentView";
import { PrCommentsPanel } from "../components/PrCommentsPanel";
import { Dialog } from "./Dialog";
import { MessageForm } from "./MessageForm";
import { Popover } from "./Popover";
import { Textarea } from "./Textarea";

export async function testMessageBehaviorInBrowser() {
  let passed = 0;
  const check = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message);
    passed++;
  };
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const key = (element: Element, extra: KeyboardEventInit = {}) =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        bubbles: true,
        cancelable: true,
        ...extra,
      }),
    );
  const host = document.createElement("div");
  document.body.append(host);
  let dispose = () => {};
  const mount = (view: Parameters<typeof render>[0]) => {
    dispose();
    host.replaceChildren();
    dispose = render(view, host);
  };
  const button = (text: string) =>
    Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.trim() === text)!;
  const input = (value: string) => {
    const textarea = host.querySelector("textarea")!;
    textarea.value = value;
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    return textarea;
  };
  try {
    let calls = 0;
    let release = () => {};
    mount(() => (
      <MessageForm
        onSubmit={() => {
          calls++;
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        }}
      >
        <Textarea required />
        <input type="search" />
        <button type="submit">Send</button>
      </MessageForm>
    ));
    let textarea = host.querySelector("textarea")!;
    key(textarea);
    check(calls === 0, "shortcut must respect native required validation");
    textarea = input("message");
    for (const modifiers of [
      { metaKey: false },
      { isComposing: true },
      { repeat: true },
      { shiftKey: true },
      { altKey: true },
    ])
      key(textarea, modifiers);
    key(host.querySelector("input")!);
    check(calls === 0, "plain/composing/repeated keys and search inputs must not submit");
    textarea.readOnly = true;
    key(textarea);
    check(calls === 0, "readonly editor must not submit");
    textarea.readOnly = false;
    key(textarea, { metaKey: false, ctrlKey: true });
    key(textarea);
    button("Send").click();
    check(calls === 1, "Ctrl+Enter sends once; repeated shortcut and click blocked while pending");
    release();
    await settle();
    button("Send").disabled = true;
    key(textarea);
    check(calls === 1, "disabled submit button cannot be bypassed");
    button("Send").disabled = false;
    host.querySelector("form")!.setAttribute("aria-busy", "true");
    key(textarea);
    check(calls === 1, "busy form cannot be submitted");

    mount(() => (
      <MessageForm
        onSubmit={() => {
          calls++;
        }}
      >
        <fieldset disabled>
          <Textarea />
          <button type="submit">Send</button>
        </fieldset>
      </MessageForm>
    ));
    key(input("fieldset disabled"));
    check(calls === 1, "disabled fieldset must disable shortcut submission");

    let selected = "";
    mount(() => (
      <MessageForm
        onSubmit={(event) => {
          selected = (event.submitter as HTMLButtonElement).value;
        }}
      >
        <Textarea />
        <button type="submit" value="approve">
          Approve
        </button>
        <button type="submit" data-default-submit value="changes">
          Request Changes
        </button>
      </MessageForm>
    ));
    key(input("verdict"));
    check(selected === "changes", "shortcut must pass the explicit default submitter");
    await settle();
    button("Approve").click();
    check(selected === "approve", "explicit secondary action must retain its own submitter");

    let saves = 0;
    mount(() => (
      <PendingCommentForm
        startLine={1}
        endLine={2}
        onCancel={() => {}}
        onSubmit={async () => {
          saves++;
          throw new Error("Save failed");
        }}
      />
    ));
    key(input("keep my draft"));
    await settle();
    check(
      saves === 1 &&
        host.querySelector("textarea")!.value === "keep my draft" &&
        host.textContent!.includes("Save failed"),
      "inline consumer must retain error and draft after shortcut failure",
    );
    key(input("retry"), { metaKey: false, ctrlKey: true });
    await settle();
    check(saves === 2, "inline consumer supports Ctrl+Enter retry");

    const comment = {
      id: 1,
      body: "Original",
      html_url: "#",
      user: { login: "reviewer", avatar_url: "" },
      created_at: new Date().toISOString(),
      canEdit: true,
    };
    let edited = "";
    mount(() => (
      <CommentView
        comment={comment}
        onEdit={async (_id, body) => {
          edited = body;
        }}
      />
    ));
    button("Edit").click();
    key(input("Updated"));
    await settle();
    check(
      edited === "Updated" && !host.querySelector("textarea"),
      "comment edit shortcut must save and close editing",
    );
    let replied = "";
    mount(() => (
      <CommentThread
        rootComment={comment}
        replies={[]}
        onEdit={async () => {}}
        onDelete={async () => {}}
        onReply={async (body) => {
          replied = body;
        }}
      />
    ));
    button("Reply").click();
    key(input("Thread reply"), { metaKey: false, ctrlKey: true });
    await settle();
    check(replied === "Thread reply", "thread reply consumer supports native shortcut submission");

    let posted = "";
    mount(() => (
      <PrCommentsPanel
        embedded
        comments={[]}
        onAddComment={async (body) => {
          posted = body;
        }}
      />
    ));
    button("+ Add comment").click();
    key(input("Conversation comment"));
    await settle();
    check(posted === "Conversation comment", "conversation comment consumer supports shortcut");

    const [open, setOpen] = createSignal(true);
    let closes = 0;
    mount(() => (
      <Dialog
        open={open()}
        onClose={() => {
          closes++;
          setOpen(false);
        }}
        title="Behavior contract"
      >
        <button type="button">Inside</button>
      </Dialog>
    ));
    await settle();
    const dialog = host.querySelector("dialog")!;
    button("Inside").click();
    check(closes === 0 && dialog.open, "inside controls never close a dialog");
    const rect = dialog.getBoundingClientRect();
    const outside = { clientX: rect.left - 5, clientY: rect.top - 5, bubbles: true };
    dialog.dispatchEvent(
      new PointerEvent("pointerdown", {
        clientX: rect.left + 5,
        clientY: rect.top + 5,
        bubbles: true,
      }),
    );
    dialog.dispatchEvent(new MouseEvent("click", outside));
    check(closes === 0, "dragging from inside to backdrop must not close");
    dialog.dispatchEvent(new PointerEvent("pointerdown", outside));
    dialog.dispatchEvent(new MouseEvent("click", outside));
    check(closes === 1 && !dialog.open, "actual outside start and click close shared dialog");
    setOpen(true);
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    check(closes === 2 && !dialog.open, "native Escape cancellation uses the same close callback");

    mount(() => (
      <Popover label="Behavior popover">
        <button type="button">Inside popover</button>
      </Popover>
    ));
    button("Behavior popover").click();
    const popover = host.querySelector<HTMLElement>("[popover]")!;
    await settle();
    button("Inside popover").click();
    check(popover.matches(":popover-open"), "native popover inside control stays open");
    button("×").click();
    check(!popover.matches(":popover-open"), "popover explicit close still works");
    return { passed };
  } finally {
    dispose();
    host.remove();
  }
}

/** Mount for trusted CDP pointer/key verification; caller must invoke dispose. */
export function mountDismissalFixtureInBrowser() {
  const host = document.createElement("div");
  host.id = "dismissal-contract";
  host.style.cssText = "position:fixed;inset:0;z-index:9999;background:white;color:black";
  document.body.append(host);
  const [open, setOpen] = createSignal(false);
  let closes = 0;
  const dispose = render(
    () => (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open contract dialog
        </button>
        <Popover label="Contract popover">
          <button type="button">Keep popover open</button>
        </Popover>
        <Dialog
          title="Contract dialog"
          open={open()}
          onClose={() => {
            closes++;
            setOpen(false);
          }}
        >
          <button type="button">Keep dialog open</button>
        </Dialog>
      </>
    ),
    host,
  );
  return {
    host,
    closes: () => closes,
    dispose: () => {
      dispose();
      host.remove();
    },
  };
}
