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

/** Production SQLite worker and HTTP adapter; an isolated GitHub-shaped server. */
export async function createBrowserNestedReplies() {
  const directory = await mkdtemp(join(tmpdir(), "better-review-nested-replies-"));
  const actor = { id: 42, login: "browser-fixture" };
  const scope = {
    host: "github.com",
    owner: "browser-fixture",
    repo: "isolated",
    number: 1,
    url: "https://github.com/browser-fixture/isolated/pull/1",
  };
  const pr = "/repos/browser-fixture/isolated/pulls/1";
  const root = {
    id: 20,
    node_id: "root-node",
    body: "Review root",
    user: actor,
    html_url: `${scope.url}#discussion_r20`,
    pull_request_url: `https://api.github.com${pr}`,
    path: "src/example.ts",
    line: 9,
    original_line: 9,
    side: "RIGHT",
    commit_id: "a".repeat(40),
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  const comments = new Map([[20, root]]);
  const issueComments = [];
  const calls = [];
  let holdAck = false;
  let releaseAck;
  const adapter = createGithubOutboxAdapter({
    token: async () => "isolated-fixture-token",
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.origin !== "https://api.github.com") throw new Error("Unexpected fixture origin");
      const method = init.method ?? "GET";
      const payload = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path: url.pathname, method, payload });
      if (url.pathname === "/user") return Response.json(actor);
      if (url.pathname === pr && method === "GET")
        return Response.json({ head: { sha: root.commit_id } });
      if (url.pathname === `${pr}/comments` && method === "GET")
        return Response.json([...comments.values()]);
      if (
        url.pathname === "/repos/browser-fixture/isolated/issues/1/comments" &&
        method === "POST"
      ) {
        const comment = {
          id: 30 + issueComments.length,
          body: payload.body,
          user: actor,
          html_url: `${scope.url}#issuecomment-${30 + issueComments.length}`,
          issue_url: "https://api.github.com/repos/browser-fixture/isolated/issues/1",
          created_at: root.created_at,
          updated_at: root.updated_at,
        };
        issueComments.push(comment);
        return Response.json(comment, { status: 201 });
      }
      const target = /^\/repos\/browser-fixture\/isolated\/pulls\/comments\/(\d+)$/.exec(
        url.pathname,
      );
      if (target) {
        const comment = comments.get(Number(target[1]));
        if (!comment) return Response.json({}, { status: 404 });
        if (method === "DELETE") {
          comments.delete(comment.id);
          return new Response(null, { status: 204 });
        }
        if (method === "PATCH") comment.body = payload.body;
        return Response.json(comment);
      }
      const reply = /^\/repos\/browser-fixture\/isolated\/pulls\/1\/comments\/(\d+)\/replies$/.exec(
        url.pathname,
      );
      if (reply && method === "POST") {
        // Match GitHub: replying to a reply is invalid, even if it belongs to this PR.
        if (Number(reply[1]) !== root.id)
          return Response.json({ message: "Must reply to root" }, { status: 422 });
        const id = 20 + calls.filter((call) => call.method === "POST").length;
        const comment = {
          ...root,
          id,
          node_id: `reply-${id}`,
          body: payload.body,
          html_url: `${scope.url}#discussion_r${id}`,
          in_reply_to_id: root.id,
        };
        comments.set(id, comment);
        return Response.json(comment, { status: 201 });
      }
      throw new Error(`Unexpected fixture request ${method} ${url.pathname}`);
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
      if (kind === "enqueue") {
        const result = await box.enqueue(input);
        if (holdAck)
          await new Promise((resolve) => {
            releaseAck = resolve;
          });
        return result;
      }
      if (kind === "snapshot") return box.snapshot(scope);
      if (kind === "heartbeat") return box.heartbeat(input);
      if (kind === "control") return box.control(input);
      if (kind === "state") return { calls, comments: [...comments.values()], issueComments };
      if (kind === "hold-ack") {
        holdAck = true;
        return;
      }
      if (kind === "release-ack") {
        holdAck = false;
        releaseAck?.();
        return;
      }
      throw new Error(`Unknown nested reply fixture action ${kind}`);
    },
    async close() {
      releaseAck?.();
      await box.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
