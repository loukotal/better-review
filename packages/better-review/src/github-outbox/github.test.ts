import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  GithubOutboxOperation,
  GithubRemoteResult,
  GithubWriteAction,
} from "@better-review/shared";

import { createGithubOutboxAdapter, type GithubOutboxAdapterOptions } from "./github";

const id = "11111111-1111-4111-8111-111111111111";
const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const marker = `<!-- better-review:op:${id} -->`;
const wire = (body = "hello") => (body ? `${body}\n\n${marker}` : marker);
const api = "https://api.github.com/repos/acme/repo";
const actor = { id: 7, login: "alice" };
const createdAt = "2026-01-01T00:00:00Z";
const updatedAt = "2026-01-02T00:00:00Z";
const scope = {
  host: "github.com" as const,
  owner: "acme",
  repo: "repo",
  number: 3,
  url: "https://github.com/acme/repo/pull/3",
};
function operation(
  action: GithubWriteAction = { kind: "issue-comment", body: "hello" },
): GithubOutboxOperation {
  return {
    command: {
      operationId: id,
      scope: { ...scope },
      expectedActor: { ...actor },
      action,
      dependencies: [],
    },
    revision: 1,
    sequence: 1,
    status: "inflight",
    retryMode: "automatic",
    attempts: 1,
    createdAt,
    updatedAt,
  };
}
function issue(body = wire(), extra: Record<string, unknown> = {}) {
  return {
    id: 21,
    node_id: "IC_21",
    body,
    user: actor,
    created_at: createdAt,
    updated_at: updatedAt,
    html_url: `${scope.url}#issuecomment-21`,
    issue_url: `${api}/issues/3`,
    ...extra,
  };
}
function inline(body = wire(), extra: Record<string, unknown> = {}) {
  return {
    id: 22,
    node_id: "RC_22",
    body,
    user: actor,
    html_url: `${scope.url}#discussion_r22`,
    pull_request_url: `${api}/pulls/3`,
    commit_id: sha,
    path: "src/a.ts",
    line: 5,
    original_line: 5,
    side: "RIGHT",
    created_at: createdAt,
    updated_at: updatedAt,
    ...extra,
  };
}
const remote = { source: "remote" as const, kind: "issue-comment" as const, id: 21 };
type Step = {
  path: string;
  method?: string;
  data?: unknown;
  status?: number;
  headers?: Record<string, string>;
  raw?: string;
  fail?: boolean;
  hang?: boolean;
  check?: (init: RequestInit) => void;
};
function fixture(steps: Step[], options: GithubOutboxAdapterOptions = {}) {
  const calls: { path: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(init.redirect, "error");
    const path = url.pathname + url.search;
    calls.push({ path, init });
    const step = steps.shift();
    assert.ok(step, `Unexpected request: ${path}`);
    assert.equal(path, step.path);
    assert.equal(init.method, step.method ?? "GET");
    step.check?.(init);
    if (step.hang) return new Promise<Response>(() => {});
    if (step.fail) throw new Error("secret-token should never escape");
    const status = step.status ?? 200;
    return new Response(status === 204 ? null : (step.raw ?? JSON.stringify(step.data)), {
      status,
      headers: step.headers,
    });
  };
  return {
    adapter: createGithubOutboxAdapter({
      token: async () => "secret-token",
      fetch: fetcher,
      ...options,
    }),
    calls,
    done: () => assert.equal(steps.length, 0, "All expected requests must be consumed"),
  };
}
const user = (): Step => ({ path: "/user", data: actor });
const head = (value = sha): Step => ({
  path: "/repos/acme/repo/pulls/3",
  data: { head: { sha: value } },
});
const listPath = "/repos/acme/repo/issues/3/comments?per_page=100&page=1";

for (const kind of ["request-changes", "review-comment"] as const) {
  const state = kind === "request-changes" ? "CHANGES_REQUESTED" : "COMMENTED";
  const review = (extra: Record<string, unknown> = {}) => ({
    id: 51,
    html_url: `${scope.url}#pullrequestreview-51`,
    body: wire(),
    user: actor,
    state,
    commit_id: sha,
    submitted_at: createdAt,
    ...extra,
  });
  const op = () => operation({ kind, expectedHeadSha: sha, body: "hello" });
  test(`${kind}: pinned REST event and full confirmed review metadata`, async () => {
    const f = fixture([
      user(),
      head(),
      {
        path: "/repos/acme/repo/pulls/3/reviews",
        method: "POST",
        data: review(),
        check: (init) =>
          assert.deepEqual(JSON.parse(String(init.body)), {
            event: kind === "request-changes" ? "REQUEST_CHANGES" : "COMMENT",
            commit_id: sha,
            body: wire(),
          }),
      },
    ]);
    assert.deepEqual(await f.adapter.dispatch(op()), {
      outcome: "accepted",
      result: {
        kind: "review",
        id: 51,
        url: `${scope.url}#pullrequestreview-51`,
        state,
        commitSha: sha,
        body: "hello",
        author: actor,
        submittedAt: createdAt,
      },
    });
    f.done();
  });
  test(`${kind}: timeout reconciles through all review pages without reposting`, async () => {
    const f = fixture(
      [
        user(),
        head(),
        {
          path: "/repos/acme/repo/pulls/3/reviews",
          method: "POST",
          hang: true,
        },
        user(),
        {
          path: "/repos/acme/repo/pulls/3/reviews?per_page=100&page=1",
          data: [],
          headers: { link: '<https://api.github.com/ignored>; rel="next"' },
        },
        { path: "/repos/acme/repo/pulls/3/reviews?per_page=100&page=2", data: [review()] },
      ],
      { timeoutMs: 20 },
    );
    assert.equal((await f.adapter.dispatch(op())).outcome, "uncertain");
    assert.equal((await f.adapter.reconcile(op())).outcome, "matched");
    assert.equal(f.calls.filter((call) => call.init.method === "POST").length, 1);
    f.done();
  });
  test(`${kind}: changed head and blank bodies never post`, async () => {
    const f = fixture([user(), head(otherSha)]);
    const changed = await f.adapter.dispatch(op());
    assert.equal(changed.outcome, "rejected");
    if (changed.outcome === "rejected") assert.equal(changed.error.code, "head-changed");
    const blank = op();
    blank.command.action = { kind, expectedHeadSha: sha, body: " \n\t" };
    assert.equal((await f.adapter.dispatch(blank)).outcome, "rejected");
    f.done();
  });
  for (const extra of [
    { state: "APPROVED" },
    { commit_id: otherSha },
    { body: wire("different") },
    { user: { id: 99, login: "other" } },
    { body: `${marker}\n\nhello` },
  ]) {
    test(`${kind}: conflicting review evidence ${JSON.stringify(extra)} stays uncertain`, async () => {
      const f = fixture([
        user(),
        head(),
        { path: "/repos/acme/repo/pulls/3/reviews", method: "POST", data: review(extra) },
        user(),
        {
          path: "/repos/acme/repo/pulls/3/reviews?per_page=100&page=1",
          data: [review(extra)],
        },
      ]);
      assert.equal((await f.adapter.dispatch(op())).outcome, "uncertain");
      assert.equal((await f.adapter.reconcile(op())).outcome, "conflict");
      f.done();
    });
  }
  test(`${kind}: verifyApplied reads review endpoint and rechecks event`, async () => {
    const candidate: GithubRemoteResult = {
      kind: "review",
      id: 51,
      url: scope.url,
      state,
      commitSha: sha,
      body: "hello",
      author: actor,
      submittedAt: createdAt,
    };
    for (const correct of [true, false]) {
      const f = fixture([
        user(),
        {
          path: "/repos/acme/repo/pulls/3/reviews/51",
          data: review(correct ? {} : { state: "APPROVED" }),
        },
      ]);
      assert.equal(
        (await f.adapter.verifyApplied(op(), candidate)).outcome,
        correct ? "matched" : "conflict",
      );
      f.done();
    }
  });
}

test("accepted creation returns the full clean entity without mutating the command", async () => {
  const op = operation();
  const original = structuredClone(op);
  const f = fixture([
    user(),
    {
      path: "/repos/acme/repo/issues/3/comments",
      method: "POST",
      data: issue(),
      status: 201,
      check: (init) => assert.deepEqual(JSON.parse(String(init.body)), { body: wire() }),
    },
  ]);
  assert.deepEqual(await f.adapter.dispatch(op), {
    outcome: "accepted",
    result: {
      kind: "issue-comment",
      id: 21,
      nodeId: "IC_21",
      url: `${scope.url}#issuecomment-21`,
      body: "hello",
      author: actor,
      createdAt,
      updatedAt,
    },
  });
  assert.deepEqual(op, original);
  f.done();
});

test("lost response reconciles by stable marker without another write", async () => {
  const f = fixture([
    user(),
    { path: "/repos/acme/repo/issues/3/comments", method: "POST", fail: true },
    user(),
    { path: listPath, data: [issue()] },
  ]);
  const outcome = await f.adapter.dispatch(operation());
  assert.equal(outcome.outcome, "uncertain");
  assert.ok(!JSON.stringify(outcome).includes("secret-token"));
  assert.equal((await f.adapter.reconcile(operation())).outcome, "matched");
  assert.equal(f.calls.filter((c) => c.init.method === "POST").length, 1);
  f.done();
});

test("all attempts use the same marker", async () => {
  const f = fixture([
    user(),
    { path: "/repos/acme/repo/issues/3/comments", method: "POST", status: 429 },
    user(),
    { path: "/repos/acme/repo/issues/3/comments", method: "POST", data: issue() },
  ]);
  assert.equal((await f.adapter.dispatch(operation())).outcome, "rejected");
  assert.equal((await f.adapter.dispatch(operation())).outcome, "accepted");
  assert.deepEqual(f.calls[1]!.init.body, f.calls[3]!.init.body);
  f.done();
});

test("identity is live for every attempt and numeric ID, not login, is binding", async () => {
  const f = fixture([
    { path: "/user", data: { ...actor, login: "renamed" } },
    { path: "/repos/acme/repo/issues/3/comments", method: "POST", data: issue() },
    { path: "/user", data: { id: 8, login: "alice" } },
  ]);
  assert.equal((await f.adapter.dispatch(operation())).outcome, "accepted");
  const denied = await f.adapter.dispatch(operation());
  assert.equal(denied.outcome, "rejected");
  assert.ok("error" in denied && denied.error.code === "identity-mismatch");
  f.done();
});

test("credentials refresh per call, including after 401", async () => {
  let lookups = 0;
  const f = fixture([user(), { path: "/user", status: 401, raw: "private failure" }, user()], {
    token: async () => `token-${++lookups}`,
  });
  assert.equal((await f.adapter.identity()).outcome, "known");
  const failed = await f.adapter.identity();
  assert.equal(failed.outcome, "unavailable");
  assert.ok(!JSON.stringify(failed).includes("private failure"));
  assert.equal((await f.adapter.identity()).outcome, "known");
  assert.equal(lookups, 3);
  assert.equal(new Headers(f.calls[0]!.init.headers).get("Authorization"), "Bearer token-1");
  assert.equal(new Headers(f.calls[1]!.init.headers).get("Authorization"), "Bearer token-2");
  assert.equal(new Headers(f.calls[2]!.init.headers).get("Authorization"), "Bearer token-3");
  f.done();
});

test("environment credentials use GH_TOKEN then GITHUB_TOKEN", async () => {
  for (const env of [{ GH_TOKEN: "first", GITHUB_TOKEN: "second" }, { GITHUB_TOKEN: "second" }]) {
    const f = fixture([user()], { token: undefined, env });
    assert.equal((await f.adapter.identity()).outcome, "known");
    assert.equal(
      new Headers(f.calls[0]!.init.headers).get("Authorization"),
      `Bearer ${env.GH_TOKEN ?? env.GITHUB_TOKEN}`,
    );
    f.done();
  }
});

test("credential and identity exceptions are safe structured errors", async () => {
  const f = fixture([], {
    token: async () => {
      throw new Error("secret-token");
    },
  });
  const identity = await f.adapter.identity();
  assert.equal(identity.outcome, "unavailable");
  assert.ok(!JSON.stringify(identity).includes("secret-token"));
  assert.equal((await f.adapter.dispatch(operation())).outcome, "rejected");
  assert.equal(f.calls.length, 0);
});

test("approval submits explicit pinned commit and marker-only empty body", async () => {
  const f = fixture([
    user(),
    head(),
    {
      path: "/repos/acme/repo/pulls/3/reviews",
      method: "POST",
      data: {
        id: 31,
        state: "APPROVED",
        body: wire(""),
        user: actor,
        commit_id: sha,
        html_url: `${scope.url}#pullrequestreview-31`,
      },
      check: (init) =>
        assert.deepEqual(JSON.parse(String(init.body)), {
          event: "APPROVE",
          commit_id: sha,
          body: marker,
        }),
    },
  ]);
  assert.deepEqual(
    await f.adapter.dispatch(operation({ kind: "approve", expectedHeadSha: sha, body: "" })),
    {
      outcome: "accepted",
      result: {
        kind: "approval",
        id: 31,
        url: `${scope.url}#pullrequestreview-31`,
        commitSha: sha,
      },
    },
  );
  f.done();
});

test("stale heads reject before send for approval and inline", async () => {
  const actions: GithubWriteAction[] = [
    { kind: "approve", expectedHeadSha: sha, body: "" },
    {
      kind: "inline-comment",
      expectedHeadSha: sha,
      body: "hello",
      anchor: { path: "src/a.ts", side: "RIGHT", line: 5 },
    },
  ];
  for (const action of actions) {
    const f = fixture([user(), head(otherSha)]);
    const result = await f.adapter.dispatch(operation(action));
    assert.equal(result.outcome, "rejected");
    assert.ok("error" in result && result.error.code === "head-changed");
    f.done();
  }
});

test("inline range stays pinned even if head moves after preflight", async () => {
  const anchor = {
    path: "src/a.ts",
    side: "RIGHT" as const,
    line: 5,
    startLine: 2,
    startSide: "RIGHT" as const,
  };
  const f = fixture([
    user(),
    head(),
    {
      path: "/repos/acme/repo/pulls/3/comments",
      method: "POST",
      data: inline(wire(), { start_line: 2, start_side: "RIGHT" }),
      check: (init) =>
        assert.deepEqual(JSON.parse(String(init.body)), {
          body: wire(),
          commit_id: sha,
          path: "src/a.ts",
          side: "RIGHT",
          line: 5,
          start_line: 2,
          start_side: "RIGHT",
        }),
    },
  ]);
  const result = await f.adapter.dispatch(
    operation({ kind: "inline-comment", expectedHeadSha: sha, body: "hello", anchor }),
  );
  assert.equal(result.outcome, "accepted");
  assert.equal(f.calls.filter((c) => c.path === "/repos/acme/repo/pulls/3").length, 1);
  f.done();
});

test("head race rejection never silently reanchors or retries", async () => {
  const f = fixture([
    user(),
    head(),
    { path: "/repos/acme/repo/pulls/3/reviews", method: "POST", status: 422 },
  ]);
  assert.equal(
    (await f.adapter.dispatch(operation({ kind: "approve", expectedHeadSha: sha, body: "" })))
      .outcome,
    "rejected",
  );
  f.done();
});

test("reply validates parent PR and keeps reply target and commit", async () => {
  const f = fixture([
    user(),
    {
      path: "/repos/acme/repo/pulls/comments/22",
      data: inline("parent", { user: { id: 8, login: "bob" } }),
    },
    {
      path: "/repos/acme/repo/pulls/3/comments/22/replies",
      method: "POST",
      data: inline(wire(), { id: 23, in_reply_to_id: 22 }),
      check: (init) => assert.deepEqual(JSON.parse(String(init.body)), { body: wire() }),
    },
  ]);
  const result = await f.adapter.dispatch(
    operation({
      kind: "reply",
      target: { source: "remote", kind: "review-comment", id: 22 },
      body: "hello",
    }),
  );
  assert.equal(result.outcome, "accepted");
  assert.ok("result" in result && "body" in result.result && result.result.body === "hello");
  f.done();
});

test("every local-target variant is rejected without any network", async () => {
  const local = {
    source: "local" as const,
    kind: "review-comment" as const,
    operationId: "22222222-2222-4222-8222-222222222222",
  };
  const actions: GithubWriteAction[] = [
    { kind: "reply", target: local, body: "hello" },
    { kind: "edit-comment", target: local, body: "hello", expectedBody: "old" },
    { kind: "delete-comment", target: local, expectedBody: "old" },
    { kind: "resolve-thread", target: { ...local, kind: "thread" } },
    { kind: "unresolve-thread", target: { ...local, kind: "thread" } },
  ];
  for (const action of actions) {
    const f = fixture([]);
    const op = operation(action);
    op.command.dependencies = [local.operationId];
    const result = await f.adapter.dispatch(op);
    assert.equal(result.outcome, "rejected");
    assert.ok("error" in result && result.error.code === "dependency");
    f.done();
  }
});

test("scope validation blocks arbitrary hosts, URLs and path injection", async () => {
  for (const change of [
    { host: "evil.test" },
    { owner: "acme/../../evil" },
    { repo: ".." },
    { repo: "repo?token=x" },
    { url: "https://evil.test/acme/repo/pull/3" },
  ]) {
    const f = fixture([]);
    const op = operation();
    Object.assign(op.command.scope, change);
    assert.equal((await f.adapter.dispatch(op)).outcome, "rejected");
    assert.equal((await f.adapter.reconcile(op)).outcome, "conflict");
    f.done();
  }
});

test("edit preserves creation marker without unsupported conditional HTTP headers", async () => {
  const f = fixture([
    user(),
    {
      path: "/repos/acme/repo/issues/comments/21",
      data: issue(wire("old")),
      headers: { etag: 'W/"v1"' },
    },
    {
      path: "/repos/acme/repo/issues/comments/21",
      method: "PATCH",
      data: issue(wire("new")),
      check: (init) => {
        assert.deepEqual(JSON.parse(String(init.body)), { body: wire("new") });
        assert.equal(new Headers(init.headers).get("if-match"), null);
      },
    },
  ]);
  const result = await f.adapter.dispatch(
    operation({ kind: "edit-comment", target: remote, expectedBody: "old", body: "new" }),
  );
  assert.equal(result.outcome, "accepted");
  assert.ok("result" in result && "body" in result.result && result.result.body === "new");
  f.done();
});

test("failed edit retains numeric HTTP status without the raw GitHub response", async () => {
  const f = fixture([
    user(),
    { path: "/repos/acme/repo/issues/comments/21", data: issue("old") },
    {
      path: "/repos/acme/repo/issues/comments/21",
      method: "PATCH",
      status: 422,
      data: { message: "private comment and credentials must not escape" },
    },
  ]);
  const result = await f.adapter.dispatch(
    operation({ kind: "edit-comment", target: remote, expectedBody: "old", body: "new" }),
  );
  assert.equal(result.outcome, "rejected");
  assert.ok("error" in result);
  assert.equal(result.error.httpStatus, 422);
  assert.doesNotMatch(JSON.stringify(result), /private comment|credentials/);
  f.done();
});

test("inline edit and delete select review-comment endpoint", async () => {
  const target = { source: "remote" as const, kind: "review-comment" as const, id: 22 };
  for (const kind of ["edit-comment", "delete-comment"] as const) {
    const f = fixture([
      user(),
      { path: "/repos/acme/repo/pulls/comments/22", data: inline("old") },
      {
        path: "/repos/acme/repo/pulls/comments/22",
        method: kind === "edit-comment" ? "PATCH" : "DELETE",
        ...(kind === "edit-comment" ? { data: inline("new") } : { status: 204 }),
      },
    ]);
    const action: GithubWriteAction =
      kind === "edit-comment"
        ? { kind, target, expectedBody: "old", body: "new" }
        : { kind, target, expectedBody: "old" };
    const result = await f.adapter.dispatch(operation(action));
    assert.equal(result.outcome, "accepted");
    if (kind === "delete-comment")
      assert.deepEqual(result, { outcome: "accepted", result: { kind: "deleted", target } });
    f.done();
  }
});

test("edit/delete stale versions and wrong actor/PR cannot mutate", async () => {
  for (const kind of ["edit-comment", "delete-comment"] as const) {
    for (const entity of [
      issue("changed"),
      issue("old", { user: { id: 8 } }),
      issue("old", { issue_url: `${api}/issues/4` }),
    ]) {
      const f = fixture([user(), { path: "/repos/acme/repo/issues/comments/21", data: entity }]);
      const action: GithubWriteAction =
        kind === "edit-comment"
          ? { kind, target: remote, expectedBody: "old", body: "new" }
          : { kind, target: remote, expectedBody: "old" };
      assert.equal((await f.adapter.dispatch(operation(action))).outcome, "rejected");
      f.done();
    }
  }
});

test("edit classifies a remote precondition failure without retrying", async () => {
  const f = fixture([
    user(),
    { path: "/repos/acme/repo/issues/comments/21", data: issue("old"), headers: { etag: '"v1"' } },
    { path: "/repos/acme/repo/issues/comments/21", method: "PATCH", status: 412 },
  ]);
  const result = await f.adapter.dispatch(
    operation({ kind: "edit-comment", target: remote, expectedBody: "old", body: "new" }),
  );
  assert.equal(result.outcome, "rejected");
  assert.ok("error" in result && result.error.code === "conflict");
  f.done();
});

test("reconciliation exhausts pagination before matching and never follows supplied hosts", async () => {
  const f = fixture([
    user(),
    { path: listPath, data: [issue()], headers: { link: '<https://evil.test/steal>; rel="next"' } },
    { path: "/repos/acme/repo/issues/3/comments?per_page=100&page=2", data: [] },
  ]);
  assert.equal((await f.adapter.reconcile(operation())).outcome, "matched");
  f.done();
});

test("duplicate remote matches are ambiguous, including on later pages", async () => {
  const f = fixture([
    user(),
    { path: listPath, data: [issue()], headers: { link: '<ignored>; rel="next"' } },
    {
      path: "/repos/acme/repo/issues/3/comments?per_page=100&page=2",
      data: [issue(wire(), { id: 99 })],
    },
  ]);
  const result = await f.adapter.reconcile(operation());
  assert.equal(result.outcome, "ambiguous");
  assert.ok("candidates" in result && result.candidates.length === 2);
  f.done();
});

test("incomplete pagination never returns a premature match or absence", async () => {
  for (const data of [[], [issue()]]) {
    const f = fixture(
      [user(), { path: listPath, data, headers: { link: '<ignored>; rel="next"' } }],
      { maxPages: 1 },
    );
    const result = await f.adapter.reconcile(operation());
    assert.equal(result.outcome, "conflict");
    assert.ok("error" in result && result.error.retryable);
    f.done();
  }
  const f = fixture([
    user(),
    { path: listPath, data: [issue()], headers: { link: '<ignored>; rel="next"' } },
    { path: "/repos/acme/repo/issues/3/comments?per_page=100&page=2", status: 503 },
  ]);
  assert.equal((await f.adapter.reconcile(operation())).outcome, "conflict");
  f.done();
});

test("marker evidence must match stable actor, PR and clean body", async () => {
  for (const entity of [
    issue(wire(), { user: { id: 8 } }),
    issue(wire(), { issue_url: `${api}/issues/4` }),
    issue(wire("changed")),
  ]) {
    const f = fixture([user(), { path: listPath, data: [entity] }]);
    assert.equal((await f.adapter.reconcile(operation())).outcome, "conflict");
    f.done();
  }
});

test("absence is read-only and does not authorize a repost", async () => {
  const f = fixture([user(), { path: listPath, data: [] }]);
  assert.deepEqual(await f.adapter.reconcile(operation()), { outcome: "absent" });
  assert.ok(f.calls.every((call) => call.init.method === "GET"));
  f.done();
});

test("approval reconciliation requires approved state and exact commit", async () => {
  const op = operation({ kind: "approve", expectedHeadSha: sha, body: "hello" });
  for (const change of [{}, { commit_id: otherSha }, { state: "COMMENTED" }]) {
    const f = fixture([
      user(),
      {
        path: "/repos/acme/repo/pulls/3/reviews?per_page=100&page=1",
        data: [
          {
            id: 31,
            body: wire(),
            user: actor,
            state: "APPROVED",
            commit_id: sha,
            html_url: scope.url,
            ...change,
          },
        ],
      },
    ]);
    assert.equal(
      (await f.adapter.reconcile(op)).outcome,
      Object.keys(change).length ? "conflict" : "matched",
    );
    f.done();
  }
});

test("inline reconciliation checks full anchor, original positions, commit and root kind", async () => {
  const op = operation({
    kind: "inline-comment",
    body: "hello",
    expectedHeadSha: sha,
    anchor: { path: "src/a.ts", side: "RIGHT", line: 5, startLine: 2, startSide: "RIGHT" },
  });
  for (const change of [
    {},
    { path: "src/b.ts" },
    { side: "LEFT" },
    { line: 6 },
    { start_line: 3 },
    { start_side: "LEFT" },
    { commit_id: otherSha },
    { in_reply_to_id: 19 },
    { line: null, original_line: 5, start_line: null, original_start_line: 2 },
  ]) {
    const f = fixture([
      user(),
      {
        path: "/repos/acme/repo/pulls/3/comments?per_page=100&page=1",
        data: [inline(wire(), { start_line: 2, start_side: "RIGHT", ...change })],
      },
    ]);
    const expected =
      !Object.keys(change).length || "original_line" in change ? "matched" : "conflict";
    assert.equal((await f.adapter.reconcile(op)).outcome, expected);
    f.done();
  }
});

test("reply reconciliation requires original parent, commit and path", async () => {
  const op = operation({
    kind: "reply",
    body: "hello",
    target: { source: "remote", kind: "review-comment", id: 22 },
  });
  for (const change of [
    {},
    { in_reply_to_id: 99 },
    { commit_id: otherSha },
    { path: "other.ts" },
  ]) {
    const f = fixture([
      user(),
      { path: "/repos/acme/repo/pulls/comments/22", data: inline("parent") },
      {
        path: "/repos/acme/repo/pulls/3/comments?per_page=100&page=1",
        data: [inline(wire(), { id: 23, in_reply_to_id: 22, ...change })],
      },
    ]);
    assert.equal(
      (await f.adapter.reconcile(op)).outcome,
      Object.keys(change).length ? "conflict" : "matched",
    );
    f.done();
  }
});

test("edit reconciliation distinguishes desired, original and conflicting remote versions", async () => {
  const op = operation({ kind: "edit-comment", target: remote, expectedBody: "old", body: "new" });
  for (const [body, outcome] of [
    [wire("new"), "matched"],
    [wire("old"), "absent"],
    ["other", "conflict"],
  ]) {
    const f = fixture([user(), { path: listPath, data: [issue(body)] }]);
    const result = await f.adapter.reconcile(op);
    assert.equal(result.outcome, outcome);
    if (result.outcome === "matched")
      assert.ok("body" in result.result && result.result.body === "new");
    f.done();
  }
});

test("deletion proof requires accessible complete scoped listing, not generic 404", async () => {
  const op = operation({ kind: "delete-comment", target: remote, expectedBody: "old" });
  const f = fixture([user(), { path: listPath, data: [] }]);
  assert.deepEqual(await f.adapter.reconcile(op), {
    outcome: "matched",
    result: { kind: "deleted", target: remote },
  });
  f.done();
  for (const status of [401, 403, 404, 503]) {
    const bad = fixture([user(), { path: listPath, status }]);
    const result = await bad.adapter.reconcile(op);
    assert.notEqual(result.outcome, "matched");
    assert.notEqual(result.outcome, "absent");
    bad.done();
  }
});

function threadNode(resolved: boolean, extra: Record<string, unknown> = {}) {
  return {
    id: "PRRT_1",
    isResolved: resolved,
    pullRequest: { number: 3, repository: { nameWithOwner: "acme/repo" } },
    ...extra,
  };
}
test("resolve and unresolve verify thread scope then return confirmed state", async () => {
  for (const kind of ["resolve-thread", "unresolve-thread"] as const) {
    const desired = kind === "resolve-thread";
    const field = desired ? "resolveReviewThread" : "unresolveReviewThread";
    const f = fixture([
      user(),
      { path: "/graphql", method: "POST", data: { data: { node: threadNode(!desired) } } },
      {
        path: "/graphql",
        method: "POST",
        data: { data: { [field]: { thread: { id: "PRRT_1", isResolved: desired } } } },
        check: (init) => {
          const body = JSON.parse(String(init.body));
          assert.ok(body.query.includes(field));
          assert.deepEqual(body.variables, { id: "PRRT_1" });
        },
      },
    ]);
    assert.deepEqual(
      await f.adapter.dispatch(
        operation({ kind, target: { source: "remote", kind: "thread", nodeId: "PRRT_1" } }),
      ),
      { outcome: "accepted", result: { kind: "thread", nodeId: "PRRT_1", resolved: desired } },
    );
    f.done();
  }
});

test("thread scope mismatch blocks mutation; desired state is idempotent", async () => {
  const op = operation({
    kind: "resolve-thread",
    target: { source: "remote", kind: "thread", nodeId: "PRRT_1" },
  });
  for (const node of [
    threadNode(false, { pullRequest: { number: 4, repository: { nameWithOwner: "acme/repo" } } }),
    threadNode(false, { pullRequest: { number: 3, repository: { nameWithOwner: "other/repo" } } }),
    threadNode(true),
  ]) {
    const f = fixture([user(), { path: "/graphql", method: "POST", data: { data: { node } } }]);
    assert.equal((await f.adapter.dispatch(op)).outcome, node.isResolved ? "accepted" : "rejected");
    f.done();
  }
});

test("thread reconciliation uses live identity and exact requested state", async () => {
  for (const kind of ["resolve-thread", "unresolve-thread"] as const) {
    for (const resolved of [true, false]) {
      const f = fixture([
        user(),
        { path: "/graphql", method: "POST", data: { data: { node: threadNode(resolved) } } },
      ]);
      assert.equal(
        (
          await f.adapter.reconcile(
            operation({ kind, target: { source: "remote", kind: "thread", nodeId: "PRRT_1" } }),
          )
        ).outcome,
        resolved === (kind === "resolve-thread") ? "matched" : "conflict",
      );
      f.done();
    }
  }
});

test("GraphQL mutation errors or malformed success are uncertain", async () => {
  for (const data of [
    { errors: [{ message: "private" }] },
    { data: { resolveReviewThread: { thread: { id: "wrong", isResolved: true } } } },
  ]) {
    const f = fixture([
      user(),
      { path: "/graphql", method: "POST", data: { data: { node: threadNode(false) } } },
      { path: "/graphql", method: "POST", data },
    ]);
    const result = await f.adapter.dispatch(
      operation({
        kind: "resolve-thread",
        target: { source: "remote", kind: "thread", nodeId: "PRRT_1" },
      }),
    );
    assert.equal(result.outcome, "uncertain");
    assert.ok(!JSON.stringify(result).includes("private"));
    f.done();
  }
});

test("known rejections differ from possibly-applied transport/server failures", async () => {
  for (const [status, outcome] of [
    [401, "rejected"],
    [403, "rejected"],
    [404, "rejected"],
    [422, "rejected"],
    [408, "uncertain"],
    [500, "uncertain"],
    [503, "uncertain"],
    [202, "uncertain"],
  ] as const) {
    const f = fixture([
      user(),
      { path: "/repos/acme/repo/issues/3/comments", method: "POST", status, data: issue() },
    ]);
    assert.equal((await f.adapter.dispatch(operation())).outcome, outcome);
    f.done();
  }
});

test("invalid JSON and mismatching post-success entity remain uncertain", async () => {
  for (const response of [
    { raw: "not-json" },
    { data: issue(wire(), { user: { id: 8 } }) },
    { data: {} },
  ]) {
    const f = fixture([
      user(),
      { path: "/repos/acme/repo/issues/3/comments", method: "POST", ...response },
    ]);
    assert.equal((await f.adapter.dispatch(operation())).outcome, "uncertain");
    f.done();
  }
});

test("timeouts are bounded even if fetch ignores abort; preflight versus write ambiguity", async () => {
  const first = fixture([{ path: "/user", hang: true }], { timeoutMs: 15 });
  assert.equal((await first.adapter.dispatch(operation())).outcome, "rejected");
  first.done();
  const second = fixture(
    [user(), { path: "/repos/acme/repo/issues/3/comments", method: "POST", hang: true }],
    { timeoutMs: 15 },
  );
  assert.equal((await second.adapter.dispatch(operation())).outcome, "uncertain");
  second.done();
  assert.ok(second.calls[1]!.init.signal?.aborted);
});

test("successful headers with a stuck response body still time out uncertain", async () => {
  let writes = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    if (init?.method === "GET") return Response.json(actor);
    writes++;
    return new Response(new ReadableStream({ start() {} }));
  };
  const adapter = createGithubOutboxAdapter({
    fetch: fetcher,
    token: async () => "token",
    timeoutMs: 15,
  });
  assert.equal((await adapter.dispatch(operation())).outcome, "uncertain");
  assert.equal(writes, 1);
});

test("rate limit Retry-After and reset headers produce safe retry timestamps", async () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  for (const [headers, status, seconds] of [
    [{ "retry-after": "30" }, 429, 30],
    [{ "retry-after": "Thu, 01 Jan 2026 00:01:00 GMT" }, 403, 60],
    [{ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 90) }, 403, 90],
  ] as const) {
    const f = fixture(
      [user(), { path: "/repos/acme/repo/issues/3/comments", method: "POST", status, headers }],
      { now: () => now },
    );
    const result = await f.adapter.dispatch(operation());
    assert.equal(result.outcome, "rejected");
    assert.ok("error" in result && result.error.code === "rate-limit" && result.error.retryable);
    assert.ok(
      "error" in result && result.error.retryAt === new Date(now + seconds * 1000).toISOString(),
    );
    f.done();
  }
});

const candidateIssue = (): GithubRemoteResult => ({
  kind: "issue-comment",
  id: 21,
  body: "forged client body",
  author: { id: 999, login: "untrusted" },
  url: "https://github.com/untrusted/untrusted/pull/1",
  createdAt,
  updatedAt,
});
const candidateInline = (): GithubRemoteResult => ({
  kind: "review-comment",
  id: 22,
  body: "forged client body",
  author: actor,
  url: scope.url,
  createdAt,
  updatedAt,
  location: { path: "untrusted.ts", side: "LEFT", line: 90, originalLine: 90, commitSha: otherSha },
  threadId: "FORGED_THREAD",
});

test("verifyApplied treats candidate as ID only and returns fresh clean server evidence", async () => {
  const f = fixture([user(), { path: "/repos/acme/repo/issues/comments/21", data: issue() }]);
  assert.deepEqual(await f.adapter.verifyApplied(operation(), candidateIssue()), {
    outcome: "matched",
    result: {
      kind: "issue-comment",
      id: 21,
      nodeId: "IC_21",
      body: "hello",
      url: `${scope.url}#issuecomment-21`,
      author: actor,
      createdAt,
      updatedAt,
    },
  });
  f.done();
});

test("verifyApplied never trusts forged scope, actor, content, anchor, head or reply evidence", async () => {
  for (const entity of [
    issue(wire(), { user: { id: 999 } }),
    issue(wire("wrong")),
    issue(wire(), { issue_url: `${api}/issues/9` }),
  ]) {
    const f = fixture([user(), { path: "/repos/acme/repo/issues/comments/21", data: entity }]);
    assert.equal(
      (await f.adapter.verifyApplied(operation(), candidateIssue())).outcome,
      "conflict",
    );
    f.done();
  }
  const op = operation({
    kind: "inline-comment",
    body: "hello",
    expectedHeadSha: sha,
    anchor: { path: "src/a.ts", side: "RIGHT", line: 5 },
  });
  for (const change of [
    {},
    { commit_id: otherSha },
    { path: "wrong.ts" },
    { in_reply_to_id: 23 },
    { side: "LEFT" },
  ]) {
    const f = fixture([
      user(),
      { path: "/repos/acme/repo/pulls/comments/22", data: inline(wire(), change) },
    ]);
    const outcome = await f.adapter.verifyApplied(op, candidateInline());
    assert.equal(outcome.outcome, Object.keys(change).length ? "conflict" : "matched");
    if (outcome.outcome === "matched") {
      assert.ok(outcome.result.kind === "review-comment");
      assert.deepEqual(outcome.result.location, {
        path: "src/a.ts",
        side: "RIGHT",
        line: 5,
        originalLine: 5,
        commitSha: sha,
      });
      assert.equal(outcome.result.threadId, undefined);
    }
    f.done();
  }
  const reply = operation({
    kind: "reply",
    body: "hello",
    target: { source: "remote", kind: "review-comment", id: 23 },
  });
  const f = fixture([
    user(),
    { path: "/repos/acme/repo/pulls/comments/23", data: inline("parent", { id: 23 }) },
    { path: "/repos/acme/repo/pulls/comments/22", data: inline(wire(), { in_reply_to_id: 24 }) },
  ]);
  assert.equal((await f.adapter.verifyApplied(reply, candidateInline())).outcome, "conflict");
  f.done();
});

test("verifyApplied validates approval, edit, delete and thread through real reads", async () => {
  const approval = fixture([
    user(),
    {
      path: "/repos/acme/repo/pulls/3/reviews/31",
      data: {
        id: 31,
        state: "APPROVED",
        body: wire(),
        user: actor,
        commit_id: sha,
        html_url: scope.url,
      },
    },
  ]);
  assert.equal(
    (
      await approval.adapter.verifyApplied(
        operation({ kind: "approve", body: "hello", expectedHeadSha: sha }),
        { kind: "approval", id: 31, url: "untrusted", commitSha: otherSha },
      )
    ).outcome,
    "matched",
  );
  approval.done();
  const edit = fixture([
    user(),
    { path: "/repos/acme/repo/issues/comments/21", data: issue(wire("new")) },
  ]);
  const edited = await edit.adapter.verifyApplied(
    operation({ kind: "edit-comment", target: remote, body: "new", expectedBody: "old" }),
    candidateIssue(),
  );
  assert.ok(
    edited.outcome === "matched" && "body" in edited.result && edited.result.body === "new",
  );
  edit.done();
  const deletion = fixture([user(), { path: listPath, data: [] }]);
  assert.equal(
    (
      await deletion.adapter.verifyApplied(
        operation({ kind: "delete-comment", target: remote, expectedBody: "old" }),
        { kind: "deleted", target: remote },
      )
    ).outcome,
    "matched",
  );
  deletion.done();
  const thread = fixture([
    user(),
    { path: "/graphql", method: "POST", data: { data: { node: threadNode(true) } } },
  ]);
  assert.deepEqual(
    await thread.adapter.verifyApplied(
      operation({
        kind: "resolve-thread",
        target: { source: "remote", kind: "thread", nodeId: "PRRT_1" },
      }),
      { kind: "thread", nodeId: "PRRT_1", resolved: false },
    ),
    { outcome: "matched", result: { kind: "thread", nodeId: "PRRT_1", resolved: true } },
  );
  thread.done();
});

test("candidate kind/target mismatch and inaccessible candidates never confirm delivery", async () => {
  const f = fixture([user()]);
  assert.equal((await f.adapter.verifyApplied(operation(), candidateInline())).outcome, "conflict");
  f.done();
  for (const status of [401, 403, 404, 500]) {
    const bad = fixture([user(), { path: "/repos/acme/repo/issues/comments/21", status }]);
    const result = await bad.adapter.verifyApplied(operation(), candidateIssue());
    assert.ok(result.outcome !== "matched" && result.outcome !== "absent");
    bad.done();
  }
  const wrongActor = fixture([{ path: "/user", data: { id: 8, login: "other" } }]);
  assert.equal(
    (await wrongActor.adapter.verifyApplied(operation(), candidateIssue())).outcome,
    "auth",
  );
  wrongActor.done();
});

test("synced inline creation enriches actual GraphQL thread ID across thread/comment pages, without posts to REST", async () => {
  const op = operation({
    kind: "inline-comment",
    body: "hello",
    expectedHeadSha: sha,
    anchor: { path: "src/a.ts", side: "RIGHT", line: 5 },
  });
  op.status = "synced";
  const f = fixture([
    user(),
    { path: "/repos/acme/repo/pulls/3/comments?per_page=100&page=1", data: [inline()] },
    {
      path: "/graphql",
      method: "POST",
      data: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [],
                pageInfo: { hasNextPage: true, endCursor: "thread-page-2" },
              },
            },
          },
        },
      },
    },
    {
      path: "/graphql",
      method: "POST",
      check: (init) =>
        assert.equal(JSON.parse(String(init.body)).variables.cursor, "thread-page-2"),
      data: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "REAL_THREAD",
                    comments: {
                      nodes: [{ databaseId: 999 }],
                      pageInfo: { hasNextPage: true, endCursor: "comment-page-2" },
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      },
    },
    {
      path: "/graphql",
      method: "POST",
      data: {
        data: {
          node: {
            comments: {
              nodes: [{ databaseId: 22 }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
  ]);
  const result = await f.adapter.reconcile(op);
  assert.ok(result.outcome === "matched" && result.result.kind === "review-comment");
  assert.equal(result.result.threadId, "REAL_THREAD");
  assert.equal(result.result.nodeId, "RC_22");
  assert.ok(
    f.calls
      .filter((c) => c.init.method === "POST")
      .every((c) => c.path === "/graphql" && !String(c.init.body).includes("mutation")),
  );
  f.done();
});

test("thread discovery failure cannot invalidate a confirmed creation", async () => {
  const op = operation({
    kind: "inline-comment",
    body: "hello",
    expectedHeadSha: sha,
    anchor: { path: "src/a.ts", side: "RIGHT", line: 5 },
  });
  op.status = "synced";
  const f = fixture([
    user(),
    { path: "/repos/acme/repo/pulls/3/comments?per_page=100&page=1", data: [inline()] },
    { path: "/graphql", method: "POST", fail: true },
  ]);
  const result = await f.adapter.reconcile(op);
  assert.ok(
    result.outcome === "matched" &&
      result.result.kind === "review-comment" &&
      result.result.threadId === undefined,
  );
  f.done();
});

test("concurrent token refresh cannot change a dispatch credential after its identity check", async () => {
  let releaseHead!: () => void;
  let headStarted!: () => void;
  const paused = new Promise<void>((resolve) => {
    releaseHead = resolve;
  });
  const started = new Promise<void>((resolve) => {
    headStarted = resolve;
  });
  let identities = 0;
  let lookups = 0;
  let writeAuth: string | null = null;
  const fetcher: typeof fetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    if (path === "/user") {
      identities++;
      if (identities === 2) return new Response(null, { status: 401 });
      return Response.json(identities === 1 ? actor : { id: 8, login: "other" });
    }
    if (path === "/repos/acme/repo/pulls/3") {
      headStarted();
      await paused;
      return Response.json({ head: { sha } });
    }
    assert.equal(path, "/repos/acme/repo/pulls/3/reviews");
    writeAuth = new Headers(init.headers).get("authorization");
    return Response.json({
      id: 31,
      body: wire(),
      user: actor,
      state: "APPROVED",
      commit_id: sha,
      html_url: scope.url,
    });
  };
  const adapter = createGithubOutboxAdapter({
    fetch: fetcher,
    token: async () => `token-${++lookups}`,
  });
  const writing = adapter.dispatch(
    operation({ kind: "approve", body: "hello", expectedHeadSha: sha }),
  );
  await started;
  assert.equal((await adapter.identity()).outcome, "unavailable");
  assert.equal((await adapter.identity()).outcome, "known");
  releaseHead();
  assert.equal((await writing).outcome, "accepted");
  assert.equal(lookups, 3);
  assert.equal(writeAuth, "Bearer token-1");
});

test("success arriving after timeout remains uncertain until a read confirms the marker", async () => {
  let finish!: (response: Response) => void;
  const late = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  let writes = 0;
  const fetcher: typeof fetch = async (input, init = {}) => {
    if (new URL(String(input)).pathname === "/user") return Response.json(actor);
    if (init.method === "POST") {
      writes++;
      return late;
    }
    return Response.json([issue()]);
  };
  const adapter = createGithubOutboxAdapter({
    fetch: fetcher,
    token: async () => "token",
    timeoutMs: 15,
  });
  const original = await adapter.dispatch(operation());
  assert.equal(original.outcome, "uncertain");
  finish(Response.json(issue()));
  assert.equal((await adapter.reconcile(operation())).outcome, "matched");
  assert.equal(original.outcome, "uncertain");
  assert.equal(writes, 1);
});

test("GH01: pre-cancelled identity/dispatch/reconcile/verify do no HTTP or credential lookup", async () => {
  let lookups = 0;
  const controller = new AbortController();
  controller.abort();
  const f = fixture([], {
    token: async () => {
      lookups++;
      return "token";
    },
  });
  const options = { signal: controller.signal };
  assert.equal((await f.adapter.identity(options)).outcome, "unavailable");
  assert.equal((await f.adapter.dispatch(operation(), options)).outcome, "rejected");
  assert.equal((await f.adapter.reconcile(operation(), options)).outcome, "conflict");
  assert.equal(
    (await f.adapter.verifyApplied(operation(), candidateIssue(), options)).outcome,
    "conflict",
  );
  assert.equal(lookups, 0);
  assert.equal(f.calls.length, 0);
});

test("GH01: old owner held in identity cannot POST after cancellation, even when its mock later succeeds", async () => {
  const controller = new AbortController();
  let release!: (response: Response) => void;
  let started!: () => void;
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let identities = 0;
  let writes = 0;
  let oldSignal: AbortSignal | null | undefined;
  const fetcher: typeof fetch = async (input, init = {}) => {
    if (new URL(String(input)).pathname === "/user") {
      if (++identities === 1) {
        oldSignal = init.signal;
        started();
        return held;
      }
      return Response.json(actor);
    }
    writes++;
    return Response.json(issue());
  };
  const adapter = createGithubOutboxAdapter({ fetch: fetcher, token: async () => "token" });
  const old = adapter.dispatch(operation(), { signal: controller.signal });
  await waiting;
  controller.abort();
  assert.equal((await old).outcome, "rejected");
  assert.ok(oldSignal?.aborted);
  release(Response.json(actor));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(writes, 0);
  // A successor is unaffected by the old owner's signal.
  assert.equal((await adapter.dispatch(operation())).outcome, "accepted");
  assert.equal(writes, 1);
});

test("GH01: cancellation during credential acquisition prevents late fetch", async () => {
  const controller = new AbortController();
  let release!: (token: string) => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = fixture([], {
    token: () => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const pending = f.adapter.dispatch(operation(), { signal: controller.signal });
  await waiting;
  controller.abort();
  assert.equal((await pending).outcome, "rejected");
  release("token");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.calls.length, 0);
});

test("GH01: all mutation preflights share cancellation, including GraphQL queries", async () => {
  const cases: { action: GithubWriteAction; step: Step }[] = [
    { action: { kind: "approve", expectedHeadSha: sha, body: "hello" }, step: head() },
    {
      action: {
        kind: "inline-comment",
        expectedHeadSha: sha,
        body: "hello",
        anchor: { path: "src/a.ts", side: "RIGHT", line: 5 },
      },
      step: head(),
    },
    {
      action: { kind: "edit-comment", target: remote, body: "new", expectedBody: "old" },
      step: { path: "/repos/acme/repo/issues/comments/21", data: issue("old") },
    },
    {
      action: { kind: "delete-comment", target: remote, expectedBody: "old" },
      step: { path: "/repos/acme/repo/issues/comments/21", data: issue("old") },
    },
    {
      action: {
        kind: "reply",
        target: { source: "remote", kind: "review-comment", id: 22 },
        body: "hello",
      },
      step: { path: "/repos/acme/repo/pulls/comments/22", data: inline("parent") },
    },
    ...(["resolve-thread", "unresolve-thread"] as const).map((kind) => ({
      action: {
        kind,
        target: { source: "remote" as const, kind: "thread" as const, nodeId: "PRRT_1" },
      },
      step: {
        path: "/graphql",
        method: "POST",
        data: { data: { node: threadNode(kind !== "resolve-thread") } },
      },
    })),
  ];
  for (const { action, step } of cases) {
    // Exercise both an abort-ignoring held read and a successful read returned after abort.
    for (const hang of [true, false]) {
      const controller = new AbortController();
      const f = fixture([
        user(),
        {
          ...step,
          hang,
          check: (init) => {
            controller.abort();
            assert.ok(init.signal?.aborted);
          },
        },
      ]);
      assert.equal(
        (await f.adapter.dispatch(operation(action), { signal: controller.signal })).outcome,
        "rejected",
      );
      f.done();
      assert.equal(f.calls.length, 2);
    }
  }
});

test("GH01: cancellation after sending any mutation is uncertain, never proven rejected", async () => {
  const cases: { action: GithubWriteAction; preflight: Step[]; write: Step }[] = [
    {
      action: { kind: "issue-comment", body: "hello" },
      preflight: [],
      write: { path: "/repos/acme/repo/issues/3/comments", method: "POST" },
    },
    {
      action: { kind: "edit-comment", target: remote, body: "new", expectedBody: "old" },
      preflight: [{ path: "/repos/acme/repo/issues/comments/21", data: issue("old") }],
      write: { path: "/repos/acme/repo/issues/comments/21", method: "PATCH" },
    },
    {
      action: { kind: "delete-comment", target: remote, expectedBody: "old" },
      preflight: [{ path: "/repos/acme/repo/issues/comments/21", data: issue("old") }],
      write: { path: "/repos/acme/repo/issues/comments/21", method: "DELETE" },
    },
    {
      action: {
        kind: "resolve-thread",
        target: { source: "remote", kind: "thread", nodeId: "PRRT_1" },
      },
      preflight: [
        { path: "/graphql", method: "POST", data: { data: { node: threadNode(false) } } },
      ],
      write: { path: "/graphql", method: "POST" },
    },
  ];
  for (const { action, preflight, write } of cases) {
    const controller = new AbortController();
    const f = fixture([
      user(),
      ...preflight,
      { ...write, hang: true, check: () => controller.abort() },
    ]);
    assert.equal(
      (await f.adapter.dispatch(operation(action), { signal: controller.signal })).outcome,
      "uncertain",
    );
    f.done();
  }
});

test("GH01: read-only reconciliation and verification requests are cancellable even with ignoring mocks", async () => {
  for (const kind of ["reconcile", "verify"] as const) {
    const controller = new AbortController();
    const f = fixture([
      user(),
      {
        path: kind === "reconcile" ? listPath : "/repos/acme/repo/issues/comments/21",
        hang: true,
        check: (init) => {
          controller.abort();
          assert.ok(init.signal?.aborted);
        },
      },
    ]);
    const result =
      kind === "reconcile"
        ? await f.adapter.reconcile(operation(), { signal: controller.signal })
        : await f.adapter.verifyApplied(operation(), candidateIssue(), {
            signal: controller.signal,
          });
    assert.equal(result.outcome, "conflict");
    f.done();
  }
});

test("GH02: mixed-case API membership works in dispatch, reconciliation and candidate verification", async () => {
  const actions: GithubWriteAction[] = [
    { kind: "issue-comment", body: "hello" },
    {
      kind: "inline-comment",
      expectedHeadSha: sha,
      body: "hello",
      anchor: { path: "src/a.ts", side: "RIGHT", line: 5 },
    },
  ];
  for (const action of actions) {
    const isIssue = action.kind === "issue-comment";
    for (const membership of [
      `https://api.github.com/repos/Acme/Repo/${isIssue ? "issues" : "pulls"}/3`,
      `https://api.github.com/repos/%41cme/%52epo/${isIssue ? "issues" : "pulls"}/3`,
    ]) {
      const data = isIssue
        ? issue(wire(), { issue_url: membership })
        : inline(wire(), { pull_request_url: membership });
      const path = `/repos/acme/repo/${isIssue ? "issues" : "pulls"}/3/comments`;
      const candidatePath = `/repos/acme/repo/${isIssue ? "issues" : "pulls"}/comments/${isIssue ? 21 : 22}`;
      const f = fixture([
        user(),
        ...(isIssue ? [] : [head()]),
        { path, method: "POST", data },
        user(),
        { path: `${path}?per_page=100&page=1`, data: [data] },
        user(),
        { path: candidatePath, data },
      ]);
      assert.equal((await f.adapter.dispatch(operation(action))).outcome, "accepted");
      assert.equal((await f.adapter.reconcile(operation(action))).outcome, "matched");
      assert.equal(
        (
          await f.adapter.verifyApplied(
            operation(action),
            isIssue ? candidateIssue() : candidateInline(),
          )
        ).outcome,
        "matched",
      );
      f.done();
    }
  }
});

test("GH02: strict membership rejects foreign hosts, numbers, resources, substring and encoded-segment tricks", async () => {
  const links = [
    "https://api.github.com.evil.test/repos/acme/repo/issues/3",
    "https://api.github.com@evil.test/repos/acme/repo/issues/3",
    "https://evil.test@api.github.com/repos/acme/repo/issues/3",
    "http://api.github.com/repos/acme/repo/issues/3",
    `${api}/issues/30`,
    `${api}/issues/03`,
    `${api}/pulls/3`,
    `${api}/issues/3/extra`,
    `${api}/issues/3?scope=other`,
    `${api}/issues/3#other`,
    "https://api.github.com/repos/acmee/repo/issues/3",
    "https://api.github.com/repos/acme/repo-more/issues/3",
    "https://api.github.com/repos/acme%2Frepo/repo/issues/3",
    "https://api.github.com/repos/acme/repo%2Fextra/issues/3",
    "https://api.github.com/repos/acme/%2552epo/issues/3",
    "https://api.github.com/repos/acme/wrong/../repo/issues/3",
    "https://api.github.com/repos/acme/wrong/%2e%2e/repo/issues/3",
    "https://api.github.com/repos/acme/%ZZ/issues/3",
  ];
  for (const issue_url of links) {
    const data = issue(wire(), { issue_url });
    const f = fixture([
      user(),
      { path: "/repos/acme/repo/issues/3/comments", method: "POST", data },
      user(),
      { path: listPath, data: [data] },
      user(),
      { path: "/repos/acme/repo/issues/comments/21", data },
    ]);
    assert.equal((await f.adapter.dispatch(operation())).outcome, "uncertain");
    assert.equal((await f.adapter.reconcile(operation())).outcome, "conflict");
    assert.equal(
      (await f.adapter.verifyApplied(operation(), candidateIssue())).outcome,
      "conflict",
    );
    f.done();
  }
});

test("GH04: a valid old token cannot conceal a gh account switch from any top-level method", async () => {
  let token = "account-A";
  let lookups = 0;
  const seen: string[] = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    assert.equal(
      new URL(String(input)).pathname,
      "/user",
      "Account mismatch must stop before other HTTP",
    );
    const auth = new Headers(init.headers).get("authorization")!;
    seen.push(auth);
    return Response.json(auth === "Bearer account-A" ? actor : { id: 8, login: "bob" });
  };
  const adapter = createGithubOutboxAdapter({
    fetch: fetcher,
    token: async () => {
      lookups++;
      return token;
    },
  });
  assert.deepEqual(await adapter.identity(), { outcome: "known", actor });
  token = "account-B"; // No 401: account A's token remains valid.
  assert.deepEqual(await adapter.identity(), { outcome: "known", actor: { id: 8, login: "bob" } });
  assert.equal((await adapter.dispatch(operation())).outcome, "rejected");
  assert.equal((await adapter.reconcile(operation())).outcome, "auth");
  assert.equal((await adapter.verifyApplied(operation(), candidateIssue())).outcome, "auth");
  assert.equal(lookups, 5);
  assert.deepEqual(seen, ["Bearer account-A", ...Array(4).fill("Bearer account-B")]);
});

test("GH04: each top-level call refreshes once and all its HTTP uses that exact snapshot", async () => {
  let lookups = 0;
  const f = fixture(
    [
      user(),
      { path: "/repos/acme/repo/issues/3/comments", method: "POST", data: issue() },
      user(),
      { path: listPath, data: [issue()] },
      user(),
      { path: "/repos/acme/repo/issues/comments/21", data: issue() },
    ],
    { token: async () => `token-${++lookups}` },
  );
  assert.equal((await f.adapter.dispatch(operation())).outcome, "accepted");
  assert.equal((await f.adapter.reconcile(operation())).outcome, "matched");
  assert.equal((await f.adapter.verifyApplied(operation(), candidateIssue())).outcome, "matched");
  assert.equal(lookups, 3);
  assert.deepEqual(
    f.calls.map((c) => new Headers(c.init.headers).get("authorization")),
    [
      "Bearer token-1",
      "Bearer token-1",
      "Bearer token-2",
      "Bearer token-2",
      "Bearer token-3",
      "Bearer token-3",
    ],
  );
  f.done();
});

function confirmedInlineResult(): GithubRemoteResult {
  return {
    kind: "review-comment",
    id: 22,
    nodeId: "RC_22",
    body: "hello",
    author: actor,
    createdAt,
    updatedAt,
    url: `${scope.url}#discussion_r22`,
    location: { path: "src/a.ts", side: "RIGHT", line: 5, originalLine: 5, commitSha: sha },
  };
}
function syncedInline(): GithubOutboxOperation {
  const op = operation({
    kind: "inline-comment",
    body: "hello",
    expectedHeadSha: sha,
    anchor: { path: "src/a.ts", side: "RIGHT", line: 5 },
  });
  op.status = "synced";
  op.result = confirmedInlineResult();
  return op;
}
const discoverThread: Step = {
  path: "/graphql",
  method: "POST",
  data: {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: "REAL_THREAD",
                comments: { nodes: [{ databaseId: 22 }], pageInfo: { hasNextPage: false } },
              },
            ],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    },
  },
};

test("GH05: synced inline edited later enriches by durable ID and current revision, not stale body", async () => {
  const op = syncedInline();
  const original = structuredClone(op);
  const editedAt = "2026-01-03T00:00:00Z";
  const f = fixture([
    user(),
    {
      path: "/repos/acme/repo/pulls/comments/22",
      data: inline(wire("later edit"), { updated_at: editedAt }),
    },
    discoverThread,
  ]);
  const result = await f.adapter.reconcile(op);
  assert.ok(result.outcome === "matched" && result.result.kind === "review-comment");
  assert.equal(result.result.id, 22);
  assert.equal(result.result.threadId, "REAL_THREAD");
  assert.equal(result.result.body, "later edit");
  assert.equal(result.result.updatedAt, editedAt);
  assert.deepEqual(op, original);
  assert.ok(
    f.calls.every(
      (c) =>
        c.init.method === "GET" ||
        (c.path === "/graphql" && !String(c.init.body).includes("mutation")),
    ),
  );
  f.done();
});

test("GH05: synced enrichment rejects actor/membership/identity and regressed revision evidence", async () => {
  for (const change of [
    { user: { id: 8, login: "bob" } },
    { pull_request_url: `${api}/pulls/4` },
    { node_id: "OTHER_NODE" },
    { created_at: "2025-01-01T00:00:00Z" },
    { updated_at: "2026-01-01T00:00:00Z" },
  ]) {
    const f = fixture([
      user(),
      { path: "/repos/acme/repo/pulls/comments/22", data: inline(wire("later edit"), change) },
    ]);
    const result = await f.adapter.reconcile(syncedInline());
    assert.ok(result.outcome === "conflict" || result.outcome === "auth");
    f.done();
  }
});

test("GH05: discovery failure leaves edited synced creation matched; uncertain creation still needs original body", async () => {
  const f = fixture([
    user(),
    { path: "/repos/acme/repo/pulls/comments/22", data: inline(wire("later edit")) },
    { path: "/graphql", method: "POST", fail: true },
  ]);
  const result = await f.adapter.reconcile(syncedInline());
  assert.ok(
    result.outcome === "matched" &&
      result.result.kind === "review-comment" &&
      result.result.body === "later edit",
  );
  f.done();
  const op = syncedInline();
  op.status = "uncertain";
  const uncertain = fixture([
    user(),
    {
      path: "/repos/acme/repo/pulls/3/comments?per_page=100&page=1",
      data: [inline(wire("later edit"))],
    },
  ]);
  assert.equal((await uncertain.adapter.reconcile(op)).outcome, "conflict");
  uncertain.done();
});

test("GH07: replying to a reply fetches the verified root, posts there, and returns the root parent identity", async () => {
  const op = operation({
    kind: "reply",
    body: "hello",
    target: { source: "remote", kind: "review-comment", id: 23 },
  });
  const original = structuredClone(op);
  const f = fixture([
    user(),
    {
      path: "/repos/acme/repo/pulls/comments/23",
      data: inline("reply", { id: 23, in_reply_to_id: 22 }),
    },
    {
      path: "/repos/acme/repo/pulls/comments/22",
      data: inline("root", { user: { id: 8, login: "bob" } }),
    },
    {
      path: "/repos/acme/repo/pulls/3/comments/22/replies",
      method: "POST",
      data: inline(wire(), { id: 24, in_reply_to_id: 22 }),
    },
  ]);
  const result = await f.adapter.dispatch(op);
  assert.ok(result.outcome === "accepted" && result.result.kind === "review-comment");
  assert.equal(result.result.id, 24);
  assert.equal(result.result.inReplyToId, 22);
  assert.deepEqual(op, original);
  f.done();
});

test("GH07: reconciliation and explicit verification both match normalized root, not selected reply ID", async () => {
  const op = operation({
    kind: "reply",
    body: "hello",
    target: { source: "remote", kind: "review-comment", id: 23 },
  });
  for (const verify of [true, false]) {
    for (const in_reply_to_id of [22, 23]) {
      const f = fixture([
        user(),
        {
          path: "/repos/acme/repo/pulls/comments/23",
          data: inline("reply", { id: 23, in_reply_to_id: 22 }),
        },
        { path: "/repos/acme/repo/pulls/comments/22", data: inline("root") },
        {
          path: verify
            ? "/repos/acme/repo/pulls/comments/24"
            : "/repos/acme/repo/pulls/3/comments?per_page=100&page=1",
          data: verify
            ? inline(wire(), { id: 24, in_reply_to_id })
            : [inline(wire(), { id: 24, in_reply_to_id })],
        },
      ]);
      const candidate = { ...candidateInline(), id: 24 };
      const result = verify
        ? await f.adapter.verifyApplied(op, candidate)
        : await f.adapter.reconcile(op);
      assert.equal(result.outcome, in_reply_to_id === 22 ? "matched" : "conflict");
      if (result.outcome === "matched")
        assert.ok(result.result.kind === "review-comment" && result.result.inReplyToId === 22);
      f.done();
    }
  }
});

test("GH07: inaccessible, foreign, cyclic or conflicting reply roots cannot dispatch", async () => {
  const op = operation({
    kind: "reply",
    body: "hello",
    target: { source: "remote", kind: "review-comment", id: 23 },
  });
  const roots: Step[] = [
    { status: 404, path: "/repos/acme/repo/pulls/comments/22" },
    ...[
      { pull_request_url: `${api}/pulls/4` },
      { in_reply_to_id: 23 },
      { commit_id: otherSha },
      { path: "other.ts" },
    ].map((change) => ({
      path: "/repos/acme/repo/pulls/comments/22",
      data: inline("root", change),
    })),
  ];
  for (const root of roots) {
    const f = fixture([
      user(),
      {
        path: "/repos/acme/repo/pulls/comments/23",
        data: inline("reply", { id: 23, in_reply_to_id: 22 }),
      },
      root,
    ]);
    assert.equal((await f.adapter.dispatch(op)).outcome, "rejected");
    assert.ok(f.calls.every((c) => c.init.method === "GET"));
    f.done();
  }
});
