import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tsImport } from "tsx/esm/api";

const { createGithubOutbox } = await tsImport(
  "../packages/better-review/src/github-outbox/outbox.ts",
  import.meta.url,
);
const { createGithubOutboxAdapter } = await tsImport(
  "../packages/better-review/src/github-outbox/github.ts",
  import.meta.url,
);

/** Production admission/worker/HTTP adapter; every HTTP response is local. */
export async function createBrowserGithubActions() {
  const directory = await mkdtemp(join(tmpdir(), "better-review-browser-actions-"));
  const actor = { id: 42, login: "browser-fixture" };
  const scope = {
    host: "github.com",
    owner: "browser-fixture",
    repo: "isolated",
    number: 1,
    url: "https://github.com/browser-fixture/isolated/pull/1",
  };
  const calls = [];
  let resolved = false;
  let deleted = false;
  let failDelete = false;
  let failEdit = false;
  let createdIssue;
  let createdReview;
  const comment = {
    id: 20,
    node_id: "comment-node-not-thread",
    body: "action fixture body\n\n<!-- better-review:op:11111111-1111-4111-8111-111111111111 -->",
    user: actor,
    html_url: `${scope.url}#discussion_r20`,
    pull_request_url: "https://api.github.com/repos/browser-fixture/isolated/pulls/1",
    path: "src/example.ts",
    line: 9,
    original_line: 9,
    side: "RIGHT",
    commit_id: "a".repeat(40),
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  const adapter = createGithubOutboxAdapter({
    token: async () => "fixture-token",
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.origin !== "https://api.github.com") throw new Error("Unexpected origin");
      const method = init.method ?? "GET";
      const payload = init.body ? JSON.parse(String(init.body)) : undefined;
      const headers = new Headers(init.headers);
      calls.push({
        path: url.pathname,
        method,
        payload,
        headers: {
          accept: headers.get("accept"),
          contentType: headers.get("content-type"),
          apiVersion: headers.get("x-github-api-version"),
          ifMatch: headers.get("if-match"),
        },
      });
      // GitHub does not support conditional requests for unsafe methods.
      // Real comment GETs return weak ETags; never silently accept this PATCH header.
      if (method === "PATCH" && headers.has("if-match"))
        return Response.json({ message: "Conditional request is not supported" }, { status: 400 });
      if (method === "PATCH" && failEdit)
        return Response.json({ message: "private-response-must-not-escape" }, { status: 422 });
      if (url.pathname === "/user") return Response.json(actor);
      if (url.pathname === "/repos/browser-fixture/isolated/pulls/1" && method === "GET")
        return Response.json({ head: { sha: "a".repeat(40) } });
      if (
        url.pathname === "/repos/browser-fixture/isolated/pulls/1/comments" &&
        method === "POST"
      ) {
        createdReview = {
          ...comment,
          id: 21,
          body: payload.body,
          html_url: `${scope.url}#discussion_r21`,
        };
        return Response.json(createdReview, { status: 201 });
      }
      if (url.pathname === "/repos/browser-fixture/isolated/pulls/comments/21" && createdReview) {
        if (method === "PATCH") createdReview.body = payload.body;
        return Response.json(createdReview, { headers: { etag: 'W/"local-review-version"' } });
      }
      if (
        url.pathname === "/repos/browser-fixture/isolated/issues/1/comments" &&
        method === "POST"
      ) {
        createdIssue = {
          ...comment,
          id: 30,
          body: payload.body,
          html_url: `${scope.url}#issuecomment-30`,
          issue_url: "https://api.github.com/repos/browser-fixture/isolated/issues/1",
        };
        return Response.json(createdIssue, { status: 201 });
      }
      if (url.pathname === "/repos/browser-fixture/isolated/issues/comments/30") {
        if (method === "PATCH" && createdIssue) {
          createdIssue.body = payload.body;
          return Response.json(createdIssue);
        }
        if (method === "DELETE") {
          createdIssue = undefined;
          return new Response(null, { status: 204 });
        }
        return createdIssue
          ? Response.json(createdIssue, { headers: { etag: 'W/"issue-version"' } })
          : Response.json({}, { status: 404 });
      }
      if (url.pathname === "/repos/browser-fixture/isolated/pulls/comments/20") {
        if (method === "PATCH" && !deleted) {
          comment.body = payload.body;
          return Response.json(comment);
        }
        if (method === "DELETE") {
          if (failDelete)
            return Response.json({ message: "Delete fixture denied" }, { status: 403 });
          deleted = true;
          return new Response(null, { status: 204 });
        }
        return deleted
          ? Response.json({}, { status: 404 })
          : Response.json(comment, { headers: { etag: 'W/"review-version"' } });
      }
      if (url.pathname === "/graphql") {
        const query = payload.query;
        if (query.includes("mutation")) {
          if (payload.variables.id !== "actual-thread") throw new Error("Wrong thread identity");
          resolved = !query.includes("unresolveReviewThread");
          const field = resolved ? "resolveReviewThread" : "unresolveReviewThread";
          return Response.json({
            data: { [field]: { thread: { id: "actual-thread", isResolved: resolved } } },
          });
        }
        return Response.json({
          data: {
            node: {
              id: "actual-thread",
              isResolved: resolved,
              pullRequest: { number: 1, repository: { nameWithOwner: "browser-fixture/isolated" } },
            },
          },
        });
      }
      throw new Error(`Unexpected fixture request: ${method} ${url.pathname}`);
    },
  });
  const box = await createGithubOutbox({
    databasePath: join(directory, "outbox.sqlite"),
    adapter,
    getCachedActor: () => actor,
    pollMs: 10,
  });
  return {
    async invoke({ kind, input }) {
      if (kind === "enqueue") return box.enqueue(input);
      if (kind === "snapshot") return box.snapshot(scope);
      if (kind === "heartbeat") return box.heartbeat(input);
      if (kind === "control") return box.control(input);
      if (kind === "state") return { resolved, deleted, calls };
      if (kind === "fail-delete") {
        failDelete = !!input;
        return;
      }
      if (kind === "fail-edit") {
        failEdit = !!input;
        return;
      }
      throw new Error(`Unknown fixture action ${kind}`);
    },
    async close() {
      await box.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
