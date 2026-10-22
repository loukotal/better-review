import assert from "node:assert/strict";
import { test } from "node:test";

import type { IssueComment, PRComment, PrDetail, PrStatus } from "@better-review/shared";

import { prDetailFixture } from "../browser-tests/pr-detail-fixture";
import { createPrReadState, type PrReadQueryAdapter } from "./pr-read-state";
import type { PrExtrasData } from "./query";

const a = "https://github.com/owner/repo/pull/1";
const b = "https://github.com/owner/repo/pull/2";
function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const extras = (): PrExtrasData => ({ comments: [], issueComments: [], status: null });
const comment = (id = 1): PRComment => ({
  id,
  node_id: `comment-${id}`,
  path: "src/file.ts",
  line: 1,
  original_line: 1,
  side: "RIGHT",
  body: `Review ${id}`,
  html_url: `${a}#discussion_r${id}`,
  user: { login: "viewer", avatar_url: "" },
  created_at: "2026-01-01T00:00:00Z",
  canEdit: true,
});
const issueComment = (id = 1): IssueComment => ({
  ...comment(id),
  updated_at: "2026-01-01T00:00:00Z",
});
const status = (url = a): PrStatus => ({
  url,
  state: "open",
  draft: false,
  mergeable: true,
  title: "PR title",
  body: "Description",
  author: "author",
  headRef: "feature",
  checks: [],
});

function fixture() {
  let requested: string | undefined = a;
  const details = new Map<string, PrDetail>();
  const extraCache = new Map<string, PrExtrasData>();
  const calls: { kind: string; url?: string; afterWrite?: boolean }[] = [];
  const detailReads: ReturnType<typeof gate<PrDetail>>[] = [];
  const extraReads: ReturnType<typeof gate<PrExtrasData>>[] = [];
  const detailRefreshes: ReturnType<typeof gate<PrDetail>>[] = [];
  const extraRefreshes: ReturnType<typeof gate<PrExtrasData>>[] = [];
  const listeners = new Set<Parameters<PrReadQueryAdapter["subscribe"]>[0]>();
  const query: PrReadQueryAdapter = {
    cachedDetail: (url) => details.get(url),
    cachedExtras: (url) => extraCache.get(url),
    fetchDetail(url) {
      calls.push({ kind: "detail", url });
      const read = gate<PrDetail>();
      detailReads.push(read);
      return read.promise;
    },
    fetchExtras(url) {
      calls.push({ kind: "extras", url });
      const read = gate<PrExtrasData>();
      extraReads.push(read);
      return read.promise;
    },
    refreshDetail(url, options) {
      calls.push({ kind: "refresh-detail", url, ...options });
      const read = gate<PrDetail>();
      detailRefreshes.push(read);
      return read.promise;
    },
    refreshExtras(url) {
      calls.push({ kind: "refresh-extras", url });
      const read = gate<PrExtrasData>();
      extraRefreshes.push(read);
      return read.promise;
    },
    async refreshList() {
      calls.push({ kind: "refresh-list" });
    },
    async cancelOtherPrQueries(url) {
      calls.push({ kind: "cancel-other", url });
    },
    async cancelPrQueries(url) {
      calls.push({ kind: "cancel", url });
    },
    async invalidatePrQueries(url) {
      calls.push({ kind: "invalidate", url });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const owner = createPrReadState({ query, requestedUrl: () => requested });
  const emit = (url: string, resource: "detail" | "extras") => {
    for (const listener of listeners) listener({ url, resource });
  };
  return {
    owner,
    query,
    calls,
    details,
    extraCache,
    detailReads,
    extraReads,
    detailRefreshes,
    extraRefreshes,
    listeners,
    emit,
    requested: (url: string | undefined) => {
      requested = url;
    },
  };
}

test("PR reads: synchronous cached initialization and exactly two independent initial fetches", async (t) => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  const detail = prDetailFixture(a);
  const cached = {
    comments: [comment()],
    issueComments: [issueComment()],
    status: status(),
    reviewThreads: { status: "available" as const, complete: true, data: [] },
  };
  f.details.set(a, detail);
  f.extraCache.set(a, cached);
  assert.deepEqual(f.calls, [], "construction does not fetch");
  f.owner.select(a);
  assert.equal(f.owner.getState().detail, detail);
  assert.equal(f.owner.getState().displayDetail, detail);
  assert.equal(f.owner.getState().mergeDetail, detail);
  assert.equal(f.owner.getState().comments, cached.comments);
  assert.equal(f.owner.getState().loadingStatus, false);
  assert.equal(f.owner.getState().loadingComments, false);
  assert.deepEqual(f.calls, [
    { kind: "cancel-other", url: a },
    { kind: "detail", url: a },
    { kind: "extras", url: a },
  ]);
  f.extraReads[0].resolve({ comments: [], issueComments: [], status: null });
  await flush();
  assert.deepEqual(f.owner.getState().comments, []);
  assert.equal(f.owner.getState().detail, detail, "extras do not await or erase detail");
  assert.equal(f.owner.getState().status, cached.status, "null status retains cached data");
  const fresh = prDetailFixture(a, "c".repeat(40));
  f.detailReads[0].resolve(fresh);
  await flush();
  assert.equal(f.owner.getState().detail, fresh);
  assert.equal(f.calls.length, 3);
});

test("PR reads: A-to-B navigation fences late A data, errors and loading cleanup", async (t) => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  t.mock.method(console, "error", () => {});
  f.owner.select(a);
  f.requested(b);
  f.owner.select(b);
  f.detailReads[0].resolve(prDetailFixture(a));
  f.extraReads[0].reject(new Error("Late A failure"));
  await flush();
  assert.equal(f.owner.getState().url, b);
  assert.equal(f.owner.getState().detail, undefined);
  assert.equal(f.owner.getState().commentsUnavailable, false);
  assert.equal(f.owner.getState().loadingComments, true);
  f.detailReads[1].reject(new Error("B detail unavailable"));
  f.extraReads[1].resolve(extras());
  await flush();
  assert.equal(f.owner.getState().detailError, "B detail unavailable");
  assert.equal(f.owner.getState().loadingComments, false);
  assert.equal(f.owner.getState().loadingStatus, false);
});

test("PR reads: same-PR reselection reloads, resets retained display, and fences old epochs", async (t) => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  f.owner.select(a);
  const cached = prDetailFixture(a, "c".repeat(40));
  f.details.set(a, cached);
  f.owner.select(a);
  assert.equal(f.detailReads.length, 2);
  assert.equal(f.extraReads.length, 2);
  assert.equal(f.owner.getState().displayDetail, cached);
  f.detailReads[0].reject(new Error("Old same-PR read"));
  f.extraReads[0].resolve({
    comments: [comment()],
    issueComments: [issueComment()],
    status: status(),
  });
  await flush();
  assert.equal(f.owner.getState().detailError, undefined);
  assert.deepEqual(f.owner.getState().comments, []);
  assert.equal(f.owner.getState().loadingComments, true);
  f.detailReads[1].resolve(cached);
  f.extraReads[1].resolve(extras());
  await flush();
  assert.equal(f.owner.getState().loadingComments, false);
});

test("PR reads: editing requested URL does not select, fetch, or publish old reads/cache", async (t) => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  f.owner.select(a);
  const before = f.owner.getState();
  f.requested(b);
  f.detailReads[0].resolve(prDetailFixture(a));
  f.extraReads[0].resolve(extras());
  f.details.set(a, prDetailFixture(a));
  f.extraCache.set(a, extras());
  f.emit(a, "detail");
  f.emit(a, "extras");
  await flush();
  assert.equal(f.owner.getState(), before);
  assert.equal(f.owner.getState().url, a);
  assert.equal(f.calls.length, 3, "requested URL accessor is only a guard, not a fetch trigger");
});

test("PR reads: newer explicit detail refresh owns publication, error and loading state", async (t) => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  f.owner.select(a);
  const first = f.owner.refreshDetail();
  const second = f.owner.refreshDetail({ afterWrite: true });
  assert.equal(f.owner.getState().refreshingDetail, true);
  f.detailReads[0].reject(new Error("Obsolete initial read"));
  f.detailRefreshes[0].resolve(prDetailFixture(a));
  await first;
  await flush();
  assert.equal(f.owner.getState().detail, undefined);
  assert.equal(f.owner.getState().detailError, undefined);
  assert.equal(
    f.owner.getState().refreshingDetail,
    true,
    "older finally must not clear newer busy state",
  );
  f.detailRefreshes[1].reject(new Error("Current refresh failed"));
  await assert.rejects(second, /Current refresh failed/);
  assert.equal(f.owner.getState().detailError, "Current refresh failed");
  assert.equal(f.owner.getState().refreshingDetail, false);
  const third = f.owner.refreshDetail();
  const fresh = prDetailFixture(a);
  f.detailRefreshes[2].resolve(fresh);
  await third;
  assert.equal(f.owner.getState().detailError, undefined);
  assert.equal(f.owner.getState().detail, fresh);
  assert.equal(f.calls.filter((call) => call.kind === "refresh-detail")[1].afterWrite, true);
});

test("PR reads: obsolete explicit refresh rejects its caller without taking newer read's error/busy", async (t) => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  f.owner.select(a);
  const first = f.owner.refreshDetail();
  const failure = assert.rejects(first, /Old refresh failed/);
  const second = f.owner.refreshDetail();
  f.detailRefreshes[0].reject(new Error("Old refresh failed"));
  await failure;
  assert.equal(f.owner.getState().detailError, undefined);
  assert.equal(f.owner.getState().refreshingDetail, true);
  f.detailRefreshes[1].resolve(prDetailFixture(a));
  await second;
  assert.equal(f.owner.getState().refreshingDetail, false);
});

for (const changed of ["same", "head", "base"] as const) {
  test(`PR reads: unavailable sections retain only same head/base (${changed})`, async (t) => {
    const f = fixture();
    t.after(() => f.owner.dispose());
    const original = prDetailFixture(a);
    f.details.set(a, original);
    f.owner.select(a);
    const next = prDetailFixture(a, changed === "head" ? "c".repeat(40) : "a".repeat(40));
    if (changed === "base" && next.metadata.status === "available")
      next.metadata.data.base.sha = "c".repeat(40);
    next.checks = { status: "unavailable", message: "Checks unavailable" };
    next.labels = { status: "unavailable", message: "Labels unavailable" };
    next.reviews = { status: "unavailable", message: "Reviews unavailable" };
    next.reviewRequests = { status: "unavailable", message: "Review requests unavailable" };
    f.detailReads[0].resolve(next);
    await flush();
    const state = f.owner.getState();
    assert.equal(state.detail, next, "write authority is always the fresh response");
    assert.equal(state.mergeDetail, next);
    if (changed === "same") {
      for (const section of ["checks", "labels", "reviews", "reviewRequests"] as const)
        assert.equal(state.displayDetail?.[section], original[section]);
      assert.equal(
        state.staleNotice,
        "Checks unavailable · Labels unavailable · Reviews unavailable · Review requests unavailable",
      );
    } else {
      assert.equal(state.displayDetail, next);
      assert.equal(state.staleNotice, undefined);
    }
  });
}

test("PR reads: unavailable metadata retains display content but adopts fresh actor/capabilities, never write authority", async (t) => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  const original = prDetailFixture(a);
  f.details.set(a, original);
  f.owner.select(a);
  const next: PrDetail = {
    ...prDetailFixture(a),
    metadata: { status: "unavailable", message: "Metadata unavailable" },
    actor: { status: "unavailable", message: "Identity unavailable" },
    mergeCapabilities: { status: "unavailable", message: "Permissions unavailable" },
  };
  f.detailReads[0].resolve(next);
  await flush();
  const state = f.owner.getState();
  assert.equal(state.displayDetail?.metadata, original.metadata);
  assert.equal(state.displayDetail?.checks, original.checks);
  assert.equal(state.displayDetail?.actor, next.actor);
  assert.equal(state.displayDetail?.mergeCapabilities, next.mergeCapabilities);
  assert.equal(state.detail, next);
  assert.equal(state.mergeDetail, next);
  assert.equal(state.staleNotice, "Metadata unavailable");
});

test("PR reads: refresh failure retains content but removes fresh merge authority until successful cache publication", async (t) => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  const detail = prDetailFixture(a);
  f.details.set(a, detail);
  f.owner.select(a);
  const read = f.owner.refreshDetail();
  f.detailRefreshes[0].reject("Refresh unavailable");
  await assert.rejects(read);
  assert.equal(f.owner.getState().detail, detail);
  assert.equal(f.owner.getState().displayDetail, detail);
  assert.deepEqual(f.owner.getState().mergeDetail?.mergeCapabilities, {
    status: "unavailable",
    message: "Current merge permissions could not be refreshed. Refresh details before merging.",
  });
  const overlay = f.owner.getState().mergeDetail;
  f.extraCache.set(a, extras());
  f.emit(a, "extras");
  assert.equal(
    f.owner.getState().mergeDetail,
    overlay,
    "unrelated extras publication preserves overlay identity",
  );
  f.emit(b, "detail");
  assert.equal(f.owner.getState().detailError, "Refresh unavailable");
  f.emit(a, "detail");
  assert.equal(f.owner.getState().detailError, undefined);
  assert.equal(f.owner.getState().mergeDetail, detail);
});

test("PR reads: null extras retain prior data and set unavailable; empty arrays replace and thread omission clears", async (t) => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  const cached = {
    comments: [comment()],
    issueComments: [issueComment()],
    status: status(),
    reviewThreads: { status: "available" as const, complete: true, data: [] },
  };
  f.extraCache.set(a, cached);
  f.owner.select(a);
  f.extraReads[0].resolve({ comments: null, issueComments: null, status: null });
  await flush();
  const retained = f.owner.getState();
  assert.equal(retained.comments, cached.comments);
  assert.equal(retained.issueComments, cached.issueComments);
  assert.equal(retained.status, cached.status);
  assert.equal(retained.commentsUnavailable, true);
  assert.equal(retained.issueCommentsUnavailable, true);
  assert.equal(retained.reviewThreads, undefined);
  const fresh = extras();
  f.extraCache.set(a, fresh);
  f.emit(a, "extras");
  assert.equal(f.owner.getState().comments, fresh.comments);
  assert.equal(f.owner.getState().issueComments, fresh.issueComments);
  assert.equal(f.owner.getState().commentsUnavailable, false);
  assert.equal(f.owner.getState().issueCommentsUnavailable, false);
});

test("PR reads: initial extras failure marks both unavailable, retains cached data, and clears only its loading", async (t) => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  t.mock.method(console, "error", () => {});
  const cached = { comments: [comment()], issueComments: [issueComment()], status: null };
  f.extraCache.set(a, cached);
  f.owner.select(a);
  f.extraReads[0].reject(new Error("Extras offline"));
  await flush();
  assert.equal(f.owner.getState().commentsUnavailable, true);
  assert.equal(f.owner.getState().issueCommentsUnavailable, true);
  assert.equal(f.owner.getState().comments, cached.comments);
  assert.equal(f.owner.getState().loadingComments, false);
  assert.equal(f.owner.getState().loadingStatus, false);
  f.detailReads[0].resolve(prDetailFixture(a));
  await flush();
  assert.ok(f.owner.getState().detail);
});

test("PR reads: matching cache success settles extras loading without another request", (t) => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  f.owner.select(a);
  const before = f.owner.getState();
  f.emit(b, "extras");
  f.emit(b, "detail");
  assert.equal(f.owner.getState(), before);
  const cached = extras();
  f.extraCache.set(a, cached);
  f.emit(a, "extras");
  assert.equal(f.owner.getState().loadingStatus, false);
  assert.equal(f.owner.getState().loadingComments, false);
  assert.equal(f.owner.getState().comments, cached.comments);
  const detail = prDetailFixture(a);
  f.details.set(a, detail);
  f.emit(a, "detail");
  assert.equal(f.owner.getState().detail, detail);
  assert.equal(f.calls.length, 3);
});

test("PR reads: post-merge cancels, invalidates, then starts three parallel reads; navigation cannot redirect target", async (t) => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  const cancellation = gate<void>(),
    invalidation = gate<void>(),
    list = gate<void>();
  f.query.cancelPrQueries = (url) => {
    f.calls.push({ kind: "cancel", url });
    return cancellation.promise;
  };
  f.query.invalidatePrQueries = (url) => {
    f.calls.push({ kind: "invalidate", url });
    return invalidation.promise;
  };
  f.query.refreshList = () => {
    f.calls.push({ kind: "refresh-list" });
    return list.promise;
  };
  f.owner.select(a);
  const refresh = f.owner.refreshAfterMerge();
  assert.deepEqual(f.calls.slice(3), [{ kind: "cancel", url: a }]);
  f.requested(b);
  f.owner.select(b);
  cancellation.resolve();
  await flush();
  assert.deepEqual(f.calls.slice(-1), [{ kind: "invalidate", url: a }]);
  invalidation.resolve();
  await flush();
  assert.deepEqual(f.calls.slice(-3), [
    { kind: "refresh-extras", url: a },
    { kind: "refresh-detail", url: a, afterWrite: true },
    { kind: "refresh-list" },
  ]);
  assert.equal(
    f.owner.getState().refreshingDetail,
    false,
    "A's delayed refresh does not mark B busy",
  );
  f.extraRefreshes[0].resolve({
    comments: [comment()],
    issueComments: [issueComment()],
    status: status(),
  });
  f.detailRefreshes[0].resolve(prDetailFixture(a));
  list.resolve();
  await refresh;
  assert.equal(f.owner.getState().url, b);
  assert.equal(f.owner.getState().detail, undefined);
  assert.deepEqual(f.owner.getState().comments, []);
  assert.equal(f.owner.getState().loadingComments, true);
});

test("PR reads: post-merge acquires detail ownership after held cancellation, superseding an intervening ordinary refresh", async (t) => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  const cancellation = gate<void>();
  f.query.cancelPrQueries = () => cancellation.promise;
  f.owner.select(a);
  const merge = f.owner.refreshAfterMerge();
  const ordinary = f.owner.refreshDetail();
  const ordinaryFailure = assert.rejects(ordinary, /Older ordinary refresh failed/);
  assert.equal(f.detailRefreshes.length, 1);
  cancellation.resolve();
  await flush();
  assert.equal(f.detailRefreshes.length, 2, "post-merge successor has started and remains held");
  f.detailRefreshes[0].reject(new Error("Older ordinary refresh failed"));
  await ordinaryFailure;
  assert.equal(
    f.owner.getState().refreshingDetail,
    true,
    "older ordinary finally cannot clear successor busy state",
  );
  assert.equal(
    f.owner.getState().detailError,
    undefined,
    "older ordinary rejection cannot publish over successor",
  );
  const fresh = prDetailFixture(a, "c".repeat(40));
  f.detailRefreshes[1].resolve(fresh);
  f.extraRefreshes[0].resolve(extras());
  await merge;
  assert.equal(f.owner.getState().detail, fresh);
  assert.equal(f.owner.getState().detailError, undefined);
  assert.equal(f.owner.getState().refreshingDetail, false);
});

test("PR reads: delayed old-PR merge refresh cannot steal the new PR's detail ownership", async (t) => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  const cancellation = gate<void>();
  f.query.cancelPrQueries = () => cancellation.promise;
  f.owner.select(a);
  const merge = f.owner.refreshAfterMerge();
  f.requested(b);
  f.owner.select(b);
  const ordinary = f.owner.refreshDetail();
  cancellation.resolve();
  await flush();
  assert.deepEqual(
    f.calls.filter((call) => call.kind === "refresh-detail"),
    [
      { kind: "refresh-detail", url: b, afterWrite: false },
      { kind: "refresh-detail", url: a, afterWrite: true },
    ],
  );
  f.detailRefreshes[1].resolve(prDetailFixture(a));
  f.extraRefreshes[0].resolve(extras());
  await merge;
  assert.equal(f.owner.getState().refreshingDetail, true);
  assert.equal(f.owner.getState().detailError, undefined);
  const fresh = prDetailFixture(b);
  f.detailRefreshes[0].resolve(fresh);
  await ordinary;
  assert.equal(
    f.owner.getState().detail,
    fresh,
    "B's refresh still owns publication after A's delayed refresh",
  );
  assert.equal(f.owner.getState().refreshingDetail, false);
});

test("PR reads: successful post-merge publishes detail independently and waits for the complete parallel refresh before extras", async (t) => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  const list = gate<void>();
  f.query.refreshList = () => list.promise;
  f.owner.select(a);
  const refresh = f.owner.refreshAfterMerge();
  await flush();
  const fresh = prDetailFixture(a);
  f.detailRefreshes[0].resolve(fresh);
  const freshExtras = { comments: [comment()], issueComments: [issueComment()], status: status() };
  f.extraRefreshes[0].resolve(freshExtras);
  await flush();
  assert.equal(f.owner.getState().detail, fresh);
  assert.deepEqual(
    f.owner.getState().comments,
    [],
    "extras callback waits for list like the original Promise.all",
  );
  list.resolve();
  await refresh;
  assert.equal(f.owner.getState().comments, freshExtras.comments);
  assert.equal(f.owner.getState().status, freshExtras.status);
});

test("PR reads: post-merge extras rejection propagates while parallel detail still settles", async (t) => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  f.owner.select(a);
  const refresh = f.owner.refreshAfterMerge();
  const failure = assert.rejects(refresh, /Extras refresh failed/);
  await flush();
  f.extraRefreshes[0].reject(new Error("Extras refresh failed"));
  await failure;
  const fresh = prDetailFixture(a);
  f.detailRefreshes[0].resolve(fresh);
  await flush();
  assert.equal(f.owner.getState().detail, fresh);
  assert.equal(f.owner.getState().refreshingDetail, false);
});

test("PR reads: deselection resets state and disposal unsubscribes without cancelling shared work", async () => {
  const f = fixture();
  f.owner.select(a);
  const read = f.owner.refreshDetail();
  f.owner.select(undefined);
  assert.equal(f.owner.getState().url, undefined);
  assert.equal(f.owner.getState().loadingComments, false);
  let publications = 0;
  f.owner.subscribe(() => publications++);
  const before = f.owner.getState();
  const calls = f.calls.length;
  f.owner.dispose();
  assert.equal(f.listeners.size, 0);
  f.detailReads[0].resolve(prDetailFixture(a));
  f.extraReads[0].resolve(extras());
  f.detailRefreshes[0].resolve(prDetailFixture(a));
  await read;
  await flush();
  f.owner.select(b);
  await f.owner.refreshDetail();
  await f.owner.refreshAfterMerge();
  assert.equal(f.owner.getState(), before);
  assert.equal(publications, 0);
  assert.equal(
    f.calls.length,
    calls,
    "dispose does not cancel shared query work or start new reads",
  );
});

test("PR reads: disposing an active selection suppresses held results and cache events while shared reads finish", async () => {
  const f = fixture();
  f.owner.select(a);
  const refresh = f.owner.refreshDetail();
  const before = f.owner.getState();
  const calls = f.calls.length;
  let publications = 0;
  f.owner.subscribe(() => publications++);
  f.owner.dispose();
  const fresh = prDetailFixture(a);
  f.details.set(a, fresh);
  f.emit(a, "detail");
  f.detailReads[0].resolve(fresh);
  f.extraReads[0].resolve(extras());
  f.detailRefreshes[0].resolve(fresh);
  await refresh;
  await flush();
  assert.equal(f.details.get(a), fresh, "shared cache work can complete");
  assert.equal(f.owner.getState(), before);
  assert.equal(publications, 0);
  assert.equal(f.calls.length, calls);
  assert.equal(f.listeners.size, 0);
});
