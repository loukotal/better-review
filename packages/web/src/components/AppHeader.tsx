import { A } from "@solidjs/router";
import { Show, type JSX } from "solid-js";

import { Button } from "../design-system";
import { ThemeToggle } from "./ThemeToggle";

/** Shared application navigation; page tools live in the actions slot. */
export function AppHeader(props: {
  actions?: JSX.Element;
  children?: JSX.Element;
  constrained?: boolean;
  onOpenPr?: () => void;
  prSwitcherOpen?: boolean;
}) {
  return (
    <header class="shrink-0 border-b border-border bg-bg-surface">
      <div
        class={`flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2 ${props.constrained ? "mx-auto max-w-6xl" : ""}`}
      >
        <A href="/" aria-label="Better Review home" class="flex shrink-0 items-center gap-2.5 py-1">
          <span class="size-2 bg-accent" aria-hidden="true" />
          <span class="font-mono text-sm font-semibold tracking-tight text-text">
            better-review
          </span>
        </A>
        <div class="flex flex-wrap items-center gap-3">
          <Show when={props.actions}>
            <div role="group" aria-label="Page tools" class="flex flex-wrap items-center gap-1">
              {props.actions}
            </div>
          </Show>
          <nav aria-label="Main navigation" class="flex items-center gap-1 text-xs">
            <A
              href="/"
              end
              activeClass="bg-bg-elevated text-text"
              inactiveClass="text-text-muted"
              class="rounded-md px-2 py-1.5 hover:text-text"
            >
              Reviews
            </A>

            <Show
              when={props.onOpenPr}
              fallback={
                <A
                  href="/review"
                  activeClass="bg-bg-elevated text-text"
                  inactiveClass="text-text-muted"
                  class="rounded-md px-2 py-1.5 hover:text-text"
                >
                  Open PR
                </A>
              }
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={props.onOpenPr}
                aria-expanded={props.prSwitcherOpen}
                aria-controls="pr-switcher"
              >
                Open PR
              </Button>
            </Show>
            <ThemeToggle />
          </nav>
        </div>
      </div>
      {props.children}
    </header>
  );
}
