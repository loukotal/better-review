import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { render } from "solid-js/web";

import type { AppUpdateJob } from "@better-review/shared";

import { createAssertions } from "../browser-tests/assertions";
import { AppUpdateNotice } from "./AppUpdateNotice";

/** Run the production component in its own document so its real reload is observable. */
export function mountSuccessfulUpdateIframe() {
  const frame = window.frameElement as HTMLIFrameElement;
  frame.dataset.boots = String(Number(frame.dataset.boots ?? 0) + 1);
  if (sessionStorage.getItem("app-update-success-fixture") === "ready") {
    frame.dataset.finished = "true";
    document.body.textContent = "Updated";
    return;
  }
  let jobId = "";
  let polls = 0;
  window.fetch = async (input, init) => {
    if (String(input).endsWith("update-status"))
      return Response.json({
        updateAvailable: true,
        oneClickUpdate: true,
        updateAction: "restart",
        currentRevision: "a".repeat(40),
        checkoutRevision: "b".repeat(40),
        latestRevision: "b".repeat(40),
      });
    if (init?.method === "POST") {
      jobId = JSON.parse(String(init.body)).requestId;
      frame.dataset.posts = String(Number(frame.dataset.posts ?? 0) + 1);
      return Response.json({
        supported: true,
        instanceId: "old",
        job: { id: jobId, phase: "installing", startedAt: 1, targetRevision: "b".repeat(40) },
      });
    }
    polls++;
    if (polls === 1) frame.dataset.oldReady = "true";
    else sessionStorage.setItem("app-update-success-fixture", "ready");
    return Response.json({
      supported: true,
      instanceId: polls === 1 ? "old" : "new",
      job: { id: jobId, phase: "ready", startedAt: 1, targetRevision: "b".repeat(40) },
    });
  };
  const client = new QueryClient();
  render(
    () => (
      <QueryClientProvider client={client}>
        <AppUpdateNotice />
      </QueryClientProvider>
    ),
    document.body,
  );
}

export async function testOneClickUpdateReloadsOnlyAfterNewInstanceInBrowser() {
  const { check, wait, result } = createAssertions(8000);
  const frame = document.createElement("iframe");
  frame.style.cssText = "width:500px;height:500px";
  frame.srcdoc = `<script type="module">import { mountSuccessfulUpdateIframe } from ${JSON.stringify(`${location.origin}/src/components/AppUpdateNotice.browser.tsx`)}; mountSuccessfulUpdateIframe();</script>`;
  document.body.append(frame);
  try {
    await wait(
      () => !!frame.contentDocument?.querySelector('[aria-label="Update Better Review"]'),
      "Iframe update notice missing",
    );
    frame
      .contentDocument!.querySelector<HTMLButtonElement>('[aria-label="Update Better Review"]')!
      .click();
    const button = [...frame.contentDocument!.querySelectorAll<HTMLButtonElement>("button")].find(
      (el) => el.textContent?.trim() === "Install & restart",
    )!;
    check(button, "Restart button missing");
    button.click();
    await wait(() => frame.dataset.oldReady === "true", "Old-instance readiness was not observed");
    check(frame.dataset.boots === "1", "Old instance must not cause a reload");
    await wait(
      () => frame.dataset.finished === "true",
      "Healthy new instance did not reload the document",
    );
    check(frame.dataset.boots === "2", "Successful update reloads exactly once");
    check(frame.dataset.posts === "1", "Successful update admits only one job");
    check(
      sessionStorage.getItem("better-review:pending-app-update") === null,
      "Completed job is cleared before reload",
    );
    return result();
  } finally {
    frame.remove();
    sessionStorage.removeItem("app-update-success-fixture");
    sessionStorage.removeItem("better-review:pending-app-update");
  }
}

export async function testOneClickUpdateProgressAndFailureInBrowser() {
  const { check, wait, result } = createAssertions(5000);
  const originalFetch = window.fetch;
  const client = new QueryClient();
  const host = document.createElement("div");
  document.body.append(host);
  let posts = 0;
  let polls = 0;
  let phase: AppUpdateJob["phase"] = "installing";
  window.fetch = async (input, init) => {
    const path = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
      location.href,
    ).pathname;
    if (path.endsWith("update-status"))
      return Response.json({
        updateAvailable: true,
        oneClickUpdate: true,
        updateAction: "restart",
        currentRevision: "a".repeat(40),
        checkoutRevision: "b".repeat(40),
        latestRevision: "b".repeat(40),
      });
    if (init?.method === "POST") {
      posts++;
      const body = JSON.parse(String(init.body));
      check(typeof body.requestId === "string", "Update admission carries an idempotency key");
      check(body.targetRevision === "b".repeat(40), "Only the offered revision is submitted");
    } else polls++;
    return Response.json({
      supported: true,
      instanceId: "old",
      job: {
        id: "job",
        phase,
        startedAt: 1,
        targetRevision: "b".repeat(40),
        ...(phase === "failed" ? { error: "Local changes found. Nothing was discarded." } : {}),
      },
    });
  };
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        <AppUpdateNotice />
      </QueryClientProvider>
    ),
    host,
  );
  try {
    await wait(
      () => !!host.querySelector('[aria-label="Update Better Review"]'),
      "Update notice missing",
    );
    host.querySelector<HTMLButtonElement>('[aria-label="Update Better Review"]')!.click();
    const button = () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (element) => element.textContent?.trim() === "Install & restart",
      )!;
    check(button(), "Ready checkout offers a one-click restart");
    button().click();
    await wait(() => polls > 0, "Update progress was not polled");
    const active = document.querySelector<HTMLButtonElement>('button[aria-busy="true"]')!;
    check(active?.disabled, "Repeated clicks are disabled while updating");
    check(
      document.querySelector('[role="status"]')?.textContent?.includes("Installing"),
      "Install progress is visible",
    );
    phase = "failed";
    await wait(
      () => !!document.querySelector('[role="alert"]')?.textContent?.includes("Local changes"),
      "Update failure was hidden",
    );
    check(posts === 1, "Progress or failure must never automatically submit another update");
    check(!button().disabled, "A failed update permits an explicit retry");
    return result();
  } finally {
    dispose();
    host.remove();
    client.clear();
    window.fetch = originalFetch;
    sessionStorage.removeItem("better-review:pending-app-update");
  }
}

export async function testUnmanagedUpdateNoticeKeepsManualInstructionsInBrowser() {
  const { check, wait, result } = createAssertions(5000);
  const originalFetch = window.fetch;
  const client = new QueryClient();
  const host = document.createElement("div");
  document.body.append(host);
  window.fetch = async () =>
    Response.json({ updateAvailable: true, updateAction: "restart", oneClickUpdate: false });
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        <AppUpdateNotice />
      </QueryClientProvider>
    ),
    host,
  );
  try {
    await wait(
      () => !!host.querySelector('[aria-label="Update Better Review"]'),
      "Update notice missing",
    );
    host.querySelector<HTMLButtonElement>('[aria-label="Update Better Review"]')!.click();
    check(
      document
        .querySelector('[aria-label="Update Better Review"][role="dialog"]')
        ?.textContent?.includes("pnpm start:production"),
      "Unmanaged app retains manual startup instructions",
    );
    check(
      ![...document.querySelectorAll("button")].some(
        (element) => element.textContent?.trim() === "Install & restart",
      ),
      "Unmanaged app must not advertise an unavailable restart",
    );
    return result();
  } finally {
    dispose();
    host.remove();
    client.clear();
    window.fetch = originalFetch;
  }
}
