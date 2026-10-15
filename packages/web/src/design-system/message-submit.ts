/** Shared by message forms only, never installed as a document-wide shortcut. */
export function isMessageSubmitShortcut(event: KeyboardEvent): boolean {
  return (
    event.key === "Enter" &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    !event.repeat &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    !event.defaultPrevented
  );
}

export function messageSubmitter(
  form: HTMLFormElement,
): HTMLButtonElement | HTMLInputElement | null {
  const controls = Array.from(form.elements).filter(
    (element): element is HTMLButtonElement | HTMLInputElement =>
      (element.tagName === "BUTTON" || element.tagName === "INPUT") &&
      (element as HTMLButtonElement).type === "submit",
  );
  // A disabled primary action must not fall through to some other action.
  return (
    controls.find((element) => element.hasAttribute("data-default-submit")) ?? controls[0] ?? null
  );
}

export function canSubmitMessage(
  form: HTMLFormElement,
  submitter = messageSubmitter(form),
): boolean {
  return (
    !!submitter && !submitter.matches(":disabled") && form.getAttribute("aria-busy") !== "true"
  );
}

export function handleMessageSubmitKeyDown(event: KeyboardEvent) {
  if (!isMessageSubmitShortcut(event)) return;
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement) || target.disabled || target.readOnly) return;
  const form = target.form;
  if (!form || event.currentTarget !== form) return;
  event.preventDefault();
  const submitter = messageSubmitter(form);
  if (canSubmitMessage(form, submitter)) form.requestSubmit(submitter!);
}
