import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import superjson from "superjson";

import type { PrDetail, PrMergeInput } from "@better-review/shared";

import { PrMergePanel } from "../components/PrMergePanel";
import { createAssertions } from "./assertions";
import { prDetailFixture } from "./pr-detail-fixture";

const trusted = () =>
  window as unknown as {
    activateBrowserLinkWithEnter: (selector: string) => Promise<void>;
    dismissBrowserPopover: (kind: string) => Promise<void>;
  };

export async function testPrMergePickerKeyboardAndOneShotInBrowser() {
  const assertions = createAssertions(5000);
  const { check, result } = assertions;
  const wait = (test: () => boolean) =>
    assertions.wait(test, "Merge picker did not reach expected state");
  const url = "https://github.com/browser-fixture/merge-picker/pull/1";
  const detail = prDetailFixture(url);
  if (detail.mergeCapabilities.status !== "available") throw new Error("Missing capabilities");
  detail.mergeCapabilities.data.allowedMethods.push("rebase");
  detail.mergeCapabilities.data.viewerCanMergeAsAdmin = true;
  detail.mergeCapabilities.data.actions.push(
    {
      action: { kind: "merge", method: "rebase" },
      enabled: false,
      reason: "Branch rules disallow this merge method.",
    },
    { action: { kind: "admin-merge", method: "merge" }, enabled: true, reason: null },
  );
  const [current, setCurrent] = createSignal<PrDetail>(detail);
  const calls: PrMergeInput[] = [];
  let finishDispatch!: () => void;
  const pendingDispatch = new Promise<void>((resolve) => {
    finishDispatch = resolve;
  });
  const originalFetch = window.fetch;
  window.fetch = async (input, init) => {
    const address = new URL(String(input), location.href);
    check(address.pathname.endsWith("/prDetail.merge"), "Unexpected network request");
    const command = superjson.deserialize<PrMergeInput>(JSON.parse(String(init?.body)));
    calls.push(command);
    await pendingDispatch;
    return Response.json({
      result: {
        data: superjson.serialize({
          ...command,
          status: "uncertain",
          message: "Waiting for authoritative outcome. Do not retry.",
        }),
      },
    });
  };
  const host = document.createElement("div");
  host.style.cssText = "width: min(390px, 100%); padding: 12px; box-sizing: border-box";
  document.body.append(host);
  const key = `pr-merge-intent:${url}`;
  localStorage.removeItem(key);
  const dispose = render(
    () => <PrMergePanel detail={current()} pendingComments={0} onChanged={async () => {}} />,
    host,
  );
  const trigger = () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Choose merge method"]')!;
  const primary = () => host.querySelector<HTMLButtonElement>("button")!;
  const open = async () => {
    trigger().click();
    await wait(() => !!document.querySelector('[role="menu"] [aria-checked="true"]:focus'));
  };
  try {
    await wait(() => primary().textContent?.includes("Create merge commit") ?? false);
    await open();
    check(trigger().getAttribute("aria-expanded") === "true", "Missing expanded state");
    check(
      document
        .querySelector('[aria-disabled="true"]')
        ?.textContent?.includes("Branch rules disallow"),
      "Disabled method lost its server reason",
    );
    document
      .querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-disabled="true"]')!
      .click();
    check(
      primary().textContent?.includes("Create merge commit"),
      "Disabled method changed selection",
    );
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    check(
      document.activeElement?.textContent?.includes("Squash and merge"),
      "Arrow navigation failed",
    );
    await trusted().activateBrowserLinkWithEnter('[role="menuitemradio"]:focus');
    await wait(() => document.activeElement === trigger());
    check(calls.length === 0, "Selecting a method dispatched a merge");
    check(
      primary().textContent?.includes("Squash and merge"),
      "Primary label did not follow selection",
    );

    // Reordering fresh evidence must not switch a selected method or privilege level.
    const reordered = structuredClone(detail);
    if (reordered.mergeCapabilities.status === "available")
      reordered.mergeCapabilities.data.actions.reverse();
    setCurrent(reordered);
    await open();
    check(
      document.activeElement?.textContent?.includes("Squash and merge"),
      "Selection changed after refresh",
    );
    await trusted().dismissBrowserPopover("escape");
    await wait(
      () =>
        document.activeElement === trigger() && trigger().getAttribute("aria-expanded") === "false",
    );
    check(trigger().getAttribute("aria-expanded") === "false", "Escape left picker open");
    await open();
    const outside = document.createElement("input");
    host.append(outside);
    outside.focus();
    await trusted().dismissBrowserPopover("outside");
    await wait(() => trigger().getAttribute("aria-expanded") === "false");
    check(document.activeElement !== trigger(), "Outside dismissal stole focus");
    outside.remove();
    await trusted().activateBrowserLinkWithEnter(
      'section[aria-label="Merge pull request"] > div.inline-flex > button',
    );
    await wait(() => calls.length === 1);
    check(
      !trigger() && !host.textContent?.includes("New merge attempt"),
      "Pending attempt allowed a new command",
    );
    setCurrent(structuredClone(detail));
    await new Promise(requestAnimationFrame);
    check(calls.length === 1, "Refresh retried a pending attempt");
    finishDispatch();
    await wait(() => host.textContent?.includes("Waiting for authoritative outcome") ?? false);
    check(
      calls.length === 1 &&
        calls[0]?.action.kind === "merge" &&
        calls[0].action.method === "squash",
      "Wrong dispatch or repeated attempt",
    );
    check(
      calls[0]?.expectedHeadSha === "a".repeat(40) &&
        calls[0].expectedActor.login === "browser-fixture",
      "Actor/head pin changed",
    );
    check(
      !trigger() && !host.textContent?.includes("New merge attempt"),
      "Uncertain outcome allowed a new attempt",
    );
    setCurrent(structuredClone(detail));
    await new Promise(requestAnimationFrame);
    check(calls.length === 1, "Refresh retried an uncertain attempt");
    return result();
  } finally {
    dispose();
    host.remove();
    window.fetch = originalFetch;
    localStorage.removeItem(key);
    for (const call of calls) localStorage.removeItem(`${key}:history:${call.requestId}`);
  }
}

export async function testPrMergePickerQueueAndAdminRemainExplicitInBrowser() {
  const assertions = createAssertions(5000);
  const { check, result } = assertions;
  const wait = (test: () => boolean) =>
    assertions.wait(test, "Merge picker did not reach expected state");
  const url = "https://github.com/browser-fixture/merge-picker/pull/2";
  const detail = prDetailFixture(url);
  if (detail.mergeCapabilities.status !== "available") throw new Error("Missing capabilities");
  detail.mergeCapabilities.data.queueRequired = true;
  detail.mergeCapabilities.data.viewerCanMergeAsAdmin = true;
  detail.mergeCapabilities.data.actions = [
    { action: { kind: "admin-merge", method: "squash" }, enabled: true, reason: null },
    {
      action: { kind: "merge", method: "squash" },
      enabled: false,
      reason: "This branch requires the merge queue.",
    },
    { action: { kind: "enqueue" }, enabled: true, reason: null },
  ];
  const host = document.createElement("div");
  document.body.append(host);
  const dispose = render(
    () => <PrMergePanel detail={detail} pendingComments={0} onChanged={async () => {}} />,
    host,
  );
  try {
    await wait(
      () => host.querySelector("button")?.textContent?.includes("Add to merge queue") ?? false,
    );
    host.querySelector<HTMLButtonElement>('[aria-label="Choose merge method"]')!.click();
    await wait(() => !!document.querySelector('[role="menuitemradio"]:focus'));
    const admin = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
      (entry) => entry.textContent?.includes("Admin:"),
    )!;
    check(admin.textContent?.includes("Bypass branch protections"), "Admin bypass warning missing");
    admin.click();
    await wait(
      () => host.querySelector("button")?.textContent?.includes("Admin: Squash and merge") ?? false,
    );
    check(
      host.textContent?.includes("Administrator bypass selected"),
      "Admin action disguised as normal merge",
    );
    check(!localStorage.getItem(`pr-merge-intent:${url}`), "Selection created merge intent");
    return result();
  } finally {
    dispose();
    host.remove();
  }
}
