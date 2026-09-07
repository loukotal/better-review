import assert from "node:assert/strict";
import test from "node:test";

import { createPendingCommentFormState, savePrComment } from "./comment-save";

const draft = {
  filePath: "src/example.ts",
  line: 43,
  startLine: 41,
  endLine: 43,
  side: "RIGHT" as const,
  body: "Comment on expanded unchanged context",
};

const saved = {
  comment: {
    id: 1,
    node_id: "comment-1",
    path: draft.filePath,
    line: 43,
    original_line: 43,
    side: draft.side,
    body: draft.body,
    html_url: "https://github.com/owner/repo/pull/1#discussion_r1",
    user: { login: "reviewer", avatar_url: "" },
    created_at: "2026-09-07T00:00:00Z",
    canEdit: true,
  },
};

test("a rejected PR comment save rejects without publishing success", async () => {
  const error = new Error("GitHub rejected this line");
  await assert.rejects(
    savePrComment(draft, {
      loadedPrUrl: () => "https://github.com/owner/repo/pull/1",
      mutate: async () => {
        throw error;
      },
      onSaved: () => assert.fail("A rejected save must not update comments"),
    }),
    (actual) => actual === error,
  );
});

test("PR save maps ranges to GitHub's end line and start side", async () => {
  for (const side of ["LEFT", "RIGHT"] as const) {
    let published = false;
    const result = await savePrComment(
      { ...draft, line: 99, side },
      {
        loadedPrUrl: () => "pr-1",
        mutate: async (input) => {
          assert.deepEqual(input, {
            prUrl: "pr-1",
            filePath: draft.filePath,
            body: draft.body,
            line: 43,
            side,
            startLine: 41,
            startSide: side,
          });
          return saved;
        },
        onSaved: (url, data) => {
          assert.equal(url, "pr-1");
          assert.equal(data, saved);
          published = true;
        },
      },
    );
    assert.equal(result, saved);
    assert.equal(published, true);
  }
});

test("a save finishing after navigation does not publish into another PR", async () => {
  let url: string | null = "pr-1";
  const response = Promise.withResolvers<typeof saved>();
  const saving = savePrComment(draft, {
    loadedPrUrl: () => url,
    mutate: (input) => {
      assert.equal(input.prUrl, "pr-1");
      return response.promise;
    },
    onSaved: () => assert.fail("Must not append the old PR's comment to the current PR"),
  });
  url = "pr-2";
  response.resolve(saved);
  assert.equal(await saving, saved);
});

test("single-line saves omit range fields and require a loaded PR", async () => {
  for (const selection of [{}, { startLine: 43, endLine: 43 }]) {
    await savePrComment(
      {
        filePath: draft.filePath,
        line: 43,
        side: draft.side,
        body: draft.body,
        ...selection,
      },
      {
        loadedPrUrl: () => "pr-1",
        mutate: async (input) => {
          assert.deepEqual(input, {
            prUrl: "pr-1",
            filePath: draft.filePath,
            line: 43,
            side: draft.side,
            body: draft.body,
          });
          return saved;
        },
        onSaved: () => {},
      },
    );
  }
  await assert.rejects(
    savePrComment(draft, {
      loadedPrUrl: () => null,
      mutate: async () => assert.fail("No request without a loaded PR"),
      onSaved: () => assert.fail("No cache update without a loaded PR"),
    }),
    /No PR loaded/,
  );
});

test("pending form retains its draft on rejected save, exposes an error, and clears on successful retry", async () => {
  const error = new Error("GitHub rejected this line");
  const retry = Promise.withResolvers<typeof saved>();
  let attempts = 0;
  let pending = true;
  const draftChanges: boolean[] = [];
  const form = createPendingCommentFormState({
    startLine: 41,
    endLine: 43,
    initialBody: `  ${draft.body}  `,
    onCancel: () => assert.fail("Save must not cancel the editor"),
    onDraftChange: (value) => draftChanges.push(value),
    onSubmit: async (body) => {
      await savePrComment(
        { ...draft, body },
        {
          loadedPrUrl: () => "pr-1",
          mutate: async (input) => {
            assert.equal(input.body, draft.body);
            if (++attempts === 1) throw error;
            return retry.promise;
          },
          onSaved: () => {},
        },
      );
      pending = false;
    },
  });
  await form.submit();
  assert.equal(form.body(), `  ${draft.body}  `);
  assert.equal(pending, true);
  assert.deepEqual(draftChanges, []);
  assert.equal(form.isSubmitting(), false);
  assert.equal(form.saveError(), error.message);

  const saving = form.submit();
  assert.equal(form.saveError(), null);
  assert.equal(form.isSubmitting(), true);
  assert.equal(pending, true);
  await form.submit();
  assert.equal(attempts, 2, "Duplicate submission is ignored");
  retry.resolve(saved);
  await saving;
  assert.equal(form.body(), "");
  assert.equal(pending, false);
  assert.deepEqual(draftChanges, [false]);
  assert.equal(form.isSubmitting(), false);
});

test("pending form supplies a fallback error for non-Error rejections", async () => {
  const form = createPendingCommentFormState({
    startLine: 43,
    endLine: 43,
    initialBody: draft.body,
    onSubmit: () => Promise.reject(null),
    onCancel: () => {},
  });
  await form.submit();
  assert.equal(form.saveError(), "Failed to add comment");
  assert.equal(form.body(), draft.body);
});
