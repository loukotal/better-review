import { z } from "zod";

const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const comments = z.object({ nodes: z.array(z.object({ id: z.string() })), pageInfo });
const thread = z.object({ id: z.string(), isResolved: z.boolean(), comments });
export interface GithubReviewThread {
  threadId: string;
  isResolved: boolean;
  commentNodeIds: string[];
}
/** Missing, malformed, partial, or exhausted evidence throws. Callers must not translate it to []. */
export async function readAllReviewThreads(
  read: (query: string, variables: Record<string, string | number>) => Promise<unknown>,
  scope: { owner: string; repo: string; number: number },
  maxPages = 1000,
): Promise<GithubReviewThread[]> {
  const result: GithubReviewThread[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id isResolved comments(first:100){nodes{id} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}}}`;
    const raw = z
      .object({
        data: z.object({
          repository: z.object({
            pullRequest: z.object({
              reviewThreads: z.object({ nodes: z.array(thread), pageInfo }),
            }),
          }),
        }),
        errors: z.array(z.unknown()).optional(),
      })
      .parse(await read(query, { ...scope, ...(cursor ? { cursor } : {}) }));
    if (raw.errors?.length) throw new Error("Review thread evidence unavailable.");
    const connection = raw.data.repository.pullRequest.reviewThreads;
    for (const initial of connection.nodes) {
      const ids = initial.comments.nodes.map((n) => n.id);
      let current = initial;
      let after: string | undefined;
      for (let nested = 0; current.comments.pageInfo.hasNextPage; nested++) {
        const next = current.comments.pageInfo.endCursor;
        if (!next || next === after || nested >= maxPages)
          throw new Error("Review thread comments incomplete.");
        after = next;
        const response = z
          .object({ data: z.object({ node: thread }), errors: z.array(z.unknown()).optional() })
          .parse(
            await read(
              `query($thread:ID!,$cursor:String){node(id:$thread){... on PullRequestReviewThread{id isResolved comments(first:100,after:$cursor){nodes{id} pageInfo{hasNextPage endCursor}}}}}`,
              { thread: initial.id, cursor: next },
            ),
          );
        if (response.errors?.length || response.data.node.id !== initial.id)
          throw new Error("Review thread membership changed.");
        current = response.data.node;
        ids.push(...current.comments.nodes.map((n) => n.id));
      }
      result.push({
        threadId: initial.id,
        isResolved: current.isResolved,
        commentNodeIds: [...new Set(ids)],
      });
    }
    if (!connection.pageInfo.hasNextPage) return result;
    const next = connection.pageInfo.endCursor;
    if (!next || next === cursor) throw new Error("Review threads incomplete.");
    cursor = next;
  }
  throw new Error("Review thread pagination limit reached.");
}
