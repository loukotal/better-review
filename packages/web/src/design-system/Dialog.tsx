import { createEffect, createUniqueId, onCleanup, type JSX } from "solid-js";

import { IconButton } from "./IconButton";
import { PanelHeader } from "./PanelHeader";
/** Native modal supplies focus containment, Escape, and focus restoration. */
export function Dialog(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: JSX.Element;
}) {
  let element!: HTMLDialogElement;
  const titleId = createUniqueId();
  createEffect(() => {
    if (props.open && !element.open) element.showModal();
    if (!props.open && element.open) element.close();
  });
  onCleanup(() => {
    if (element.open) element.close();
  });
  return (
    <dialog
      ref={(el) => {
        element = el;
      }}
      aria-label={props.title}
      id={titleId}
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
      class="m-auto w-[min(28rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-lg border border-border bg-bg-surface p-0 text-text backdrop:bg-black/60"
    >
      <PanelHeader
        title={props.title}
        actions={
          <IconButton label="Close dialog" onClick={props.onClose}>
            ×
          </IconButton>
        }
      />
      <div class="p-4">{props.children}</div>
    </dialog>
  );
}
