import { For } from "solid-js";
import { render } from "solid-js/web";

import { createAssertions } from "../browser-tests/assertions";
import type { BrowserGithubOperation } from "../lib/github-outbox";
import {
  GithubSyncStatus,
  githubOperationSyncState,
  type GithubSyncState,
} from "./GithubSyncStatus";

export function testGithubAdmissionRetryabilityLabelsInBrowser() {
  const { check, result } = createAssertions(3000);
  const base: BrowserGithubOperation = {
    command: {
      operationId: "11111111-1111-4111-8111-111111111111",
      scope: {
        host: "github.com",
        owner: "fixture",
        repo: "fixture",
        number: 1,
        url: "https://github.com/fixture/fixture/pull/1",
      },
      expectedActor: { id: 42, login: "fixture" },
      action: { kind: "issue-comment", body: "Saved draft" },
      dependencies: [],
    },
    backendOwned: false,
    status: "local-pending",
    admissionError: "A known GitHub identity is required before admission.",
    admissionRetryable: true,
  };
  const verifying = githubOperationSyncState(base);
  const rejected = githubOperationSyncState({
    ...base,
    admissionError: "Saved edit no longer matches GitHub",
    admissionRetryable: false,
  });
  const blocked = githubOperationSyncState({
    ...base,
    blockedByOperationId: "22222222-2222-4222-8222-222222222222",
  });
  check(
    !(verifying !== "verifying-account" || rejected !== "retry-failed" || blocked !== "blocked"),
    "Admission retryability/blocker hook not reflected in UI states",
  );
  const host = document.createElement("div");
  document.body.append(host);
  const dispose = render(
    () => (
      <>
        <GithubSyncStatus status={verifying} iconOnly />
        <GithubSyncStatus status={rejected} iconOnly />
        <GithubSyncStatus status={blocked} iconOnly />
      </>
    ),
    host,
  );
  try {
    check(
      host
        .querySelector('[data-github-sync-status="verifying-account"]')
        ?.getAttribute("aria-label")
        ?.includes("account verification"),
      "Verifying account mislabeled as permanent rejection or sending",
    );
    check(
      host
        .querySelector('[data-github-sync-status="retry-failed"]')
        ?.getAttribute("aria-label")
        ?.includes("action needed"),
      "Permanent rejection mislabeled as active sync",
    );
    check(
      ![...host.querySelectorAll("svg")].some(
        (icon) => getComputedStyle(icon).animationName === "spin",
      ),
      "Waiting/rejected/blocked admission falsely spins as active sending",
    );
    return result();
  } finally {
    dispose();
    host.remove();
  }
}

declare global {
  interface Window {
    setBrowserMotionPreference(value: "reduce" | "no-preference"): Promise<void>;
  }
}

/** Verify production CSS actually animates the visible SVG, not only class strings. */
export async function testGithubSyncMotionInBrowser() {
  const { check, result } = createAssertions(3000);
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
    "blocked",
    "verifying-account",
  ];
  const host = document.createElement("div");
  document.body.append(host);
  const otherMotion = document.createElement("span");
  otherMotion.className = "animate-spin inline-block";
  const dispose = render(
    () => (
      <For each={states}>{(state) => <GithubSyncStatus status={state} iconOnly showSynced />}</For>
    ),
    host,
  );
  host.append(otherMotion);
  try {
    for (const preference of ["no-preference", "reduce"] as const) {
      await window.setBrowserMotionPreference(preference);
      await new Promise(requestAnimationFrame);
      const otherCss = getComputedStyle(otherMotion);
      check(
        preference === "reduce"
          ? parseFloat(otherCss.animationDuration) <= 0.001 &&
              otherCss.animationIterationCount === "1"
          : otherCss.animationIterationCount === "infinite",
        "Sync exception changed unrelated app motion",
      );
      for (const state of states) {
        const status = host.querySelector<HTMLElement>(`[data-github-sync-status="${state}"]`)!;
        const icon = status.querySelector("svg")!;
        const css = getComputedStyle(icon);
        const expected = [
          "saving-local",
          "local-pending",
          "queued",
          "inflight",
          "retry-pending",
        ].includes(state)
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
      const samples = states.map((state) => {
        const icon = host.querySelector<SVGSVGElement>(`[data-github-sync-status="${state}"] svg`)!;
        const animation = icon.getAnimations()[0];
        return {
          state,
          icon,
          animation,
          time: Number(animation?.currentTime),
          transform: getComputedStyle(icon).transform,
        };
      });
      await new Promise((resolve) => setTimeout(resolve, 240));
      await new Promise(requestAnimationFrame);
      for (const sample of samples) {
        const moving = [
          "saving-local",
          "local-pending",
          "queued",
          "inflight",
          "retry-pending",
        ].includes(sample.state);
        check(
          moving
            ? sample.animation?.playState === "running" &&
                Number(sample.animation.currentTime) - sample.time >= 200 &&
                getComputedStyle(sample.icon).transform !== sample.transform
            : sample.icon.getAnimations().length === 0 &&
                getComputedStyle(sample.icon).transform === sample.transform,
          `${preference}/${sample.state}: expected ${moving ? "visible rotation" : "static icon"}`,
        );
      }
    }
    return result();
  } finally {
    await window.setBrowserMotionPreference("reduce");
    dispose();
    host.remove();
  }
}

/** Visual state sheet uses production SVGs and CSS, with no network requests. */
export function testGithubSyncStatusInBrowser() {
  const { check, result } = createAssertions(3000);
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
    "blocked",
    "verifying-account",
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
        check(
          getComputedStyle(icon).animationName ===
            (icon.classList.contains("animate-spin") ? "spin" : "none"),
          `Incorrect sync motion for ${state}`,
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
    return result();
  } finally {
    dispose();
    host.remove();
  }
}
