/** Real-browser geometry, selection preservation and lifecycle checks; no network/admission. */
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";

import { textSelectionAnchor } from "../lib/selection-bubble";
import { SelectionBubble } from "./SelectionBubble";

export async function testSelectionBubbleInactiveReviewInBrowser() {
  const shell = document.createElement("div");
  const source = document.createElement("div");
  shell.append(source);
  const shadow = source.attachShadow({ mode: "open" });
  shadow.innerHTML = "<span>selected</span>";
  const mount = document.createElement("div");
  document.body.append(shell, mount);
  let dismissed = 0;
  const dispose = render(
    () => (
      <SelectionBubble
        anchor={{ root: shadow, rect: () => ({ left: 20, right: 120, top: 100, bottom: 120 }) }}
        retained
        expanded
        onHide={() => {}}
        onDismiss={() => dismissed++}
      >
        <textarea>Retained question</textarea>
      </SelectionBubble>
    ),
    mount,
  );
  const settle = async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  };
  try {
    await settle();
    if (!mount.querySelector(":popover-open")) throw new Error("Selection editor did not open");
    shell.inert = true;
    await settle();
    if (mount.querySelector(":popover-open"))
      throw new Error("Inactive Changes leaked top-layer selection editor");
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    if (event.defaultPrevented || dismissed)
      throw new Error("Inactive selection editor intercepted keyboard");
    shell.inert = false;
    await settle();
    if (
      !mount.querySelector(":popover-open") ||
      mount.querySelector("textarea")?.value !== "Retained question"
    )
      throw new Error(
        `Reactivated editor lost question draft: open=${!!mount.querySelector(":popover-open")} value=${mount.querySelector("textarea")?.value} inert=${shell.inert}`,
      );
    return { passed: 4 };
  } finally {
    dispose();
    shell.remove();
    mount.remove();
  }
}

export async function testSelectionBubbleInBrowser() {
  let passed = 0;
  const check = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message);
    passed++;
  };
  const settle = async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  };
  const dialog = document.createElement("dialog");
  dialog.style.cssText = "padding:20px;margin:50px;width:400px;height:220px;overflow:auto";
  document.body.append(dialog);
  dialog.showModal();
  const source = document.createElement("div");
  source.style.cssText = "height:80px;overflow:auto";
  dialog.append(source);
  const shadow = source.attachShadow({ mode: "open" });
  shadow.innerHTML = '<div style="height:500px"><span>selected source text</span></div>';
  let text: Node = shadow.querySelector("span")!.firstChild!;
  const mount = document.createElement("div");
  dialog.append(mount);
  const [anchor, setAnchor] = createSignal<ReturnType<typeof textSelectionAnchor>>(null);
  let quotedDraft = "existing question draft";
  let asked = 0;
  const dispose = render(
    () => (
      <Show when={anchor()}>
        {(current) => (
          <SelectionBubble
            anchor={current()}
            label="RIGHT 1–1"
            onHide={() => setAnchor(null)}
            onDismiss={() => {
              setAnchor(null);
              window.getSelection()?.removeAllRanges();
            }}
            onAsk={() => {
              asked++;
              quotedDraft = window.getSelection()?.toString() ?? "";
              setAnchor(null);
            }}
          />
        )}
      </Show>
    ),
    mount,
  );
  const select = () => {
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    setAnchor(textSelectionAnchor(shadow));
  };
  const bubble = () => mount.querySelector<HTMLElement>('[aria-label="Selection actions"]');
  try {
    // Let showModal focus/scroll restoration (and previous suite cleanup) settle
    // before offering a candidate; real scroll correctly dismisses active bubbles.
    await settle();
    const before = source.getBoundingClientRect().toJSON();
    select();
    await settle();
    const first = bubble()!;
    check(
      !!first && first.matches(":popover-open"),
      "bubble must appear in native modal top layer",
    );
    check(
      getComputedStyle(first).visibility === "visible",
      `DOMRect-backed shadow selection must position visibly: ${JSON.stringify({ rect: anchor()?.rect(), bubble: first.outerHTML })}`,
    );
    const bounds = first.getBoundingClientRect();
    check(
      bounds.width > 0 && bounds.left >= 8 && bounds.right <= innerWidth - 8,
      "viewport-clamped bubble bounds",
    );
    check(
      JSON.stringify(source.getBoundingClientRect().toJSON()) === JSON.stringify(before),
      "bubble must cause no layout shift",
    );
    const pointer = new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    first.querySelector("button")!.dispatchEvent(pointer);
    check(
      pointer.defaultPrevented && getSelection()!.toString() === "selected source text",
      "pointer activation must preserve native selection",
    );
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true }),
    );
    check(
      document.activeElement === first.querySelector("button"),
      "Alt+Enter must focus the keyboard action",
    );
    first
      .querySelector("button")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      );
    check(
      document.activeElement?.getAttribute("aria-label") === "Dismiss selection actions",
      "toolbar arrow navigation reaches accessible close action",
    );
    first.querySelector<HTMLButtonElement>("button")!.click();
    check(
      asked === 1 && quotedDraft === "selected source text" && !bubble(),
      "Ask opens the external composer with the exact quote and hides only candidate",
    );
    select();
    await settle();
    source.dispatchEvent(new Event("scroll"));
    await settle();
    check(
      !bubble() && quotedDraft === "selected source text",
      "nested scroll dismisses candidate without losing an open draft",
    );
    select();
    await settle();
    window.dispatchEvent(new Event("resize"));
    await settle();
    check(!!bubble(), "resize repositions a valid anchor");
    const nextRange = document.createRange();
    nextRange.setStart(text, 0);
    nextRange.setEnd(text, 3);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(nextRange);
    document.dispatchEvent(new Event("selectionchange"));
    await settle();
    check(!bubble(), "new native selection invalidates the previous range anchor");
    select();
    await settle();
    const otherMount = document.createElement("div");
    dialog.append(otherMount);
    const otherAnchor = textSelectionAnchor(shadow)!;
    const disposeOther = render(
      () => (
        <SelectionBubble
          anchor={otherAnchor}
          onAsk={() => {}}
          onHide={() => {}}
          onDismiss={() => {}}
        />
      ),
      otherMount,
    );
    await settle();
    check(
      !bubble() &&
        document.querySelectorAll('[aria-label="Selection actions"]:popover-open').length === 1,
      "a newer file candidate must replace the previous bubble, not duplicate it",
    );
    disposeOther();
    otherMount.remove();
    select();
    await settle();
    const replacement = text.cloneNode(true);
    text.parentNode!.replaceChild(replacement, text);
    text = replacement;
    await settle();
    check(!!bubble(), "identical source DOM refresh must preserve the captured candidate");
    source.remove();
    await settle();
    check(!bubble(), "removing the shadow host must remove stale anchor actions");
    dialog.append(source);
    select();
    await settle();
    bubble()!.querySelector<HTMLButtonElement>('[aria-label="Dismiss selection actions"]')!.click();
    check(
      !bubble() && getSelection()!.isCollapsed,
      "accessible close explicitly dismisses selection",
    );
    select();
    await settle();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    check(!bubble() && dialog.open, "Escape dismisses bubble without closing source modal");
    select();
    await settle();
    dispose();
    await settle();
    check(!bubble(), "unmount removes the popover and its lifecycle");
    return { passed };
  } finally {
    dispose();
    getSelection()?.removeAllRanges();
    dialog.close();
    dialog.remove();
  }
}
