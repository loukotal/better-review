import type { PrDetail } from "@better-review/shared";

import { createPrReadState } from "../lib/pr-read-state";
import { prReadQueryAdapter, queryClient, queryKeys, refreshPrDetail } from "../lib/query";
import { mountAppFixture } from "./mount-app";
import { prDetailFixture } from "./pr-detail-fixture";

const url = "https://github.com/browser-fixture/isolated/pull/1";
function check(value: unknown, message: string) {
  if (!value) throw new Error(message);
}
async function wait(predicate: () => boolean, message: string) {
  const until = performance.now() + 5000;
  while (!predicate() && performance.now() < until) await new Promise(requestAnimationFrame);
  check(predicate(), message);
}

export async function testPrReadOwnerConcreteCacheAdapterFiltersEventsWithoutRefetchInBrowser() {
  let reads = 0,
    extras = 0,
    requested = url;
  const initial = prDetailFixture(url);
  const dispose = await mountAppFixture({
    defaultTab: "overview",
    waitForFiles: false,
    procedures: {
      "prDetail.get": () => {
        reads++;
        return initial;
      },
      "pr.extras": () => {
        extras++;
        return { comments: [], issueComments: [], status: null };
      },
    },
  });
  await wait(
    () =>
      !!document.querySelector("[data-pr-overview] h1") &&
      queryClient.getQueryState(queryKeys.pr.extras(url))?.fetchStatus === "idle",
    "Initial selected reads did not settle",
  );
  const owner = createPrReadState({ query: prReadQueryAdapter, requestedUrl: () => requested });
  try {
    owner.select(url);
    await wait(
      () => !owner.getState().loadingComments,
      "Cached owner initialization did not settle",
    );
    await new Promise(requestAnimationFrame);
    const baseline = owner.getState();
    const other = url.replace(/1$/, "2");
    queryClient.setQueryData(queryKeys.pr.detail(other), prDetailFixture(other));
    queryClient.setQueryData(["other", "detail", url], initial);
    const query = queryClient
      .getQueryCache()
      .find({ queryKey: queryKeys.pr.detail(url), exact: true })!;
    query.setState({ status: "error", error: new Error("Unrelated cache action") });
    query.setState({ status: "success", error: null });
    check(owner.getState() === baseline, "Unrelated/error/setState events published selected data");
    const fresh = prDetailFixture(url, "c".repeat(40));
    queryClient.setQueryData(queryKeys.pr.detail(url), fresh);
    const detail = owner.getState().detail;
    check(
      detail?.metadata.status === "available" && detail.metadata.data.head.sha === "c".repeat(40),
      "Matching cache success was ignored",
    );
    const current = owner.getState();
    requested = other;
    queryClient.setQueryData(queryKeys.pr.detail(url), initial);
    queryClient.setQueryData(queryKeys.pr.extras(url), {
      comments: [],
      issueComments: [],
      status: null,
    });
    check(owner.getState() === current, "Edited requested URL accepted old selected cache updates");
    await new Promise(requestAnimationFrame);
    // mountAppFixture seeds extras. Neither cache observation nor a new owner
    // may turn that cached read into an HTTP request.
    check(
      reads === 1 && extras === 0,
      `Cache observation or cached owner initialization added HTTP requests: detail=${reads}, extras=${extras}`,
    );
    return { passed: 4 };
  } finally {
    owner.dispose();
    dispose();
  }
}

export async function testPrReadOwnersShareExactlyOneAfterWriteSuccessorAndDisposeWithoutCancellingInBrowser() {
  let reads = 0;
  let release!: (detail: PrDetail) => void;
  const held = new Promise<PrDetail>((resolve) => {
    release = resolve;
  });
  const fresh = prDetailFixture(url, "c".repeat(40));
  const dispose = await mountAppFixture({
    defaultTab: "overview",
    waitForFiles: false,
    procedures: { "prDetail.refresh": () => (++reads === 1 ? held : fresh) },
  });
  await wait(() => !!document.querySelector("[data-pr-overview] h1"), "Overview not loaded");
  const first = createPrReadState({ query: prReadQueryAdapter, requestedUrl: () => url });
  const second = createPrReadState({ query: prReadQueryAdapter, requestedUrl: () => url });
  try {
    first.select(url);
    second.select(url);
    const ordinary = first.refreshDetail();
    await wait(() => reads === 1, "Ordinary read did not start");
    const afterWrite = first.refreshDetail({ afterWrite: true });
    const otherOwner = second.refreshDetail({ afterWrite: true });
    const appShellRead = refreshPrDetail(url, { afterWrite: true });
    let publications = 0;
    second.subscribe(() => publications++);
    const disposedSnapshot = second.getState();
    second.dispose();
    release(prDetailFixture(url, "b".repeat(40)));
    await Promise.all([ordinary, afterWrite, otherOwner, appShellRead]);
    check(reads === 2, "Shared owners queued more than one post-write successor");
    const detail = first.getState().detail;
    check(
      detail?.metadata.status === "available" && detail.metadata.data.head.sha === "c".repeat(40),
      "Fresh successor did not reach live owner",
    );
    check(
      second.getState() === disposedSnapshot && publications === 0,
      "Disposed owner published shared completion",
    );
    const cached = queryClient.getQueryData<PrDetail>(queryKeys.pr.detail(url));
    check(cached === detail, "Disposal cancelled or prevented shared cache publication");
    return { passed: 4 };
  } finally {
    first.dispose();
    second.dispose();
    dispose();
  }
}
