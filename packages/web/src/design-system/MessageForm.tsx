import { createSignal, splitProps, type JSX } from "solid-js";

import { canSubmitMessage, handleMessageSubmitKeyDown } from "./message-submit";

/** Opt-in message editor: native validation + submit buttons for clicks and Cmd/Ctrl+Enter. */
export function MessageForm(
  props: Omit<JSX.FormHTMLAttributes<HTMLFormElement>, "onSubmit" | "onKeyDown"> & {
    onSubmit: (event: SubmitEvent) => void | Promise<void>;
  },
) {
  const [local, rest] = splitProps(props, ["onSubmit"]);
  const [pending, setPending] = createSignal(false);
  return (
    <form
      {...rest}
      aria-busy={pending() ? true : props["aria-busy"]}
      onKeyDown={handleMessageSubmitKeyDown}
      onSubmit={async (event) => {
        event.preventDefault();
        const submitter = event.submitter as HTMLButtonElement | HTMLInputElement | null;
        if (pending() || !canSubmitMessage(event.currentTarget, submitter ?? undefined)) return;
        setPending(true);
        try {
          await local.onSubmit(event);
        } finally {
          setPending(false);
        }
      }}
    />
  );
}
