import { createSignal } from "solid-js";
import { render } from "solid-js/web";

import type { PrDetailCheck, PrDetailSection } from "@better-review/shared";

import { PrChecks } from "../components/PrChecks";

/** No App, query cache, or PR read owner: isolate native details event ordering. */
export async function testPrCheckGroupsKeepUserToggleBeforeOtherGroupsInitialToggleInBrowser() {
  const initial: PrDetailSection<PrDetailCheck[]> = {
    status: "available",
    complete: true,
    data: [
      {
        id: "failed",
        kind: "check-run",
        name: "Failed",
        status: "COMPLETED",
        conclusion: "FAILURE",
        url: null,
      },
      {
        id: "running",
        kind: "check-run",
        name: "Running",
        status: "IN_PROGRESS",
        conclusion: null,
        url: null,
      },
      {
        id: "passed",
        kind: "check-run",
        name: "Passed",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        url: null,
      },
      {
        id: "skipped",
        kind: "check-run",
        name: "Skipped",
        status: "COMPLETED",
        conclusion: "SKIPPED",
        url: null,
      },
    ],
  };
  const [checks, setChecks] = createSignal(initial);
  const [refreshing, setRefreshing] = createSignal(false);
  let refreshes = 0;
  const root = document.createElement("div");
  document.getElementById("root")!.append(root);
  const dispose = render(
    () => (
      <PrChecks
        checks={checks()}
        refreshing={refreshing()}
        onRefresh={() => {
          refreshes++;
          setRefreshing(true);
          queueMicrotask(() => {
            setChecks(structuredClone(initial));
            setRefreshing(false);
          });
        }}
      />
    ),
    root,
  );
  const check = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message);
  };
  try {
    const groups = [...root.querySelectorAll("details")];
    const passed = groups.find((group) =>
      group.querySelector("summary")?.textContent?.startsWith("Passed"),
    )!;
    const failed = groups.find((group) =>
      group.querySelector("summary")?.textContent?.startsWith("Failed"),
    )!;
    check(!passed.open && failed.open, "Initial failure/passed group defaults changed");
    const toggled = new Promise<void>((resolve) =>
      passed.addEventListener("toggle", () => resolve(), { once: true }),
    );
    passed.querySelector("summary")!.click();
    check(passed.open, "User click did not open Passed synchronously");
    // Reproduce delivery of another group's queued initial toggle before the
    // user's native toggle event. That event must not reapply Passed's default.
    failed.dispatchEvent(new Event("toggle"));
    check(
      passed.open && passed.isConnected,
      "Another group's initial toggle erased the user's pending expansion",
    );
    await toggled;
    check(passed.open, "Native toggle settlement erased the user's expansion");
    root.querySelector<HTMLButtonElement>("button")!.click();
    await Promise.resolve();
    check(
      refreshes === 1 && !root.querySelector<HTMLButtonElement>("button")!.disabled,
      "Read-only refresh did not settle exactly once",
    );
    check(
      passed.open && passed.isConnected,
      "Refreshing replaced or closed the expanded Passed group",
    );
    setChecks({ ...initial, data: [] });
    check(!root.querySelector("details"), "Empty checks did not remove groups");
    setChecks(initial);
    const restored = [...root.querySelectorAll("details")].find((group) =>
      group.querySelector("summary")?.textContent?.startsWith("Passed"),
    );
    check(restored?.open, "Expansion did not survive temporarily empty check results");
    return { passed: 8 };
  } finally {
    dispose();
    root.remove();
  }
}
