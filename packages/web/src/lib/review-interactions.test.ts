import assert from "node:assert/strict";
import test from "node:test";

import { parsePatchFiles } from "@pierre/diffs";

import type { ResolvedSource } from "@better-review/shared";

import type { SourceTarget } from "./annotation-navigation";
import type { ReviewClient } from "./review-client";
import {
  createReviewInteractions,
  type ReviewInteractionContext,
  type SourceWindow,
} from "./review-interactions";
import type { SelectionBubbleAnchor } from "./selection-bubble";

const head = "a".repeat(40);
const files = parsePatchFiles(
  "diff --git a/src/file.ts b/src/file.ts\n--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1 +1 @@\n-old\n+new\n",
).flatMap((patch) => patch.files);
const finding = {
  id: "f",
  file: "src/file.ts",
  line: 1,
  severity: "warning" as const,
  message: "Check this",
  origin: { sessionId: "session", revision: head },
};
const target: SourceTarget = {
  sessionId: "session",
  path: "src/file.ts",
  ref: head,
  side: "RIGHT",
  line: 1,
};
const found = (overrides = {}): ResolvedSource => ({
  status: "found",
  path: target.path,
  ref: head,
  side: "RIGHT",
  line: 1,
  content: "new",
  approximate: false,
  notice: null,
  ...overrides,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(
  resolve: (
    target: SourceTarget,
    range: SourceWindow,
    signal: AbortSignal,
  ) => Promise<ResolvedSource> = async () => found(),
) {
  let context: ReviewInteractionContext = {
    prUrl: "pr",
    loadedPrUrl: "pr",
    scope: "one",
    headSha: head,
    commitScope: false,
    loading: false,
    files,
  };
  const focused: string[] = [];
  const interactions = createReviewInteractions(() => context, {
    resolve,
    focus: (source) => {
      focused.push(source.path);
      return true;
    },
  });
  return {
    interactions,
    focused,
    change: (next: Partial<ReviewInteractionContext>) => {
      context = { ...context, ...next };
    },
  };
}

test("source requests cannot publish stale results or navigate after a newer request, close, or scope change", async () => {
  const requests = [
    deferred<ResolvedSource>(),
    deferred<ResolvedSource>(),
    deferred<ResolvedSource>(),
    deferred<ResolvedSource>(),
  ];
  let index = 0;
  const { interactions: i, focused, change } = setup(() => requests[index++].promise);
  const first = i.openSource(target);
  const secondTarget = { ...target, path: "other.ts" };
  const second = i.openSource(secondTarget);
  requests[1].resolve(found({ path: "other.ts", approximate: true }));
  await second;
  requests[0].resolve(found());
  await first;
  assert.equal(i.source.destination()?.original, secondTarget);
  assert.deepEqual(focused, []);
  const third = i.openSource(target);
  i.source.close();
  requests[2].resolve(found());
  await third;
  assert.equal(i.source.destination(), undefined);
  const fourth = i.openSource(target);
  change({ scope: "two" });
  requests[3].resolve(found());
  await fourth;
  assert.deepEqual(focused, []);
  assert.equal(i.source.destination(), undefined);
});

test("huge source uses bounded windows, pages to both file edges, and selects absolute lines", async () => {
  const ranges: SourceWindow[] = [];
  const { interactions: i, change } = setup(async (_target, range) => {
    ranges.push(range);
    const totalLines = 1_000_000;
    const startLine = Math.min(range.startLine, totalLines);
    const endLine = Math.min(range.endLine, totalLines);
    return found({
      content: Array.from(
        { length: endLine - startLine + 1 },
        (_, index) => `line ${startLine + index}`,
      ).join("\n"),
      totalLines,
      contentStartLine: startLine,
      contentEndLine: endLine,
    });
  });
  change({ headSha: "different-displayed-revision" });
  await i.openSource({ ...target, line: 500_000 });
  assert.deepEqual(ranges[0], { startLine: 499_900, endLine: 500_099 });
  assert.equal(i.source.presentation()!.startLine, 499_900);
  const selected = i.source.selectSource(499_950, 499_951, "line 499950\nline 499951")!;
  assert.equal(selected.startLine, 499_950);
  assert.equal(selected.revision, head);
  assert.throws(() => i.source.selectSource(1, 2, "wrong offset"), /displayed source window/);
  await i.source.page("later");
  assert.deepEqual(ranges.at(-1), { startLine: 500_100, endLine: 500_299 });
  await i.source.page("earlier");
  assert.deepEqual(ranges.at(-1), ranges[0]);
  await i.openSource({ ...target, line: 1 });
  assert.deepEqual(ranges.at(-1), { startLine: 1, endLine: 200 });
  const count = ranges.length;
  await i.source.page("earlier");
  assert.equal(ranges.length, count);
  await i.openSource({ ...target, line: 1_000_000 });
  assert.equal(i.source.presentation()!.endLine, 1_000_000);
  const finalCount = ranges.length;
  await i.source.page("later");
  assert.equal(ranges.length, finalCount);
  assert.ok(ranges.every((range) => range.endLine - range.startLine < 200));
});

test("superseded windows and closed navigation abort only their own request signals", async () => {
  const signals: AbortSignal[] = [];
  const requests: ReturnType<typeof deferred<ResolvedSource>>[] = [];
  const { interactions: i } = setup((_target, _range, signal) => {
    signals.push(signal);
    const request = deferred<ResolvedSource>();
    requests.push(request);
    return request.promise;
  });
  const first = i.openSource(target);
  const second = i.openSource({ ...target, path: "other.ts" });
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  i.source.close();
  assert.equal(signals[1].aborted, true);
  requests[0].resolve(found());
  requests[1].resolve(found());
  await Promise.all([first, second]);
  assert.equal(i.source.destination(), undefined);
});

test("ambiguous path choices and pagination never stamp fallback provenance onto captured source", async () => {
  let calls = 0;
  const { interactions: i } = setup(async () =>
    calls++ === 0
      ? {
          status: "ambiguous",
          candidates: ["src/file.ts"],
          ref: head,
          side: "RIGHT",
          approximate: true,
          notice: "Fallback",
        }
      : found({ totalLines: 500, contentStartLine: 1, contentEndLine: 200 }),
  );
  const original = {
    ...target,
    ref: "old",
    path: "file.ts",
    captured: { text: "original", startLine: 4, endLine: 4 },
  };
  await i.openSource(original);
  assert.equal(i.source.chooseTarget("not-a-candidate"), undefined);
  const chosen = i.source.chooseTarget("src/file.ts")!;
  assert.equal(chosen.ref, "old");
  await i.openSource(chosen);
  assert.equal(i.source.presentation()!.text, "original");
  assert.equal(i.source.selectSource(4, 4, "original")!.revision, "old");
  await i.source.page("later");
  assert.equal(i.source.presentation()!.text, "original");
  assert.equal(i.source.destination()!.original.ref, "old");
  const result = i.source.destination()!.result;
  assert.equal(result.status === "found" && result.approximate, true);
});

test("original captured provenance survives approximate lookup and cannot become a comment location", async () => {
  const { interactions: i, focused } = setup();
  const original = {
    ...target,
    ref: "historical",
    captured: { text: "original", startLine: 1, endLine: 1 },
    lookup: {
      path: "src/file.ts",
      ref: head,
      side: "RIGHT" as const,
      approximate: true,
      notice: "Fallback",
    },
  };
  await i.openSource(original);
  const destination = i.source.destination();
  assert.equal(destination?.original.ref, "historical");
  assert.equal(destination?.original.captured?.text, "original");
  assert.equal(destination?.result.status === "found" && destination.result.approximate, true);
  assert.deepEqual(focused, []);
  assert.equal(i.prepareComment(finding, "session", original.ref), undefined);
  assert.match(i.notice()!, /provenance/);
});

test("only exact current right-side destinations focus the diff", async () => {
  const { interactions: i, focused, change } = setup();
  await i.openSource(target, true);
  assert.equal(i.source.target(), null);
  assert.equal(focused.length, 1);
  change({ headSha: "new-head" });
  await i.openSource(target);
  assert.equal(focused.length, 1);
  assert.equal(i.source.destination()?.result.status, "found");
});

test("finding drafts survive repeated preparation and failed guards; stale locations are rejected", () => {
  const { interactions: i, change } = setup();
  const outside = { ...finding, line: 50 };
  i.prepareComment(outside, "session", head);
  const first = i.inlineFinding()!;
  first.draft.body = "edited draft";
  i.prepareComment(outside, "session", head);
  assert.equal(i.inlineFinding()!.draft, first.draft);
  assert.equal(i.inlineFinding()!.draft.body, "edited draft");
  i.prepareComment(outside, "session", "old");
  assert.equal(i.inlineFinding()!.draft, first.draft);
  change({ scope: "two", headSha: "new" });
  assert.equal(i.currentComment(first.request), false);
  assert.throws(() => i.assertCurrentComment(first.request), /not submitted/);
  assert.equal(i.inlineFinding()!.draft.body, "edited draft");
  change({ headSha: head, commitScope: true });
  assert.equal(i.prepareComment(outside, "session", head), undefined);
  assert.match(i.notice()!, /commit scope/);
});

const selection = {
  file: "src/file.ts",
  side: "RIGHT" as const,
  startLine: 1,
  endLine: 1,
  text: "new",
};
const anchor: SelectionBubbleAnchor = { root: {} as Node, rect: () => null };
test("selection intent retains question and destination, and new selections cannot erase it", () => {
  const { interactions: i, change } = setup();
  i.selectSource(selection, anchor);
  const draft = i.question()!;
  draft.state.setQuestion("Why?");
  draft.state.setTarget("saved");
  i.selectSource({ ...selection, text: "other" }, anchor);
  assert.equal(i.question(), draft);
  change({ scope: "two" });
  assert.equal(i.question()!.state.question(), "Why?");
  assert.equal(i.question()!.state.target(), "saved");
  i.dismissSelection();
  i.selectSource(selection, anchor);
  assert.notEqual(i.question()!.selection.draftId, draft.selection.draftId);
  assert.equal(i.selectionClearToken(), 1);
});

test("askAbout retries new/existing conversations with stable receipts and preserves selection after ambiguous send failure", async () => {
  for (const target of ["new", "saved"]) {
    const { interactions: i } = setup();
    i.selectSource(selection, anchor);
    const draft = i.question()!;
    draft.state.setQuestion("Why?");
    let creates = 0;
    const keys: (string | undefined)[] = [];
    const client = {
      history: async () => ({ running: keys.length > 0, compacting: false }),
      send: async (_body: string, key?: string) => {
        keys.push(key);
        if (keys.length === 1) throw new Error("receipt lost");
      },
    } as unknown as Pick<ReviewClient, "history" | "send">;
    const destination = {
      target,
      isCurrent: () => true,
      createSession: async () => {
        creates++;
        return "created";
      },
      client: () => client,
    };
    await assert.rejects(i.askAbout(draft.selection, "question", destination), /receipt lost/);
    assert.equal(i.question()!.state.question(), "Why?");
    assert.equal(
      await i.askAbout(draft.selection, "question", destination),
      target === "new" ? "created" : "saved",
    );
    assert.equal(creates, target === "new" ? 1 : 0);
    assert.equal(keys[0], keys[1]);
  }
});

test("askAbout blocks stale requests after asynchronous session creation before sending", async () => {
  const { interactions: i, change } = setup();
  i.selectSource(selection, anchor);
  const created = deferred<string>();
  let clients = 0;
  const sending = i.askAbout(i.question()!.selection, "question", {
    target: "new",
    isCurrent: () => true,
    createSession: () => created.promise,
    client: () => {
      clients++;
      throw new Error("must not send");
    },
  });
  change({ scope: "two" });
  created.resolve("created");
  await assert.rejects(sending, /changed/);
  assert.equal(clients, 0);
  assert.ok(i.question());
});

test("askAbout is single flight and busy destinations retain the editor draft", async () => {
  const { interactions: i } = setup();
  i.selectSource(selection, anchor);
  const draft = i.question()!;
  draft.state.setQuestion("Keep me");
  const status = deferred<Awaited<ReturnType<ReviewClient["history"]>>>();
  let sends = 0;
  const client = {
    history: () => status.promise,
    send: async () => {
      sends++;
    },
  } as unknown as Pick<ReviewClient, "history" | "send">;
  const destination = {
    target: "saved",
    isCurrent: () => true,
    createSession: async () => "unused",
    client: () => client,
  };
  const first = i.askAbout(draft.selection, "question", destination);
  assert.equal(await i.askAbout(draft.selection, "question", destination), null);
  status.resolve({ running: true, compacting: false } as Awaited<
    ReturnType<ReviewClient["history"]>
  >);
  await assert.rejects(first, /busy/);
  assert.equal(sends, 0);
  assert.equal(i.question()!.state.question(), "Keep me");
});
