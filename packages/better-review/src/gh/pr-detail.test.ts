import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import type { PrMergeAction, PrMergeInput } from "@better-review/shared";

import { createPrDetailClient } from "./pr-detail";
import { createPrMergeService } from "./pr-merge";

const url = "https://github.com/o/r/pull/1";
const sha = "a".repeat(40);
function fixture() {
  const state = {
    writes: 0,
    actor: "U1",
    head: sha,
    baseSha: "b".repeat(40),
    admin: true,
    queue: false,
    queued: false,
    merged: false,
    permission: "WRITE",
    timeout: false,
    unknown: false,
    paginate: false,
    mergeState: "CLEAN",
    reviewDecision: "APPROVED" as string | null,
    rules: [] as unknown[],
    rulesDenied: false,
    classic: null as unknown,
    checkConclusion: "SUCCESS" as string | null,
    checkStatus: "COMPLETED",
    tokens: [] as string[],
  };
  const fetcher: typeof fetch = async (input, init) => {
    state.tokens.push(new Headers(init?.headers).get("Authorization")!);
    if (init?.method === "GET")
      return state.rulesDenied
        ? Response.json({ message: "denied" }, { status: 403 })
        : Response.json(state.rules);
    const body = JSON.parse(String(init?.body));
    const query = body.query ?? "";
    if (init?.method === "PUT" || query.startsWith("mutation")) {
      state.writes++;
      assert.equal(body.sha ?? body.variables.input.expectedHeadOid, sha);
      assert.equal(body.variables?.input?.jump, undefined);
      if (state.timeout) throw new Error("lost response");
      return Response.json(
        init?.method === "PUT"
          ? { merged: true }
          : { data: { enqueuePullRequest: { mergeQueueEntry: { id: "Q1" } } } },
      );
    }
    if (query === "query{viewer{id login databaseId}}")
      return Response.json({ data: { viewer: { id: state.actor, login: "me", databaseId: 42 } } });
    if (query.includes("mergeCommitAllowed"))
      return Response.json(
        state.unknown
          ? { errors: [{ message: "scope" }] }
          : {
              data: {
                repository: {
                  mergeCommitAllowed: true,
                  squashMergeAllowed: true,
                  rebaseMergeAllowed: true,
                  viewerPermission: state.permission,
                  pullRequest: {
                    headRefOid: state.head,
                    baseRefOid: state.baseSha,
                    baseRefName: "main",
                    state: state.merged ? "MERGED" : "OPEN",
                    isDraft: false,
                    viewerCanMergeAsAdmin: state.admin,
                    mergeable: "MERGEABLE",
                    mergeStateStatus: state.mergeState,
                    reviewDecision: state.reviewDecision,
                    mergeQueueEntry: state.queued
                      ? { id: "existing-queue-entry", position: 2 }
                      : null,
                    autoMergeRequest: null,
                  },
                },
              },
            },
      );
    if (query.includes("mergeQueue(branch"))
      return Response.json({
        data: { repository: { mergeQueue: state.queue ? { id: "Q" } : null } },
      });
    if (query.includes("statusCheckRollup"))
      return Response.json({
        data: {
          repository: {
            object: {
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    {
                      __typename: "CheckRun",
                      id: "C",
                      name: "test",
                      status: state.checkStatus,
                      conclusion: state.checkConclusion,
                      detailsUrl: "https://github.com/check",
                      checkSuite: { app: { databaseId: 1 } },
                    },
                    {
                      __typename: "StatusContext",
                      id: "S",
                      context: "legacy",
                      state: "PENDING",
                      targetUrl: null,
                    },
                  ],
                  pageInfo: {
                    hasNextPage: state.paginate && !body.variables.cursor,
                    endCursor: state.paginate && !body.variables.cursor ? "next" : null,
                  },
                },
              },
            },
          },
        },
      });
    let pr: unknown;
    if (query.includes("headRefOid") && !query.includes("branchProtectionRule"))
      pr = {
        id: "PR1",
        number: 1,
        url,
        title: "Title",
        body: "Body",
        author: { login: "author" },
        state: state.merged ? "MERGED" : "OPEN",
        isDraft: false,
        headRefName: "feature",
        headRefOid: state.head,
        baseRefName: "main",
        baseRefOid: state.baseSha,
        mergedAt: null,
        mergedBy: null,
        mergeCommit: null,
      };
    else if (query.includes("branchProtectionRule"))
      pr = { baseRef: { branchProtectionRule: state.classic } };
    else {
      const field = query.includes("labels(")
        ? "labels"
        : query.includes("reviews(")
          ? "reviews"
          : "reviewRequests";
      pr = { [field]: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
    }
    return Response.json({ data: { repository: { pullRequest: pr } } });
  };
  return { state, fetcher };
}
function intent(action: PrMergeAction = { kind: "merge", method: "squash" }): PrMergeInput {
  return {
    url,
    requestId: randomUUID(),
    expectedActor: { id: "U1", login: "me" },
    expectedHeadSha: sha,
    action,
  };
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "pr-merge-test-"));
  const f = fixture();
  const options = {
    databasePath: join(dir, "attempts.sqlite"),
    fetch: f.fetcher,
    token: async () => "secret",
    admin: async () => {
      f.state.writes++;
    },
  };
  const service = createPrMergeService(options);
  return {
    ...f,
    options,
    service,
    cleanup: async () => {
      service.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("detail exposes metadata, both check kinds, URLs and explicit section evidence", async () => {
  const f = fixture();
  const detail = await createPrDetailClient({ fetch: f.fetcher, token: async () => "secret" }).get(
    url,
  );
  assert.equal(detail.metadata.status, "available");
  assert.equal(detail.actor.status === "available" && detail.actor.data.databaseId, 42);
  assert.equal(detail.checks.status, "available");
  if (detail.checks.status === "available")
    assert.deepEqual(
      detail.checks.data.map((c) => c.kind),
      ["check-run", "status-context"],
    );
  assert.ok(f.state.tokens.every((t) => t === "Bearer secret"));
});
for (const kind of ["merge", "admin-merge"] as const)
  for (const method of ["merge", "squash", "rebase"] as const)
    test(`${kind} ${method}: one dispatch across replay and restart`, async () => {
      const s = await setup();
      try {
        const input = intent({ kind, method });
        const expected = kind === "admin-merge" ? "uncertain" : "succeeded";
        assert.equal((await s.service.merge(input)).status, expected);
        assert.equal((await s.service.merge(input)).status, expected);
        s.service.close();
        const restarted = createPrMergeService(s.options);
        try {
          assert.equal((await restarted.merge(input)).status, expected);
          assert.equal(s.state.writes, 1);
        } finally {
          restarted.close();
        }
      } finally {
        await s.cleanup();
      }
    });
test("enqueue uses expected head and never enables auto-merge", async () => {
  const s = await setup();
  try {
    s.state.queue = true;
    assert.equal((await s.service.merge(intent({ kind: "enqueue" }))).status, "succeeded");
    assert.equal(s.state.writes, 1);
  } finally {
    await s.cleanup();
  }
});
for (const drift of ["actor", "head", "admin", "scope"] as const)
  test(`preflight rejects ${drift} drift without dispatch`, async () => {
    const s = await setup();
    try {
      if (drift === "actor") s.state.actor = "U2";
      if (drift === "head") s.state.head = "c".repeat(40);
      if (drift === "admin") {
        s.state.admin = false;
        s.state.permission = "ADMIN";
      }
      if (drift === "scope") s.state.unknown = true;
      assert.equal(
        (await s.service.merge(intent({ kind: "admin-merge", method: "merge" }))).status,
        "rejected",
      );
      assert.equal(s.state.writes, 0);
    } finally {
      await s.cleanup();
    }
  });
test("post-dispatch failure remains uncertain; reconciliation and replay never resend", async () => {
  const s = await setup();
  try {
    s.state.timeout = true;
    const input = intent();
    assert.equal((await s.service.merge(input)).status, "uncertain");
    assert.equal((await s.service.reconcileMerge(input)).status, "uncertain");
    assert.equal((await s.service.merge(input)).status, "uncertain");
    assert.equal(s.state.writes, 1);
  } finally {
    await s.cleanup();
  }
});
test("concurrent UUID is singleflight and changed fingerprint conflicts", async () => {
  const s = await setup();
  try {
    const input = intent();
    await Promise.all([s.service.merge(input), s.service.merge(input)]);
    assert.equal(s.state.writes, 1);
    await assert.rejects(
      s.service.merge({ ...input, expectedHeadSha: "b".repeat(40) }),
      /conflicts/,
    );
  } finally {
    await s.cleanup();
  }
});
test("unknown authentication does not fabricate empty sections", async () => {
  const detail = await createPrDetailClient({
    token: async () => {
      throw new Error("no auth");
    },
  }).get(url);
  assert.equal(detail.labels.status, "unavailable");
  assert.equal(detail.checks.status, "unavailable");
});
test("rejects noncanonical hosts before credential access", async () => {
  await assert.rejects(
    createPrDetailClient({
      token: async () => {
        throw new Error("must not run");
      },
    }).get("https://github.com.evil/o/r/pull/1"),
    /canonical/,
  );
});

test("checks pagination completes or explicitly reports a page limit", async () => {
  const f = fixture();
  f.state.paginate = true;
  const complete = await createPrDetailClient({
    fetch: f.fetcher,
    token: async () => "secret",
  }).get(url);
  assert.equal(complete.checks.status, "available");
  if (complete.checks.status === "available") {
    assert.equal(complete.checks.complete, true);
    assert.equal(complete.checks.data.length, 4);
  }
  const partial = await createPrDetailClient({
    fetch: f.fetcher,
    token: async () => "secret",
    maxPages: 1,
  }).get(url);
  if (partial.checks.status === "available") assert.equal(partial.checks.complete, false);
  else assert.fail("expected partial section");
});
test("two journal connections claim a UUID only once", async () => {
  const s = await setup();
  const other = createPrMergeService(s.options);
  try {
    const input = intent();
    await Promise.all([s.service.merge(input), other.merge(input)]);
    assert.equal(s.state.writes, 1);
  } finally {
    other.close();
    await s.cleanup();
  }
});
test("bounded preflight timeout rejects without dispatch and never retries", async () => {
  const s = await setup();
  const service = createPrMergeService({
    ...s.options,
    timeoutMs: 5,
    token: () => new Promise<string>(() => {}),
  });
  try {
    const input = intent();
    assert.equal((await service.merge(input)).status, "rejected");
    assert.equal((await service.merge(input)).dispatched, false);
    assert.equal(s.state.writes, 0);
  } finally {
    service.close();
    await s.cleanup();
  }
});
test("credential snapshot is read once and pinned through mutation", async () => {
  const s = await setup();
  let credentials = 0;
  const service = createPrMergeService({
    ...s.options,
    token: async () => `secret-${++credentials}`,
  });
  try {
    await service.merge(intent());
    assert.equal(credentials, 1);
    assert.ok(s.state.tokens.every((token) => token === "Bearer secret-1"));
  } finally {
    service.close();
    await s.cleanup();
  }
});
test("journal initialization failure rejects writes without blocking detail reads", async () => {
  const s = await setup();
  const service = createPrMergeService({
    ...s.options,
    databasePath: s.options.databasePath + "/bad.sqlite",
  });
  try {
    await s.service.merge(intent());
    assert.equal((await service.merge(intent())).status, "rejected");
    assert.equal((await createPrDetailClient(s.options).get(url)).metadata.status, "available");
    assert.equal(s.state.writes, 1);
  } finally {
    service.close();
    await s.cleanup();
  }
});

test("admin invocation pins host, credential, expected SHA and explicit method without branch deletion", async () => {
  const s = await setup();
  const service = createPrMergeService({
    ...s.options,
    admin: async (args, env, timeout) => {
      assert.deepEqual(args, [
        "pr",
        "merge",
        url,
        "--admin",
        "--match-head-commit",
        sha,
        "--rebase",
      ]);
      assert.equal(env.GH_TOKEN, "secret");
      assert.equal(env.GITHUB_TOKEN, "secret");
      assert.equal(env.GH_HOST, "github.com");
      assert.equal(timeout, 15000);
    },
  });
  try {
    assert.equal(
      (await service.merge(intent({ kind: "admin-merge", method: "rebase" }))).status,
      "uncertain",
    );
  } finally {
    service.close();
    await s.cleanup();
  }
});
test("a stuck mutation times out uncertain even when fetch ignores abort", async () => {
  const s = await setup();
  const service = createPrMergeService({
    ...s.options,
    timeoutMs: 10,
    fetch: async (input, init) =>
      init?.method === "PUT" ? new Promise<Response>(() => {}) : s.fetcher(input, init),
  });
  try {
    const input = intent();
    const result = await service.merge(input);
    assert.equal(result.status, "uncertain");
    assert.equal(result.dispatched, true);
    assert.equal((await service.merge(input)).status, "uncertain");
  } finally {
    service.close();
    await s.cleanup();
  }
});

test("uncertainty survives restart; observing merged does not attribute success", async () => {
  const s = await setup();
  try {
    s.state.timeout = true;
    const input = intent();
    assert.equal((await s.service.merge(input)).status, "uncertain");
    s.service.close();
    const restarted = createPrMergeService(s.options);
    try {
      s.state.merged = true;
      const observed = await restarted.reconcileMerge(input);
      assert.equal(observed.observed?.state, "MERGED");
      assert.equal(observed.status, "uncertain");
      assert.equal((await restarted.merge(input)).status, "uncertain");
      assert.equal(s.state.writes, 1);
    } finally {
      restarted.close();
    }
  } finally {
    await s.cleanup();
  }
});
test("existing queue membership is observed, never claimed as this request's success", async () => {
  const s = await setup();
  try {
    s.state.queue = true;
    s.state.queued = true;
    const result = await s.service.merge(intent({ kind: "enqueue" }));
    assert.equal(result.status, "rejected");
    assert.equal(result.dispatched, false);
    assert.equal(result.observed?.queued, true);
    assert.equal(s.state.writes, 0);
  } finally {
    await s.cleanup();
  }
});

test("BLOCK7: admin CLI zero while PR remains open is not merge confirmation", async () => {
  const s = await setup();
  try {
    const result = await s.service.merge(intent({ kind: "admin-merge", method: "merge" }));
    assert.equal(result.status, "uncertain");
  } finally {
    await s.cleanup();
  }
});
test("BLOCK7: definitive head conflict is rejected, not uncertain", async () => {
  const s = await setup();
  const service = createPrMergeService({
    ...s.options,
    fetch: async (input, init) =>
      init?.method === "PUT"
        ? Response.json({ message: "Head branch was modified" }, { status: 409 })
        : s.fetcher(input, init),
  });
  try {
    assert.equal((await service.merge(intent())).status, "rejected");
  } finally {
    service.close();
    await s.cleanup();
  }
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
for (const phase of ["preflight", "dispatch"] as const)
  test(`BLOCK7: stale reconcile cannot overwrite lifecycle during ${phase}, two connections`, async () => {
    const s = await setup();
    const writeGate = gate(),
      entered = gate(),
      readGate = gate(),
      readEntered = gate();
    const writer = createPrMergeService({
      ...s.options,
      token: async () => {
        if (phase === "preflight") {
          entered.release();
          await writeGate.promise;
        }
        return "secret";
      },
      fetch: async (input, init) => {
        if (phase === "dispatch" && init?.method === "PUT") {
          entered.release();
          await writeGate.promise;
        }
        return s.fetcher(input, init);
      },
    });
    const reader = createPrMergeService({
      ...s.options,
      token: async () => {
        readEntered.release();
        await readGate.promise;
        return "secret";
      },
    });
    try {
      const input = intent();
      const merge = writer.merge(input);
      await entered.promise;
      const reconciliation = reader.reconcileMerge(input);
      await readEntered.promise;
      writeGate.release();
      assert.equal((await merge).status, "succeeded");
      readGate.release();
      const result = await reconciliation;
      assert.equal(result.status, "succeeded");
      assert.equal(result.dispatched, true);
      writer.close();
      assert.equal((await s.service.merge(input)).status, "succeeded");
      assert.equal(s.state.writes, 1);
    } finally {
      writeGate.release();
      readGate.release();
      writer.close();
      reader.close();
      await s.cleanup();
    }
  });
test("BLOCK7: effective rules include inherited ruleset-only reviews and checks", async () => {
  const f = fixture();
  f.state.rules = [
    {
      type: "pull_request",
      ruleset_source_type: "Organization",
      parameters: {
        required_approving_review_count: 2,
        require_code_owner_review: true,
        required_review_thread_resolution: true,
      },
    },
    {
      type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "test", integration_id: 1 }] },
    },
  ];
  const detail = await createPrDetailClient({ fetch: f.fetcher, token: async () => "secret" }).get(
    url,
  );
  assert.equal(detail.mergeCapabilities.status, "available");
  if (detail.mergeCapabilities.status !== "available") return;
  const requirements = detail.mergeCapabilities.data.branchRequirements;
  assert.equal(requirements.status, "available");
  if (requirements.status === "available") {
    assert.equal(requirements.complete, true);
    assert.equal(requirements.data?.requiredApprovingReviewCount, 2);
    assert.equal(requirements.data?.requiresCodeOwnerReviews, true);
    assert.deepEqual(requirements.data?.requiredStatusCheckContexts, ["test"]);
  }
});
test("BLOCK7: inaccessible effective rules never mean classic-null complete-clear; admin independent", async () => {
  const f = fixture();
  f.state.rulesDenied = true;
  const detail = await createPrDetailClient({ fetch: f.fetcher, token: async () => "secret" }).get(
    url,
  );
  if (detail.mergeCapabilities.status !== "available")
    assert.fail("other capabilities should remain readable");
  const c = detail.mergeCapabilities.data;
  assert.equal(c.branchRequirements.status, "available");
  if (c.branchRequirements.status === "available")
    assert.equal(c.branchRequirements.complete, false);
  assert.equal(
    c.actions.find((a) => a.action.kind === "merge")?.reasonCode,
    "requirements-unknown",
  );
  assert.equal(c.actions.find((a) => a.action.kind === "admin-merge")?.enabled, true);
});
for (const mergeState of ["HAS_HOOKS", "UNSTABLE"])
  test(`BLOCK7: ${mergeState} allows ordinary merge with verified requirements despite nonrequired failure`, async () => {
    const f = fixture();
    f.state.mergeState = mergeState;
    f.state.checkConclusion = "FAILURE";
    const detail = await createPrDetailClient({
      fetch: f.fetcher,
      token: async () => "secret",
    }).get(url);
    if (detail.mergeCapabilities.status !== "available") assert.fail("capabilities missing");
    assert.equal(
      detail.mergeCapabilities.data.actions.find((a) => a.action.kind === "merge")?.enabled,
      true,
    );
  });
for (const mode of ["failed", "pending", "unknown"] as const)
  test(`BLOCK7: required check ${mode} disables affected actions with reason`, async () => {
    const f = fixture();
    f.state.rules = [
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [
            { context: mode === "unknown" ? "missing" : "test", integration_id: 1 },
          ],
        },
      },
    ];
    if (mode === "failed") f.state.checkConclusion = "FAILURE";
    if (mode === "pending") {
      f.state.checkStatus = "IN_PROGRESS";
      f.state.checkConclusion = null;
    }
    const detail = await createPrDetailClient({
      fetch: f.fetcher,
      token: async () => "secret",
    }).get(url);
    if (detail.mergeCapabilities.status !== "available") assert.fail("capabilities missing");
    const action = detail.mergeCapabilities.data.actions.find((a) => a.action.kind === "merge");
    assert.equal(action?.enabled, false);
    assert.equal(action?.reasonCode, `required-checks-${mode}`);
  });
for (const state of ["BLOCKED", "UNKNOWN"])
  test(`BLOCK7: enqueue ${state} with null review is not enabled`, async () => {
    const f = fixture();
    f.state.queue = true;
    f.state.mergeState = state;
    f.state.reviewDecision = null;
    const detail = await createPrDetailClient({
      fetch: f.fetcher,
      token: async () => "secret",
    }).get(url);
    if (detail.mergeCapabilities.status !== "available") assert.fail("capabilities missing");
    assert.equal(
      detail.mergeCapabilities.data.actions.find((a) => a.action.kind === "enqueue")?.enabled,
      false,
    );
  });
test("BLOCK7: push during checks invalidates correlated sections and merge actions", async () => {
  const f = fixture();
  const fetcher: typeof fetch = async (input, init) => {
    const result = await f.fetcher(input, init);
    if (String(init?.body).includes("statusCheckRollup")) f.state.head = "c".repeat(40);
    return result;
  };
  const detail = await createPrDetailClient({ fetch: fetcher, token: async () => "secret" }).get(
    url,
  );
  assert.equal(detail.checks.status, "unavailable");
  assert.equal(detail.mergeCapabilities.status, "unavailable");
});
for (const status of [401, 403, 409, 412, 422, 500, 502])
  test(`BLOCK7: HTTP ${status} has sanitized definitive/uncertain outcome without replay`, async () => {
    const s = await setup();
    let writes = 0;
    const service = createPrMergeService({
      ...s.options,
      fetch: async (input, init) => {
        if (init?.method === "PUT") {
          writes++;
          return Response.json({ message: "SECRET raw server text" }, { status });
        }
        return s.fetcher(input, init);
      },
    });
    try {
      const input = intent();
      const result = await service.merge(input);
      assert.equal(result.status, status < 500 ? "rejected" : "uncertain");
      assert.ok(!result.message.includes("SECRET"));
      await service.merge(input);
      assert.equal(writes, 1);
    } finally {
      service.close();
      await s.cleanup();
    }
  });
test("BLOCK7: admin zero with queued/merged race records observation, never attribution", async () => {
  for (const queued of [true, false]) {
    const s = await setup();
    const service = createPrMergeService({
      ...s.options,
      admin: async () => {
        s.state.queued = queued;
        s.state.merged = !queued;
        s.state.head = "c".repeat(40);
      },
    });
    try {
      const result = await service.merge(intent({ kind: "admin-merge", method: "merge" }));
      assert.equal(result.status, "uncertain");
      assert.equal(result.observed?.state, queued ? "OPEN" : "MERGED");
      assert.equal(result.observed?.headSha, "c".repeat(40));
    } finally {
      service.close();
      await s.cleanup();
    }
  }
});

test("BLOCK7: future journal schema fails closed without migrating it", async () => {
  const s = await setup();
  const db = new DatabaseSync(s.options.databasePath);
  db.exec("PRAGMA user_version=99");
  db.close();
  try {
    const result = await s.service.merge(intent());
    assert.equal(result.status, "rejected");
    assert.equal(s.state.writes, 0);
    const inspect = new DatabaseSync(s.options.databasePath);
    assert.equal(inspect.prepare("PRAGMA user_version").get()?.user_version, 99);
    inspect.close();
  } finally {
    await s.cleanup();
  }
});
test("BLOCK7: corrupt journal attempt is never recovered through an unchecked cast or dispatched", async () => {
  const s = await setup();
  const input = intent();
  try {
    await s.service.merge(input);
    s.service.close();
    const db = new DatabaseSync(s.options.databasePath);
    db.prepare("UPDATE merge_attempts SET data=? WHERE request_id=?").run(
      '{"status":"succeeded","dispatched":false}',
      input.requestId,
    );
    db.close();
    await assert.rejects(s.service.merge(input), /Invalid merge journal/);
    await assert.rejects(s.service.reconcileMerge(input), /Invalid merge journal/);
    assert.equal(s.state.writes, 1);
  } finally {
    await s.cleanup();
  }
});
for (const malformed of [true, false])
  test(`BLOCK7: ${malformed ? "malformed" : "oversized"} success body is uncertain, never resent`, async () => {
    const s = await setup();
    let writes = 0;
    const service = createPrMergeService({
      ...s.options,
      maxResponseBytes: 4096,
      fetch: async (input, init) => {
        if (init?.method === "PUT") {
          writes++;
          return new Response(malformed ? "not-json" : "x".repeat(5000));
        }
        return s.fetcher(input, init);
      },
    });
    try {
      const input = intent();
      assert.equal((await service.merge(input)).status, "uncertain");
      await service.merge(input);
      assert.equal(writes, 1);
    } finally {
      service.close();
      await s.cleanup();
    }
  });
test("BLOCK7: stuck response body times out uncertain", async () => {
  const s = await setup();
  const service = createPrMergeService({
    ...s.options,
    timeoutMs: 10,
    fetch: async (input, init) =>
      init?.method === "PUT"
        ? new Response(new ReadableStream({ start() {} }))
        : s.fetcher(input, init),
  });
  try {
    assert.equal((await service.merge(intent())).status, "uncertain");
  } finally {
    service.close();
    await s.cleanup();
  }
});
test("BLOCK7: linear-history rules restrict merge commits but keep squash available", async () => {
  const f = fixture();
  f.state.rules = [{ type: "required_linear_history" }];
  const detail = await createPrDetailClient({ fetch: f.fetcher, token: async () => "secret" }).get(
    url,
  );
  if (detail.mergeCapabilities.status !== "available") assert.fail("capabilities missing");
  const actions = detail.mergeCapabilities.data.actions;
  assert.equal(
    actions.find(
      (a) => a.action.kind === "merge" && "method" in a.action && a.action.method === "merge",
    )?.reasonCode,
    "method-restricted",
  );
  assert.equal(
    actions.find(
      (a) => a.action.kind === "merge" && "method" in a.action && a.action.method === "squash",
    )?.enabled,
    true,
  );
});

test("BLOCK7: base drift after paginated checks invalidates affected evidence", async () => {
  const f = fixture();
  f.state.paginate = true;
  const fetcher: typeof fetch = async (input, init) => {
    const response = await f.fetcher(input, init);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (body?.query?.includes("statusCheckRollup") && body.variables.cursor)
      f.state.baseSha = "d".repeat(40);
    return response;
  };
  const detail = await createPrDetailClient({ fetch: fetcher, token: async () => "secret" }).get(
    url,
  );
  assert.equal(detail.checks.status, "unavailable");
  assert.equal(detail.mergeCapabilities.status, "unavailable");
});
test("BLOCK7: capabilities sampled at another head never mix with old metadata/checks", async () => {
  const f = fixture();
  const fetcher: typeof fetch = async (input, init) => {
    const response = await f.fetcher(input, init);
    if (String(init?.body).includes("mergeCommitAllowed")) {
      const body = await response.json();
      body.data.repository.pullRequest.headRefOid = "c".repeat(40);
      return Response.json(body);
    }
    return response;
  };
  const detail = await createPrDetailClient({ fetch: fetcher, token: async () => "secret" }).get(
    url,
  );
  assert.equal(detail.checks.status, "unavailable");
  assert.equal(detail.mergeCapabilities.status, "unavailable");
});

test("nullable disabled classic requirements keep CLEAN ordinary merge methods enabled", async () => {
  const f = fixture();
  f.state.classic = {
    requiredStatusCheckContexts: null,
    requiredStatusChecks: null,
    requiredApprovingReviewCount: null,
    requiresStatusChecks: false,
    requiresApprovingReviews: false,
    requiresCodeOwnerReviews: false,
    requiresConversationResolution: false,
    requiresLinearHistory: false,
  };
  const fetcher: typeof fetch = async (input, init) => {
    const query = init?.body ? (JSON.parse(String(init.body)).query ?? "") : "";
    if (query.includes("branchProtectionRule")) assert.ok(query.includes("requiresStatusChecks"));
    return f.fetcher(input, init);
  };
  const detail = await createPrDetailClient({ fetch: fetcher, token: async () => "secret" }).get(
    url,
  );
  if (detail.mergeCapabilities.status !== "available") assert.fail("capabilities unavailable");
  const ordinary = detail.mergeCapabilities.data.actions.filter((a) => a.action.kind === "merge");
  assert.equal(ordinary.length, 3);
  assert.ok(ordinary.every((a) => a.enabled));
});

for (const enabled of ["requiresApprovingReviews", "requiresStatusChecks"] as const)
  test(`nullable enabled ${enabled} remains incomplete and never enables ordinary merge`, async () => {
    const f = fixture();
    f.state.classic = {
      requiredStatusCheckContexts: null,
      requiredStatusChecks: null,
      requiredApprovingReviewCount: null,
      requiresStatusChecks: false,
      requiresApprovingReviews: false,
      requiresCodeOwnerReviews: false,
      requiresConversationResolution: false,
      requiresLinearHistory: false,
      [enabled]: true,
    };
    const detail = await createPrDetailClient({
      fetch: f.fetcher,
      token: async () => "secret",
    }).get(url);
    if (detail.mergeCapabilities.status !== "available") assert.fail("capabilities unavailable");
    const requirements = detail.mergeCapabilities.data.branchRequirements;
    assert.equal(requirements.status, "available");
    if (requirements.status === "available") assert.equal(requirements.complete, false);
    assert.ok(
      detail.mergeCapabilities.data.actions
        .filter((a) => a.action.kind === "merge")
        .every((a) => !a.enabled && a.reasonCode === "requirements-unknown"),
    );
  });
