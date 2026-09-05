import {
  createEffect,
  createSignal,
  createUniqueId,
  type JSX,
  type ComponentProps,
  onCleanup,
} from "solid-js";

import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { PanelHeader } from "./PanelHeader";

/** Native top-layer popover: outside dismissal, Escape, and no panel clipping. */
export function Popover(props: {
  label: string;
  trigger?: JSX.Element;
  children: JSX.Element | ((close: () => void) => JSX.Element);
  width?: number;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  triggerVariant?: ComponentProps<typeof Button>["variant"];
  triggerSize?: ComponentProps<typeof Button>["size"];
  align?: "left" | "right";
}) {
  const id = createUniqueId();
  let panel!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  const [open, setOpen] = createSignal(false);
  const [position, setPosition] = createSignal({ left: "0px", top: "0px" });
  const [availableHeight, setAvailableHeight] = createSignal(400);
  const place = () => {
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(props.width ?? 300, window.innerWidth - 24);
    const below = window.innerHeight - rect.bottom - 20;
    const above = rect.top - 20;
    const flip = below < 240 && above > below;
    const available = Math.max(80, flip ? above : below);
    const height = Math.min(panel.scrollHeight || 400, available);
    setAvailableHeight(available);
    setPosition({
      left: `${Math.max(12, Math.min(props.align === "left" ? rect.left : rect.right - width, window.innerWidth - width - 12))}px`,
      top: `${flip ? Math.max(12, rect.top - height - 8) : rect.bottom + 8}px`,
    });
  };
  const close = () => {
    panel.hidePopover();
    trigger.focus();
  };
  createEffect(() => {
    if (props.open === undefined) return;
    if (props.open && !panel.matches(":popover-open")) {
      place();
      panel.showPopover();
    }
    if (!props.open && panel.matches(":popover-open")) {
      panel.hidePopover();
      trigger.focus();
    }
  });
  onCleanup(() => window.removeEventListener("resize", place));
  return (
    <>
      <Button
        ref={(el) => {
          trigger = el;
        }}
        type="button"
        variant={props.triggerVariant ?? "ghost"}
        size={props.triggerSize ?? (props.trigger ? "icon" : "sm")}
        disabled={props.disabled}
        aria-label={props.label}
        title={props.label}
        aria-expanded={open()}
        aria-controls={id}
        popovertarget={id}
        onClick={place}
      >
        {props.trigger ?? props.label}
      </Button>
      <div
        ref={(el) => {
          panel = el;
        }}
        id={id}
        popover="auto"
        role="dialog"
        aria-label={props.label}
        onToggle={() => {
          const visible = panel.matches(":popover-open");
          setOpen(visible);
          props.onOpenChange?.(visible);
          if (visible) {
            place();
            window.addEventListener("resize", place);
          } else window.removeEventListener("resize", place);
        }}
        class="m-0 rounded-lg border border-border bg-bg-surface p-0 text-text"
        style={{
          position: "fixed",
          inset: "auto",
          ...position(),
          width: `${props.width ?? 300}px`,
          "max-width": "calc(100vw - 24px)",
          "max-height": `${availableHeight()}px`,
          "overflow-y": "auto",
        }}
      >
        <PanelHeader
          title={props.label}
          actions={
            <IconButton label={`Close ${props.label.toLowerCase()}`} onClick={close}>
              ×
            </IconButton>
          }
        />
        <div class="p-3">
          {typeof props.children === "function" ? props.children(close) : props.children}
        </div>
      </div>
    </>
  );
}
