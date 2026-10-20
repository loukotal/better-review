import { For } from "solid-js";
import { render } from "solid-js/web";

import { GithubSyncStatus, type GithubSyncState } from "./GithubSyncStatus";

declare global {
  interface Window {
    setBrowserMotionPreference(value: "reduce" | "no-preference"): Promise<void>;
  }
}

/** Verify production CSS actually animates the visible SVG, not only class strings. */
export async function testGithubSyncMotionInBrowser() {
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
    "retry-pending",
    "retry-failed",
    "uncertain",
    "synced",
    "cancelled",
  ];
  const host = document.createElement("div");
  document.body.append(host);
  const dispose = render(
    () => (
      <For each={states}>{(state) => <GithubSyncStatus status={state} iconOnly showSynced />}</For>
    ),
    host,
  );
  try {
    for (const preference of ["no-preference", "reduce"] as const) {
      await window.setBrowserMotionPreference(preference);
      await new Promise(requestAnimationFrame);
      for (const state of states) {
        const status = host.querySelector<HTMLElement>(`[data-github-sync-status="${state}"]`)!;
        const icon = status.querySelector("svg")!;
        const css = getComputedStyle(icon);
        const expected =
          preference === "reduce"
            ? "none"
            : ["saving-local", "local-pending", "queued", "inflight", "retry-pending"].includes(
                  state,
                )
              ? "spin"
              : "none";
        check(
          css.animationName === expected,
          `${preference}/${state}: actual animation=${css.animationName}, expected=${expected}`,
        );
        check(
          status.querySelectorAll("svg").length === 1 && !status.innerText.trim(),
          `${state} added duplicate icon or visible status prose`,
        );
        if (expected !== "none")
          check(parseFloat(css.animationDuration) > 0, `${state} animation has no duration`);
        if (expected === "spin") {
          check(css.animationDelay === "0s", `${state} delayed animation`);
          check(css.animationTimingFunction === "linear", `${state} non-linear animation`);
          check(css.animationIterationCount === "infinite", `${state} finite animation`);
          check(
            css.transformOrigin === "6px 6px",
            `Sending icon does not rotate about its center: ${css.transformOrigin}`,
          );
        }
      }
    }
    return { passed };
  } finally {
    await window.setBrowserMotionPreference("reduce");
    dispose();
    host.remove();
  }
}

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
    "retry-pending",
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
          icon.classList.contains("animate-spin") ===
            ["saving-local", "local-pending", "queued", "inflight", "retry-pending"].includes(
              state,
            ),
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
        .length === 1,
      "Missing non-color warning icon",
    );
    return { passed };
  } finally {
    dispose();
    host.remove();
  }
}
