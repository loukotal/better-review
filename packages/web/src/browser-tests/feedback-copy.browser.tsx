import { render } from "solid-js/web";
import superjson from "superjson";

import type { ReviewSnapshot } from "@better-review/shared";

import { ChatPanel } from "../ChatPanel";
import type { Annotation } from "../utils/parseReviewTokens";
import { createAssertions } from "./assertions";
import { fixtureModel } from "./mount-app";

declare global {
  interface Window {
    copyBrowserFeedback(): Promise<string>;
  }
}

export async function testChatPanelCopyFeedbackInBrowser() {
  const { check, wait, result } = createAssertions(5000);
  const originalFetch = window.fetch;
  const revision = "a".repeat(40);
  const note =
    '<<ANNOTATION file="src/a.ts" line="15-16" severity="note">>  See **[[file:src/b.ts:007]]**  <</ANNOTATION>>';
  const info = note.replace("15-16", "15").replace('severity="note"', 'severity="info"');
  const dismissed =
    '<<ANNOTATION file="src/fallback.ts" line="n/a" severity="warning">> Keep input <</ANNOTATION>>';
  const content = `Intro **[[file:src/main.ts:007]]**.\n\n<<REVIEW_ORDER>>not json<</REVIEW_ORDER>>\n\n${note}\n${info}\n\n${dismissed}\n\nOutro [[file:README.md]]`;
  const snapshot: ReviewSnapshot = {
    sessionId: "feedback-copy",
    revision,
    running: false,
    compacting: false,
    settlements: [],
    messages: [
      {
        id: "user",
        role: "user",
        parts: [{ type: "text", text: "Do not copy this user message" }],
        metadata: { timestamp: "2026-10-23T00:00:00Z", revision },
      },
      {
        id: "assistant",
        role: "assistant",
        parts: [{ type: "text", text: content }],
        metadata: { timestamp: "2026-10-23T00:00:00Z", revision },
      },
      {
        id: "tail",
        role: "assistant",
        parts: [{ type: "text", text: " Tail " }],
        metadata: { timestamp: "2026-10-23T00:00:00Z", revision },
      },
    ],
  };
  const active: Annotation = {
    id: "annotation-pe54lx",
    file: "src/a.ts",
    line: 15,
    severity: "info",
    message: "See **[[file:src/b.ts:007]]**",
  };
  let received: Annotation[] = [];
  let admissions = 0;
  const success = (value: unknown) =>
    Response.json({ result: { data: superjson.serialize(value) } });
  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      location.href,
    );
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/trpc/prReview.getOrCreateSession")
      return success({
        session: { id: snapshot.sessionId },
        sessions: [],
        headSha: revision,
        sessionHeadSha: revision,
      });
    if (url.pathname === "/api/trpc/models.current")
      return success({ ...fixtureModel, selectionSource: "saved" });
    if (url.pathname === "/api/review/sessions/feedback-copy/events" && method === "GET")
      return new Response(
        `event: snapshot\ndata: ${JSON.stringify({ version: 0, snapshot })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    if (url.pathname === "/api/review/sessions/feedback-copy" && method === "GET")
      return Response.json(snapshot);
    if (method === "POST" && url.pathname.startsWith("/api/review/")) admissions++;
    throw new Error(`Unexpected offline feedback request: ${method} ${url.pathname}`);
  };
  const host = document.createElement("div");
  document.body.append(host);
  const dispose = render(
    () => (
      <ChatPanel
        prUrl="https://github.com/fixture/offline/pull/1"
        prNumber={1}
        repoOwner="fixture"
        repoName="offline"
        files={[]}
        theme="github-light"
        displayedHeadSha={revision}
        aiAnnotations={[active]}
        onAnnotationsReceived={(annotations) => {
          received = annotations;
        }}
      />
    ),
    host,
  );
  try {
    await wait(
      () => received.length === 3 && !!host.querySelector("textarea:not(:disabled)"),
      "Transcript and model did not hydrate",
    );
    check(
      received.every(
        (annotation) =>
          annotation.origin?.sessionId === "feedback-copy" &&
          annotation.origin.revision === revision,
      ),
      "Parser findings lost transcript provenance",
    );
    check(
      received[0].id === "annotation-pe54lx" &&
        received[1].id === "annotation-pe54lx" &&
        received[2].id === "annotation-22h0c0",
      "Annotation identity changed through ChatPanel",
    );
    const copied = await window.copyBrowserFeedback();
    check(
      copied ===
        "Intro src/main.ts:007.\n\n[NOTE] src/a.ts:15 - See src/b.ts:007\n[INFO] src/a.ts:15 - See src/b.ts:007\n\nOutro README.md\n\n---\n\nTail",
      "Actual Copy feedback event changed clipboard output",
    );
    check(host.textContent?.includes("Feedback copied."), "Clipboard success was not shown");
    check(host.textContent?.includes("not json"), "Rendering stripped the malformed review order");
    check(admissions === 0, "Copy feedback admitted durable review work");
  } finally {
    dispose();
    host.remove();
    window.fetch = originalFetch;
  }
  return result();
}
