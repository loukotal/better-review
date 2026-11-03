import { Router, Route } from "@solidjs/router";
import { QueryClientProvider } from "@tanstack/solid-query";
import { render } from "solid-js/web";

import { queryClient } from "../lib/query";
import AgentReviewPage from "../pages/AgentReviewPage";
import { createAssertions } from "./assertions";
import { mountAppFixture } from "./mount-app";

declare global {
  interface Window {
    setBrowserReviewViewport: (width: number, height: number) => Promise<void>;
    captureMobileReview: () => Promise<void>;
  }
}

export async function testMobileAgentMarkdownPanelInBrowser() {
  const { check, wait, result } = createAssertions(8000);
  const originalFetch = window.fetch;
  const host = document.createElement("div");
  document.body.append(host);
  let dispose: (() => void) | undefined;
  await window.setBrowserReviewViewport(393, 852);
  window.history.replaceState(null, "", "/agent-review/mobile-fixture");
  window.fetch = async (input) => {
    const path = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
      location.href,
    ).pathname;
    if (path.endsWith("/result")) return new Response(null, { status: 204 });
    if (path.endsWith("/mobile-fixture"))
      return Response.json({
        id: "mobile-fixture",
        mode: "plan",
        origin: "manual",
        title: "Review a plan on a phone",
        createdAt: 1,
        status: "pending",
        payload: { kind: "markdown", content: "# Mobile plan\n\nKeep the review readable." },
      });
    if (path === "/api/sessions") return Response.json({ sessions: [] });
    return Response.json({ updateAvailable: false });
  };
  try {
    dispose = render(
      () => (
        <QueryClientProvider client={queryClient}>
          <Router>
            <Route path="/agent-review/:sessionId" component={AgentReviewPage} />
          </Router>
        </QueryClientProvider>
      ),
      host,
    );
    await wait(() => !!host.querySelector(".agent-review-markdown h1"), "Agent Markdown loads");
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (el) => el.textContent?.trim() === "Review",
    )!;
    check(button.getBoundingClientRect().height > 0, "Review panel toggle stays visible on phone");
    const content = host.querySelector(".agent-review-markdown")!;
    const before = content.getBoundingClientRect().width;
    button.click();
    await new Promise(requestAnimationFrame);
    check(
      content.getBoundingClientRect().width === before,
      "Review drawer does not squeeze Markdown",
    );
    check(document.documentElement.scrollWidth <= innerWidth, "Agent review has no page overflow");
    button.click();
    check(button.getAttribute("aria-pressed") === "false", "Review drawer can be dismissed");
    return result();
  } finally {
    dispose?.();
    host.remove();
    window.fetch = originalFetch;
    await window.setBrowserReviewViewport(1280, 900);
  }
}

export async function testMobileReviewLayoutInBrowser() {
  const { check, wait, result } = createAssertions(8000);
  const saved = localStorage.getItem("diff-settings");
  localStorage.setItem("diff-settings", JSON.stringify({ diffStyle: "split" }));
  await window.setBrowserReviewViewport(393, 852); // iPhone 16 logical viewport
  try {
    await mountAppFixture({
      extras: {
        comments: [],
        issueComments: [],
        status: {
          state: "open",
          draft: false,
          mergeable: true,
          title: "Compact review layout with a realistic pull request title",
          body: "Review this change on a phone.",
          author: "browser-fixture",
          url: "https://github.com/browser-fixture/isolated/pull/1",
          headRef: "feature/mobile-review-with-a-long-branch-name",
          checks: [],
        },
      },
    });
    const findButton = (text: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === text,
      )!;
    const unified = () =>
      [...document.querySelectorAll("diffs-container")].some((element) =>
        element.shadowRoot?.querySelector("[data-unified]"),
      );
    await wait(unified, "Phone diff must use unified layout despite saved split preference");
    const tools = document.querySelector<HTMLButtonElement>(".compact-tools > button")!;
    check(tools.getAttribute("aria-expanded") === "false", "Secondary tools start collapsed");
    check(document.documentElement.scrollWidth <= innerWidth, "No page-level horizontal overflow");
    const viewport = document.querySelector(".app-viewport")!;
    check(viewport.getBoundingClientRect().height <= innerHeight + 1, "App fits dynamic viewport");
    check(
      document.querySelector(".diff-viewer")!.getBoundingClientRect().top < innerHeight * 0.45,
      "Code starts within the top 45% of a phone screen",
    );
    tools.click();
    check(
      findButton("Conversation").getBoundingClientRect().height > 0,
      "Expanded tools remain reachable",
    );
    tools.click();
    findButton("Files").click();
    await wait(() => !!document.querySelector("#file-tree-panel"), "Files open on phone");
    const fileButton = [
      ...document.querySelectorAll<HTMLButtonElement>("#file-tree-panel button"),
    ].find((button) => button.textContent?.includes("example.ts"))!;
    check(fileButton, "File navigation is reachable");
    fileButton.click();
    await wait(
      () => !document.querySelector("#file-tree-panel"),
      "Selecting a file dismisses phone drawer",
    );
    await window.captureMobileReview();
    for (const [width, height] of [
      [320, 640],
      [852, 393],
      [1280, 900],
    ]) {
      await window.setBrowserReviewViewport(width, height);
      await new Promise(requestAnimationFrame);
      check(document.documentElement.scrollWidth <= innerWidth, `${width}px: no page overflow`);
    }
    await wait(
      () =>
        [...document.querySelectorAll("diffs-container")].some((element) =>
          element.shadowRoot?.querySelector(
            "[data-diffs][data-type='split'], [data-diffs][data-diff-type='split'], [data-deletions]",
          ),
        ),
      "Desktop restores split diff preference",
    );
    check(
      JSON.parse(localStorage.getItem("diff-settings")!).diffStyle === "split",
      "Phone does not overwrite desktop preference",
    );
    return result();
  } finally {
    if (saved === null) localStorage.removeItem("diff-settings");
    else localStorage.setItem("diff-settings", saved);
    await window.setBrowserReviewViewport(1280, 900);
  }
}
