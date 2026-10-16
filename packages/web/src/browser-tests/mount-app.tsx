import { Router, Route } from "@solidjs/router";
import { QueryClientProvider } from "@tanstack/solid-query";
import { render } from "solid-js/web";
import superjson from "superjson";

import App from "../App";
import { queryClient, queryKeys, type PrExtrasData } from "../lib/query";

const prUrl = "https://github.com/browser-fixture/isolated/pull/1";
const headSha = "a".repeat(40);
const base = "b".repeat(40);
const diff =
  "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -8,3 +8,3 @@\n before\n-old\n+new\n after\n";

export async function mountAppFixture(
  options: { extras?: PrExtrasData; procedures?: Record<string, (input: unknown) => unknown> } = {},
) {
  const originalFetch = window.fetch.bind(window);
  const fixtures: Record<string, unknown> = {
    "user.current": { login: "browser-fixture" },
    "githubOutbox.capability": { version: 1, durableAdmission: true },
    "githubOutbox.identity": { actor: { id: 42, login: "browser-fixture" } },
    "githubOutbox.heartbeat": { ok: true },
    "githubOutbox.snapshot": {
      scope: {
        host: "github.com",
        owner: "browser-fixture",
        repo: "isolated",
        number: 1,
        url: prUrl,
      },
      revision: 0,
      operations: [],
    },
    "prs.list": { prs: [] },
    "prReview.getSession": { session: null, sessions: [], headSha },
    "prReview.sessions": { sessions: [] },
    "prReview.listSessions": { sessions: [] },
    "prReview.getOrCreateSession": {
      session: { id: "bootstrap" },
      sessions: [],
      headSha,
      sessionHeadSha: headSha,
    },
    "prReview.create": {
      session: { id: "bootstrap-commit" },
      sessions: [],
      headSha,
      sessionHeadSha: headSha,
    },
    "models.current": { provider: "fixture", modelId: "offline", name: "Offline fixture" },
    "models.setCurrent": {
      model: { provider: "fixture", modelId: "offline", name: "Offline fixture" },
    },
    "pr.fileContent": {
      oldContent: Array.from({ length: 12 }, (_, i) =>
        i === 8 ? "old" : i === 7 ? "before" : i === 9 ? "after" : `fixture source ${i + 1}`,
      ).join("\n"),
      newContent: Array.from({ length: 12 }, (_, i) =>
        i === 8 ? "new" : i === 7 ? "before" : i === 9 ? "after" : `fixture source ${i + 1}`,
      ).join("\n"),
      headSha,
      baseSha: base,
    },
  };
  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      location.href,
    );
    const procedure = url.pathname.split("/").pop()!;
    if (options.procedures?.[procedure]) {
      const payload = superjson.deserialize(
        JSON.parse(init?.body ? String(init.body) : (url.searchParams.get("input") ?? "{}")),
      );
      return new Response(
        JSON.stringify({
          result: { data: superjson.serialize(await options.procedures[procedure](payload)) },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.pathname === "/api/app/update-status") return Response.json({ updateAvailable: false });
    if (url.pathname.startsWith("/api/review/sessions/bootstrap")) {
      const snapshot = {
        sessionId: "bootstrap",
        revision: headSha,
        running: false,
        compacting: false,
        settlements: [],
        messages: [],
      };
      if (url.pathname.endsWith("/events"))
        return new Response(
          `event: snapshot\ndata: ${JSON.stringify({ version: 0, snapshot })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      return Response.json(snapshot);
    }
    if (procedure in fixtures)
      return new Response(JSON.stringify({ result: { data: { json: fixtures[procedure] } } }), {
        headers: { "content-type": "application/json" },
      });
    return originalFetch(input, init);
  };
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  queryClient.setQueryData(queryKeys.pr.core(prUrl), {
    headSha,
    comparisonBaseSha: base,
    diff,
    info: { owner: "browser-fixture", repo: "isolated", number: "1" },
    commits: [
      { sha: base, message: "Fixture base", author: "Fixture", date: "2026-01-01T00:00:00Z" },
    ],
  });
  queryClient.setQueryData(
    queryKeys.pr.extras(prUrl),
    options.extras ?? {
      comments: [],
      issueComments: [],
      status: null,
    },
  );
  history.replaceState(null, "", `/review?prUrl=${encodeURIComponent(prUrl)}`);
  render(
    () => (
      <QueryClientProvider client={queryClient}>
        <Router>
          <Route path="/review" component={App} />
        </Router>
      </QueryClientProvider>
    ),
    document.getElementById("root")!,
  );
  for (let i = 0; i < 180; i++) {
    if (document.querySelector("diffs-container") && document.getElementById("chat-panel")) return;
    await new Promise(requestAnimationFrame);
  }
  throw new Error(`Isolated App did not mount: ${document.body.textContent}`);
}
