import { For } from "solid-js";
import { render } from "solid-js/web";

import { GithubSyncStatus, type GithubSyncState } from "./GithubSyncStatus";

/** Visual state sheet uses production SVGs and CSS, with no network requests. */
export function testGithubSyncStatusInBrowser() {
  let passed = 0;
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    passed++;
  };
  const states: GithubSyncState[] = [
    "saving-local",
    "local-pending",
    "queued",
    "inflight",
    "retry-failed",
    "uncertain",
    "synced",
    "cancelled",
  ];
  const host = document.createElement("section");
  host.setAttribute("aria-label", "GitHub sync visual states");
  host.className = "space-y-3 p-4 bg-bg-surface";
  document.body.append(host);
  const dispose = render(
    () => (
      <>
        <For each={states}>
          {(state) => (
            <div class="flex items-center gap-3">
              <GithubSyncStatus status={state} showSynced />
              <GithubSyncStatus status={state} iconOnly showSynced />
            </div>
          )}
        </For>
        <div data-default-synced>
          <GithubSyncStatus status="synced" />
        </div>
      </>
    ),
    host,
  );
  try {
    for (const state of states) {
      const statuses = host.querySelectorAll<HTMLElement>(`[data-github-sync-status="${state}"]`);
      check(statuses.length === 2, `Missing state ${state}`);
      for (const status of statuses) {
        check(
          status.getAttribute("role") === "status" && !!status.getAttribute("aria-label"),
          `Missing accessible status ${state}`,
        );
        check(
          status.title === status.getAttribute("aria-label"),
          `Tooltip differs from accessible label ${state}`,
        );
        const icon = status.querySelector("svg")!;
        check(icon.closest('[aria-hidden="true"]'), `Decorative SVG announced for ${state}`);
        check(
          icon.classList.contains("animate-spin") === (state === "inflight"),
          `False activity for ${state}`,
        );
        if (matchMedia("(prefers-reduced-motion: reduce)").matches)
          check(
            getComputedStyle(icon).animationName === "none",
            `Reduced motion ignored for ${state}`,
          );
      }
    }
    check(
      !host.querySelector("[data-default-synced] [role=status]"),
      "Synced status adds default clutter",
    );
    check(
      host
        .querySelector('[data-github-sync-status="uncertain"]')
        ?.textContent?.includes("do not resend"),
      "Missing uncertain warning",
    );
    check(
      host.querySelector('[data-github-sync-status="retry-failed"]')?.querySelectorAll("svg")
        .length === 2,
      "Missing non-color warning icon",
    );
    return { passed };
  } finally {
    dispose();
    host.remove();
  }
}
