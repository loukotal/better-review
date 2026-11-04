import { ORDER_FILES_PROMPT, type ReviewSnapshot } from "@better-review/shared";

import { AUTO_ORDER_PREFERENCE_KEY } from "../lib/automatic-review-order";
import { createAssertions } from "./assertions";
import { mountAppFixture } from "./mount-app";

export async function testOrderFilesWithoutReviewInBrowser() {
  return orderFilesFixture(false);
}

export async function testOrderFilesForSelectedCommitInBrowser() {
  return orderFilesFixture(true);
}

async function orderFilesFixture(commit: boolean) {
  const { check, wait, result } = createAssertions(8000);
  const originalFetch = window.fetch;
  localStorage.removeItem(AUTO_ORDER_PREFERENCE_KEY);
  localStorage.removeItem("better-review:applied-review-orders");
  localStorage.removeItem("better-review:use-ste100");
  const paths = ["src/caller.ts", "src/model.ts", "src/model.test.ts"];
  const suggested = [paths[1], paths[0], paths[2]];
  const revision = (commit ? "b" : "a").repeat(40);
  let snapshot: ReviewSnapshot = {
    sessionId: "bootstrap",
    revision,
    running: false,
    compacting: false,
    settlements: [],
    messages: [],
  };
  const dispose = await mountAppFixture({
    diff: paths
      .map(
        (path) =>
          `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
      )
      .join(""),
    searchParams: {
      showChat: "1",
      ...(commit ? { mode: "commit", commit: revision.slice(0, 7) } : {}),
    },
    reviewSnapshot: () => snapshot,
    procedures: {
      "prReview.getOrCreateSession": () => ({
        session: { id: "bootstrap" },
        sessions: [],
        headSha: "a".repeat(40),
        sessionHeadSha: revision,
        sessionScope: { mode: commit ? "commit" : "full", commitSha: commit ? revision : null },
      }),
    },
  });
  const fixtureFetch = window.fetch;
  let posts = 0;
  let release: (() => void) | undefined;
  let request: { body: string; requestId: string; model?: { modelId: string } } | undefined;
  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
      location.href,
    );
    if (url.pathname === "/api/review/sessions/bootstrap" && init?.method === "POST") {
      posts++;
      request = JSON.parse(String(init.body));
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return Response.json({ submissionId: "order-only" });
    }
    return fixtureFetch(input, init);
  };
  try {
    const order = () =>
      document.querySelector<HTMLButtonElement>(
        '#chat-panel button[title="Suggest a reading order without running a code review"]',
      );
    await wait(
      () => !!order() && !order()!.disabled,
      "Independent Order files action missing or disabled in an empty session",
    );
    check(
      posts === 0 && snapshot.messages.length === 0,
      "No review should be required before ordering",
    );
    const composer = document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Message review assistant"]',
    )!;
    composer.value = "Keep this unsent question";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    order()!.click();
    await wait(() => posts === 1, "Order files did not submit its standalone request");
    check(
      request?.body === ORDER_FILES_PROMPT,
      "Order files must not launch the structured or adversarial review prompt",
    );
    check(request?.model?.modelId === "offline", "Ordering uses the selected model");
    check(!!request?.requestId, "Ordering uses normal durable admission");
    check(composer.value === "Keep this unsent question", "Ordering must not erase the chat draft");
    check(order()!.disabled, "Ordering is disabled while the request is pending");
    order()!.click();
    check(posts === 1, "A repeated click must not submit a second ordering request");
    snapshot = {
      ...snapshot,
      settlements: [{ submissionId: "order-only", outcome: "completed" }],
      messages: [
        {
          id: "order-only-result",
          role: "assistant",
          submissionId: "order-only",
          metadata: { timestamp: "2026-01-01", revision },
          parts: [
            { type: "text", text: `<<REVIEW_ORDER>>${JSON.stringify(suggested)}<</REVIEW_ORDER>>` },
          ],
        },
      ],
    };
    release!();
    const displayed = () =>
      [...document.querySelectorAll<HTMLElement>('[id^="file-src"]')]
        .map((element) => decodeURIComponent(element.id.slice(5)))
        .join(",");
    await wait(
      () => displayed() === suggested.join(","),
      "Completed standalone request did not apply its file order",
    );
    check(
      document.querySelector("#chat-panel")?.textContent?.includes("Applied"),
      "Standalone ordering must show its applied status",
    );
    check(
      !document.querySelector("[data-ai-annotation]"),
      "Order-only output adds no review findings",
    );
    return result();
  } finally {
    dispose();
    release?.();
    window.fetch = originalFetch;
  }
}
