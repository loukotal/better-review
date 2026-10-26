import assert from "node:assert/strict";
import test from "node:test";

import type { GithubWriteAction, PrDetail, PrStatus } from "@better-review/shared";

import { prDetailFixture } from "../browser-tests/pr-detail-fixture";
import { createGithubConfirmationState } from "./github-confirmation-state";
import type { BrowserGithubOperation } from "./github-outbox";
import type { GithubReadToken } from "./github-outbox-projection";
import { githubPrScope } from "./github-pr-scope";

const url = "https://github.com/browser-fixture/isolated/pull/1";
const scope = githubPrScope(url);
const head = "a".repeat(40);
const actor = { id: 42, login: "browser-fixture" };
function operation(
  id = "canonical",
  action: GithubWriteAction = { kind: "approve", expectedHeadSha: head, body: "" },
): BrowserGithubOperation {
  return {
    command: { operationId: id, scope, expectedActor: actor, action, dependencies: [] },
    backendOwned: false,
    status: "local-pending",
  };
}
function synced(item: BrowserGithubOperation): BrowserGithubOperation {
  const action = item.command.action;
  return {
    ...item,
    status: "synced",
    backendOwned: true,
    operation: {
      command: item.command,
      status: "synced",
      revision: 3,
      sequence: 1,
      attempts: 1,
      retryMode: "automatic",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      result:
        action.kind === "set-draft"
          ? { kind: "pull-request-draft", nodeId: action.pullRequestId, url, draft: action.draft }
          : { kind: "approval", id: 10, url, commitSha: head },
    },
  };
}
function detail(approved = false): PrDetail {
  const value = prDetailFixture(url);
  value.stageCapabilities = {
    status: "available",
    complete: true,
    data: { canSetDraft: true, reason: null },
  };
  value.reviewRequests = { status: "available", complete: true, data: [] };
  if (approved)
    value.reviews = {
      status: "available",
      complete: true,
      data: [
        {
          id: "review",
          author: actor.login,
          state: "APPROVED",
          body: "",
          commitSha: head,
          submittedAt: "2026-01-01T00:00:00Z",
          url: `${url}#pullrequestreview-10`,
        },
      ],
    };
  return value;
}
function status(approved = false): PrStatus {
  return {
    state: "open",
    draft: false,
    mergeable: true,
    title: "PR",
    body: "",
    author: "other",
    url,
    headRef: "branch",
    checks: [],
    reviewContext: { actor, headSha: head },
    viewerApproval: approved ? { login: actor.login, commitSha: head } : null,
  };
}
function fixture() {
  const owner = createGithubConfirmationState();
  let serial = 0;
  let operations: BrowserGithubOperation[] = [];
  const read = (identity = actor) =>
    owner.captureRead(
      {
        scope,
        serial: ++serial,
        confirmed: new Map(
          operations
            .filter((item) => item.status === "synced" && item.operation)
            .map((item) => [item.command.operationId, item.operation!.revision]),
        ),
      },
      identity,
      operations,
    );
  return {
    owner,
    read,
    observe(next: BrowserGithubOperation[]) {
      operations = next;
      owner.observe(next);
    },
    approval(input: Partial<Parameters<typeof owner.approval>[0]> = {}) {
      return owner.approval({ url, head, actor, status: null, operations, ...input });
    },
    draft(value = detail(), input: Partial<Parameters<typeof owner.draft>[0]> = {}) {
      return owner.draft({ url, detail: value, actor, operations, ...input });
    },
  };
}

test("one approval selection supplies both operations and presentation for each PR/head/account", () => {
  const f = fixture(),
    pending = operation();
  const cancelled = { ...operation("cancelled"), status: "cancelled" as const };
  const otherHead = operation("other-head", {
    kind: "approve",
    expectedHeadSha: "b".repeat(40),
    body: "",
  });
  const otherActor = {
    ...operation("other-actor"),
    command: {
      ...pending.command,
      operationId: "other-actor",
      expectedActor: { ...actor, id: 99 },
    },
  };
  const otherPr = {
    ...operation("other-pr"),
    command: { ...pending.command, scope: githubPrScope(url.replace(/1$/, "2")) },
  };
  f.observe([pending, cancelled, otherHead, otherActor, otherPr]);
  assert.deepEqual(f.approval(), { operations: [pending], state: "pending" });
  assert.deepEqual(f.approval({ head: undefined }).operations, []);
  assert.deepEqual(f.approval({ actor: undefined }).operations, []);
  assert.deepEqual(f.approval({ head: "b".repeat(40) }), {
    operations: [otherHead],
    state: "pending",
  });
});

test("a read finishing after confirmation cannot retire a receipt unless it started after acknowledgement", () => {
  const f = fixture(),
    pending = operation();
  f.observe([pending]);
  const early = f.read();
  f.observe([synced(pending)]);
  f.owner.acceptDetail(early, detail());
  assert.equal(f.approval().state, "synced");
  f.owner.acceptDetail(f.read(), detail());
  assert.equal(f.approval().state, undefined);
});

test("canonical reuse requires coverage of the newly acknowledged alias even after the canonical bridge retired", () => {
  const f = fixture(),
    canonical = operation("B");
  f.observe([canonical]);
  const receipt = synced(canonical);
  f.observe([receipt]);
  f.owner.acceptDetail(f.read(), detail());
  assert.equal(f.approval().state, undefined);
  const beforeIntent = f.read();
  f.observe([receipt, operation("A")]);
  const duringPending = f.read();
  assert.equal(duringPending.approvalBridges?.get("B")?.has("A"), false);
  const acknowledged = { ...receipt, submittedOperationIds: ["A"] };
  f.observe([acknowledged]);
  assert.equal(f.approval().state, "synced");
  f.owner.acceptDetail(beforeIntent, detail());
  f.owner.acceptDetail(duringPending, detail());
  assert.equal(f.approval().state, "synced");
  const covering = f.read();
  assert.deepEqual([...covering.approvalBridges!.get("B")!].sort(), ["A", "B"]);
  f.owner.acceptDetail(covering, detail());
  assert.equal(f.approval().state, undefined);
  for (let revision = 4; revision < 7; revision++) {
    f.observe([{ ...acknowledged, operation: { ...acknowledged.operation!, revision } }]);
    assert.equal(
      f.approval().state,
      undefined,
      "poll/result revisions are not new intent generations",
    );
  }
});

test("read-start coverage and numeric identity are snapshots, not caller-owned mutable metadata", () => {
  const f = fixture(),
    pending = operation();
  f.observe([pending]);
  f.observe([synced(pending)]);
  const identity = { ...actor },
    token = f.read(identity);
  identity.id = 99;
  (token.approvalBridges as Map<string, Set<string>>).clear();
  token.approvalActor!.id = 99;
  f.owner.acceptDetail(token, detail());
  assert.equal(f.approval().state, undefined);
});

for (const mismatch of [
  "PR",
  "head",
  "numeric actor",
  "login",
  "reviews",
  "metadata",
  "actor",
] as const) {
  test(`approval bridge ignores mismatched/incomplete ${mismatch} detail evidence`, () => {
    const f = fixture(),
      pending = operation();
    f.observe([pending]);
    f.observe([synced(pending)]);
    const value = detail();
    if (mismatch === "PR") value.url = url.replace(/1$/, "2");
    if (mismatch === "head" && value.metadata.status === "available")
      value.metadata.data.head.sha = "b".repeat(40);
    if (mismatch === "numeric actor" && value.actor.status === "available")
      value.actor.data.databaseId = 99;
    if (mismatch === "login" && value.actor.status === "available")
      value.actor.data.login = "other";
    if (mismatch === "reviews" && value.reviews.status === "available")
      value.reviews.complete = false;
    if (mismatch === "metadata" && value.metadata.status === "available")
      value.metadata.complete = false;
    if (mismatch === "actor" && value.actor.status === "available") value.actor.complete = false;
    f.owner.acceptDetail(f.read(), value);
    assert.equal(f.approval().state, "synced");
  });
}

test("verified extras evidence has independent serial ordering and competes with detail by read start", () => {
  const f = fixture(),
    pending = operation();
  f.observe([pending]);
  f.observe([synced(pending)]);
  const olderDetail = f.read(),
    newerExtras = f.read();
  f.owner.acceptStatus(newerExtras, status(true));
  f.owner.acceptDetail(olderDetail, detail());
  assert.equal(
    f.approval().state,
    "synced",
    "newer positive extras win despite later detail completion",
  );
  f.owner.acceptDetail(f.read(), detail());
  assert.equal(f.approval().state, undefined);
  f.owner.acceptStatus(newerExtras, status(true));
  assert.equal(f.approval().state, undefined, "older extras cannot resurrect over newer detail");
  const fresh = f.read();
  f.owner.acceptStatus(fresh, status());
  f.owner.acceptStatus(newerExtras, status(true));
  assert.equal(
    f.approval().state,
    undefined,
    "old same-resource response cannot replace fresh negative",
  );
});

test("unverified/cached extras cannot retire a bridge; fresh same-context absence can", () => {
  const f = fixture(),
    pending = operation();
  f.observe([pending]);
  f.observe([synced(pending)]);
  const cached: GithubReadToken = { scope, serial: 100, confirmed: new Map([["canonical", 3]]) };
  f.owner.acceptStatus(cached, status());
  f.owner.acceptDetail(cached, detail());
  assert.equal(f.approval().state, "synced");
  for (const value of [
    { ...status(), reviewContext: undefined },
    { ...status(), url: url.replace(/1$/, "2") },
    { ...status(), reviewContext: { actor: { ...actor, id: 99 }, headSha: head } },
    { ...status(), reviewContext: { actor, headSha: "b".repeat(40) } },
  ]) {
    f.owner.acceptStatus(f.read(), value);
    assert.equal(f.approval().state, "synced");
  }
  f.owner.acceptStatus(f.read(), status());
  assert.equal(f.approval().state, undefined);
});

for (const evidence of [
  "renewed user",
  "team",
  "incomplete requests",
  "unknown requests",
  "later comment",
  "tied comment",
  "dismissal",
] as const) {
  test(`complete current detail does not resurrect approval from ${evidence}`, () => {
    const f = fixture(),
      pending = operation();
    f.observe([pending]);
    f.observe([synced(pending)]);
    const value = detail(true);
    if (evidence === "renewed user")
      value.reviewRequests = {
        status: "available",
        complete: true,
        data: [{ kind: "user", name: actor.login }],
      };
    if (evidence === "team")
      value.reviewRequests = {
        status: "available",
        complete: true,
        data: [{ kind: "team", name: "unknown-membership" }],
      };
    if (evidence === "incomplete requests")
      value.reviewRequests = { status: "available", complete: false, data: [] };
    if (evidence === "unknown requests")
      value.reviewRequests = { status: "unavailable", message: "Unknown" };
    if (value.reviews.status === "available") {
      if (evidence === "dismissal") value.reviews.data[0]!.state = "DISMISSED";
      if (evidence === "later comment" || evidence === "tied comment")
        value.reviews.data.push({
          ...value.reviews.data[0]!,
          id: "commented",
          state: "COMMENTED",
          submittedAt:
            evidence === "tied comment" ? "2026-01-01T00:00:00Z" : "2026-01-02T00:00:00Z",
        });
    }
    f.owner.acceptDetail(f.read(), value);
    assert.equal(f.approval({ status: status(true) }).state, undefined);
  });
}

test("first-seen synced approval and stage history never acquire receipt authority", () => {
  const f = fixture();
  f.observe([
    synced(operation()),
    synced(operation("stage", { kind: "set-draft", pullRequestId: "PR_fixture", draft: true })),
  ]);
  assert.equal(f.approval().state, undefined);
  assert.equal(f.draft().confirmed, undefined);
  assert.equal(f.draft().allowed, true);
});

test("stage receipts require matching fresh evidence, survive structural sharing, and stay retired across metadata revisions", () => {
  const f = fixture(),
    pending = operation("stage", { kind: "set-draft", pullRequestId: "PR_fixture", draft: true });
  f.observe([pending]);
  const early = f.read();
  const receipt = synced(pending);
  f.observe([receipt]);
  f.owner.acceptDetail(early, detail());
  assert.equal(f.draft().confirmed?.draft, true);
  const fresh = detail();
  if (fresh.metadata.status === "available") fresh.metadata.data.draft = true;
  f.owner.acceptDetail(f.read(), fresh);
  const changed = structuredClone(fresh);
  changed.fetchedAt = "2026-01-02";
  assert.equal(
    f.draft(changed).confirmed?.draft,
    true,
    "another cached snapshot cannot retire receipt",
  );
  assert.equal(
    f.draft(structuredClone(fresh)).confirmed,
    undefined,
    "structural sharing must not require object identity",
  );
  assert.deepEqual(
    f.draft(structuredClone(fresh)).action,
    {
      kind: "set-draft",
      pullRequestId: "PR_fixture",
      draft: false,
    },
    "fresh verified state, not the receipt or retained display, determines reversal",
  );
  f.observe([{ ...receipt, operation: { ...receipt.operation!, revision: 4 } }]);
  changed.stageCapabilities = { status: "unavailable", message: "Offline" };
  assert.equal(
    f.draft(changed).confirmed,
    undefined,
    "retired generation cannot resurrect after permissions disappear",
  );
  assert.equal(f.draft(changed).allowed, false);
});

test("stage incomplete refresh retains receipt; complete fresh permission denial retires it without enabling reversal", () => {
  const f = fixture(),
    pending = operation("stage", { kind: "set-draft", pullRequestId: "PR_fixture", draft: false });
  f.observe([pending]);
  f.observe([synced(pending)]);
  const incomplete = detail();
  incomplete.stageCapabilities = {
    status: "available",
    complete: false,
    data: { canSetDraft: true, reason: null },
  };
  f.owner.acceptDetail(f.read(), incomplete);
  assert.equal(f.draft(incomplete).confirmed?.draft, false);
  assert.equal(f.draft(incomplete).allowed, false);
  const fresh = detail();
  fresh.stageCapabilities = {
    status: "available",
    complete: true,
    data: { canSetDraft: false, reason: "Denied" },
  };
  f.owner.acceptDetail(f.read(), fresh);
  assert.equal(f.draft(fresh).confirmed, undefined);
  assert.equal(f.draft(fresh).allowed, false);
});

test("draft selection excludes archived pending work and freezes PR identity/desired state separately from approval policy", () => {
  const f = fixture(),
    pending = operation("stage", { kind: "set-draft", pullRequestId: "PR_fixture", draft: true });
  const archived = synced(pending);
  archived.status = "uncertain";
  archived.operation = { ...archived.operation!, status: "uncertain", archivedAt: "2026-01-01" };
  f.observe([archived]);
  const value = detail();
  const selected = f.draft(value);
  assert.deepEqual(selected.pending, []);
  assert.deepEqual(selected.action, {
    kind: "set-draft",
    pullRequestId: "PR_fixture",
    draft: true,
  });
  if (value.metadata.status === "available") {
    value.metadata.data.id = "PR_new";
    value.metadata.data.draft = true;
  }
  assert.deepEqual(selected.action, {
    kind: "set-draft",
    pullRequestId: "PR_fixture",
    draft: true,
  });
  assert.deepEqual(f.draft(value).action, {
    kind: "set-draft",
    pullRequestId: "PR_new",
    draft: false,
  });
  assert.equal(f.draft(value, { actor: { ...actor, id: 99 } }).allowed, false);
  assert.equal(f.draft(value, { url: url.replace(/1$/, "2") }).allowed, false);
  if (value.metadata.status === "available") value.metadata.data.state = "CLOSED";
  assert.equal(f.draft(value).allowed, false);
  assert.equal(f.draft(value).action, undefined);
});

test("stage canonical aliases require a new covering read and old responses cannot resurrect a retired generation", () => {
  const f = fixture();
  const pending = operation("B", { kind: "set-draft", pullRequestId: "PR_fixture", draft: true });
  f.observe([pending]);
  const receipt = synced(pending);
  f.observe([receipt]);
  const value = detail();
  f.owner.acceptDetail(f.read(), value);
  assert.equal(f.draft(value).confirmed, undefined);
  f.observe([receipt, operation("A", pending.command.action)]);
  const preAcknowledgement = f.read();
  f.observe([{ ...receipt, submittedOperationIds: ["A"] }]);
  f.owner.acceptDetail(preAcknowledgement, value);
  assert.equal(f.draft(value).confirmed?.draft, true);
  f.owner.acceptDetail(f.read(), structuredClone(value));
  assert.equal(f.draft(value).confirmed, undefined);
  f.owner.acceptDetail(preAcknowledgement, { ...value, fetchedAt: "2026-01-02" });
  assert.equal(f.draft(value).confirmed, undefined);
});

test("draft eligibility requires complete current metadata, actor and stage capability, never retained display authority", () => {
  const f = fixture();
  const value = detail();
  assert.equal(f.draft(value).allowed, true);
  const variants = [
    structuredClone(value),
    structuredClone(value),
    structuredClone(value),
    structuredClone(value),
    structuredClone(value),
  ];
  variants[0]!.metadata = { status: "unavailable", message: "Offline" };
  if (variants[1]!.metadata.status === "available") variants[1]!.metadata.complete = false;
  if (variants[2]!.actor.status === "available") variants[2]!.actor.complete = false;
  delete variants[3]!.stageCapabilities;
  if (variants[4]!.metadata.status === "available")
    variants[4]!.metadata.data.url = url.replace(/1$/, "2");
  for (const incomplete of variants) {
    assert.equal(f.draft(incomplete).allowed, false);
    assert.equal(f.draft(incomplete).action, undefined);
  }
});
