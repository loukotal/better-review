import assert from "node:assert/strict";
import { test } from "node:test";

import { isGithubWriteAction, isGithubRemoteResult } from "./github-outbox";

test("draft desired-state actions and canonical evidence validate both boolean values", () => {
  for (const draft of [true, false]) {
    assert.equal(isGithubWriteAction({ kind: "set-draft", pullRequestId: "PR1", draft }), true);
    assert.equal(
      isGithubRemoteResult({
        kind: "pull-request-draft",
        nodeId: "PR1",
        url: "https://github.com/o/r/pull/1",
        draft,
      }),
      true,
    );
  }
  for (const pullRequestId of [undefined, null, "", 1])
    assert.equal(isGithubWriteAction({ kind: "set-draft", pullRequestId, draft: true }), false);
  for (const nodeId of [undefined, null, "", 1])
    assert.equal(
      isGithubRemoteResult({
        kind: "pull-request-draft",
        nodeId,
        url: "https://github.com/o/r/pull/1",
        draft: true,
      }),
      false,
    );
  for (const draft of [undefined, null, "false", 0]) {
    assert.equal(isGithubWriteAction({ kind: "set-draft", pullRequestId: "PR1", draft }), false);
    assert.equal(
      isGithubRemoteResult({
        kind: "pull-request-draft",
        nodeId: "PR1",
        url: "https://github.com/o/r/pull/1",
        draft,
      }),
      false,
    );
  }
  for (const url of [
    "https://evil.com/o/r/pull/1",
    "https://github.com/o/r/pull/1#x",
    "https://github.com/-/r/pull/1",
    "https://github.com/o/../pull/1",
    "https://github.com/o/r/pull/01",
    "https://github.com/o/r/pull/9007199254740992",
  ])
    assert.equal(
      isGithubRemoteResult({ kind: "pull-request-draft", nodeId: "PR1", url, draft: false }),
      false,
    );
});
