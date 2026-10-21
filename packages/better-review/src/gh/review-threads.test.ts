import assert from "node:assert/strict";
import { test } from "node:test";

import { readAllReviewThreads } from "./review-threads";

const scope = { owner: "o", repo: "r", number: 1 };
const info = (hasNextPage = false, endCursor: string | null = null) => ({ hasNextPage, endCursor });
test("paginates >100 threads AND >100 comment IDs within a thread", async () => {
  const calls: string[] = [];
  const threads = await readAllReviewThreads(async (query, vars) => {
    calls.push(query);
    if (vars.thread)
      return {
        data: {
          node: {
            id: "T0",
            isResolved: true,
            comments: { nodes: [{ id: "C100" }], pageInfo: info() },
          },
        },
      };
    const nodes = vars.cursor
      ? [{ id: "T100", isResolved: false, comments: { nodes: [{ id: "last" }], pageInfo: info() } }]
      : Array.from({ length: 100 }, (_, i) => ({
          id: `T${i}`,
          isResolved: false,
          comments: {
            nodes: Array.from({ length: i === 0 ? 100 : 1 }, (_, j) => ({
              id: i === 0 ? `C${j}` : `T${i}C${j}`,
            })),
            pageInfo: i === 0 ? info(true, "comments-next") : info(),
          },
        }));
    return {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { nodes, pageInfo: vars.cursor ? info() : info(true, "threads-next") },
          },
        },
      },
    };
  }, scope);
  assert.equal(threads.length, 101);
  assert.equal(threads[0]!.commentNodeIds.length, 101);
  assert.equal(threads[0]!.isResolved, true);
  assert.equal(calls.length, 3);
});
test("malformed, denied and exhausted thread pages never fabricate empty/unresolved evidence", async () => {
  await assert.rejects(
    readAllReviewThreads(async () => ({ errors: [{ message: "denied" }] }), scope),
  );
  await assert.rejects(
    readAllReviewThreads(
      async () => ({
        data: {
          repository: {
            pullRequest: { reviewThreads: { nodes: [], pageInfo: info(true, "next") } },
          },
        },
      }),
      scope,
      1,
    ),
    /limit/,
  );
  await assert.rejects(
    readAllReviewThreads(
      async () => ({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "T",
                    isResolved: false,
                    comments: { nodes: [], pageInfo: info(true, null) },
                  },
                ],
                pageInfo: info(),
              },
            },
          },
        },
      }),
      scope,
    ),
    /incomplete/,
  );
});
