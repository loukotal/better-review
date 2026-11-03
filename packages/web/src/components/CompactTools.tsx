import { createSignal, createUniqueId, type JSX } from "solid-js";

import { Button } from "../design-system";

/** Keep secondary tools out of the code's way on phones, without remounting editors. */
export function CompactTools(props: { children: JSX.Element; label?: string }) {
  const [open, setOpen] = createSignal(false);
  const id = createUniqueId();
  return (
    <div class="compact-tools">
      <Button
        size="sm"
        variant="ghost"
        class="sm:hidden"
        aria-expanded={open()}
        aria-controls={id}
        onClick={() => setOpen(!open())}
      >
        {props.label ?? "Review tools"} {open() ? "▴" : "▾"}
      </Button>
      <div id={id} class={`${open() ? "flex" : "hidden"} flex-wrap items-center gap-2 sm:flex`}>
        {props.children}
      </div>
    </div>
  );
}
