import { z } from "zod";

import type {
  PrDetail,
  PrDetailSection,
  PrMergeCapabilities,
  PrMergeMethod,
} from "@better-review/shared";

import {
  createPrDetailHttp,
  credential,
  parsePrDetailUrl,
  type PrDetailHttpOptions,
} from "./pr-detail-http";
import {
  readPrBranchRequirements,
  requiredChecksFailure,
  type PolicyFailure,
} from "./pr-detail-policy";

const actor = z.object({ id: z.string(), login: z.string() });
const identity = z.object({ login: z.string() }).nullable();
const metadata = z.object({
  id: z.string(),
  number: z.number(),
  url: z.string(),
  title: z.string(),
  body: z.string(),
  author: identity,
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  headRefName: z.string(),
  headRefOid: z.string(),
  baseRefName: z.string(),
  baseRefOid: z.string(),
  mergedAt: z.string().nullable(),
  mergedBy: identity,
  mergeCommit: z.object({ oid: z.string() }).nullable(),
});
const page = z.object({
  nodes: z.array(z.unknown()),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
});
const capability = z.object({
  mergeCommitAllowed: z.boolean(),
  squashMergeAllowed: z.boolean(),
  rebaseMergeAllowed: z.boolean(),
  viewerPermission: z.string().nullable(),
  pullRequest: z.object({
    headRefOid: z.string(),
    baseRefOid: z.string(),
    baseRefName: z.string(),
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    isDraft: z.boolean(),
    viewerCanMergeAsAdmin: z.boolean(),
    mergeable: z.string(),
    mergeStateStatus: z.string(),
    reviewDecision: z.string().nullable(),
    mergeQueueEntry: z.object({ id: z.string(), position: z.number().nullable() }).nullable(),
    autoMergeRequest: z.object({ enabledAt: z.string() }).nullable(),
  }),
});
export const available = <T>(data: T, complete = true): PrDetailSection<T> => ({
  status: "available",
  data,
  complete,
});
export const unavailable = (message = "GitHub evidence unavailable."): PrDetailSection<never> => ({
  status: "unavailable",
  message,
});
export function createPrDetailClient(options: PrDetailHttpOptions = {}) {
  async function snapshot(url: string, pinnedToken?: string): Promise<PrDetail> {
    const scope = parsePrDetailUrl(url);
    const empty: PrDetail = {
      url: scope.url,
      fetchedAt: new Date().toISOString(),
      actor: unavailable(),
      metadata: unavailable(),
      labels: unavailable(),
      checks: unavailable(),
      reviews: unavailable(),
      reviewRequests: unavailable(),
      mergeCapabilities: unavailable(),
    };
    let token: string;
    try {
      token = pinnedToken ?? (await credential(options));
    } catch {
      return empty;
    }
    const http = createPrDetailHttp(options, token);
    async function graphql(query: string, variables: Record<string, unknown> = {}) {
      const raw = z
        .object({
          data: z.record(z.string(), z.unknown()).optional(),
          errors: z.array(z.unknown()).optional(),
        })
        .parse(await http("/graphql", "POST", { query, variables: { ...scope, ...variables } }));
      if (raw.errors?.length || !raw.data) throw new Error("GitHub GraphQL evidence unavailable.");
      return raw.data;
    }
    async function pr(selection: string, variables: Record<string, unknown> = {}, cursor = false) {
      const data = await graphql(
        `query($owner:String!,$repo:String!,$number:Int!${cursor ? ",$cursor:String" : ""}){repository(owner:$owner,name:$repo){pullRequest(number:$number){${selection}}}}`,
        variables,
      );
      return z.object({ pullRequest: z.record(z.string(), z.unknown()) }).parse(data.repository)
        .pullRequest;
    }
    async function section<T>(run: () => Promise<T>): Promise<PrDetailSection<T>> {
      try {
        return available(await run());
      } catch {
        return unavailable();
      }
    }
    async function connection<T>(
      field: string,
      selection: string,
      decode: (v: unknown) => T,
    ): Promise<PrDetailSection<T[]>> {
      try {
        const result: T[] = [];
        let cursor: string | null = null;
        for (let i = 0; i < (options.maxPages ?? 1000); i++) {
          const p = page.parse(
            (
              await pr(
                `${field}(first:100,after:$cursor){nodes{${selection}} pageInfo{hasNextPage endCursor}}`,
                { cursor },
                true,
              )
            )[field],
          );
          result.push(...p.nodes.map(decode));
          if (!p.pageInfo.hasNextPage) return available(result);
          if (!p.pageInfo.endCursor || p.pageInfo.endCursor === cursor)
            return available(result, false);
          cursor = p.pageInfo.endCursor;
        }
        return available(result, false);
      } catch {
        return unavailable();
      }
    }
    const [viewer, meta, labels, reviews, reviewRequests, caps] = await Promise.all([
      section(async () => actor.parse((await graphql("query{viewer{id login}}")).viewer)),
      section(async () => {
        const m = metadata.parse(
          await pr(
            "id number url title body author{login} state isDraft headRefName headRefOid baseRefName baseRefOid mergedAt mergedBy{login} mergeCommit{oid}",
          ),
        );
        return {
          id: m.id,
          number: m.number,
          url: m.url,
          title: m.title,
          body: m.body,
          author: m.author?.login ?? null,
          state: m.state,
          draft: m.isDraft,
          head: { name: m.headRefName, sha: m.headRefOid },
          base: { name: m.baseRefName, sha: m.baseRefOid },
          mergedAt: m.mergedAt,
          mergedBy: m.mergedBy?.login ?? null,
          mergeCommitSha: m.mergeCommit?.oid ?? null,
        };
      }),
      connection("labels", "name color description", (v) =>
        z
          .object({ name: z.string(), color: z.string(), description: z.string().nullable() })
          .parse(v),
      ),
      connection("reviews", "id author{login} state body submittedAt url commit{oid}", (v) => {
        const r = z
          .object({
            id: z.string(),
            author: identity,
            state: z.string(),
            body: z.string(),
            submittedAt: z.string().nullable(),
            url: z.string(),
            commit: z.object({ oid: z.string() }).nullable(),
          })
          .parse(v);
        return { ...r, author: r.author?.login ?? null, commitSha: r.commit?.oid ?? null };
      }),
      connection(
        "reviewRequests",
        "requestedReviewer{__typename ... on User{login} ... on Team{slug}}",
        (v) => {
          const r = z
            .object({
              requestedReviewer: z.discriminatedUnion("__typename", [
                z.object({ __typename: z.literal("User"), login: z.string() }),
                z.object({ __typename: z.literal("Team"), slug: z.string() }),
              ]),
            })
            .parse(v).requestedReviewer;
          return r.__typename === "User"
            ? { kind: "user" as const, name: r.login }
            : { kind: "team" as const, name: r.slug };
        },
      ),
      section(async () =>
        capability.parse(
          (
            await graphql(`
              query ($owner: String!, $repo: String!, $number: Int!) {
                repository(owner: $owner, name: $repo) {
                  mergeCommitAllowed
                  squashMergeAllowed
                  rebaseMergeAllowed
                  viewerPermission
                  pullRequest(number: $number) {
                    headRefOid
                    baseRefOid
                    baseRefName
                    state
                    isDraft
                    viewerCanMergeAsAdmin
                    mergeable
                    mergeStateStatus
                    reviewDecision
                    mergeQueueEntry {
                      id
                      position
                    }
                    autoMergeRequest {
                      enabledAt
                    }
                  }
                }
              }
            `)
          ).repository,
        ),
      ),
    ]);
    empty.actor = viewer;
    empty.metadata = meta;
    empty.labels = labels;
    empty.reviews = reviews;
    empty.reviewRequests = reviewRequests;
    if (meta.status === "available") {
      empty.checks = await (async () => {
        try {
          const result: import("@better-review/shared").PrDetailCheck[] = [];
          let cursor: string | null = null;
          for (let i = 0; i < (options.maxPages ?? 1000); i++) {
            const data = await graphql(
              `
                query ($sha: GitObjectID!, $owner: String!, $repo: String!, $cursor: String) {
                  repository(owner: $owner, name: $repo) {
                    object(oid: $sha) {
                      ... on Commit {
                        statusCheckRollup {
                          contexts(first: 100, after: $cursor) {
                            nodes {
                              __typename
                              ... on CheckRun {
                                id
                                name
                                status
                                conclusion
                                detailsUrl
                                checkSuite {
                                  app {
                                    databaseId
                                  }
                                }
                              }
                              ... on StatusContext {
                                id
                                context
                                state
                                targetUrl
                              }
                            }
                            pageInfo {
                              hasNextPage
                              endCursor
                            }
                          }
                        }
                      }
                    }
                  }
                }
              `,
              { sha: meta.data.head.sha, cursor },
            );
            const rollup = z
              .object({
                object: z.object({ statusCheckRollup: z.object({ contexts: page }).nullable() }),
              })
              .parse(data.repository).object.statusCheckRollup;
            if (!rollup) return available(result);
            for (const node of rollup.contexts.nodes) {
              const c = z
                .discriminatedUnion("__typename", [
                  z.object({
                    __typename: z.literal("CheckRun"),
                    id: z.string(),
                    name: z.string(),
                    status: z.string(),
                    conclusion: z.string().nullable(),
                    detailsUrl: z.string().nullable(),
                    checkSuite: z
                      .object({ app: z.object({ databaseId: z.number().nullable() }).nullable() })
                      .nullable(),
                  }),
                  z.object({
                    __typename: z.literal("StatusContext"),
                    id: z.string(),
                    context: z.string(),
                    state: z.string(),
                    targetUrl: z.string().nullable(),
                  }),
                ])
                .parse(node);
              result.push(
                c.__typename === "CheckRun"
                  ? {
                      id: c.id,
                      kind: "check-run",
                      name: c.name,
                      status: c.status,
                      conclusion: c.conclusion,
                      url: c.detailsUrl,
                      appId: c.checkSuite?.app?.databaseId ?? null,
                    }
                  : {
                      id: c.id,
                      kind: "status-context",
                      name: c.context,
                      status: c.state,
                      conclusion: null,
                      url: c.targetUrl,
                    },
              );
            }
            if (!rollup.contexts.pageInfo.hasNextPage) return available(result);
            const next = rollup.contexts.pageInfo.endCursor;
            if (!next || next === cursor) return available(result, false);
            cursor = next;
          }
          return available(result, false);
        } catch {
          return unavailable();
        }
      })();
    }
    if (caps.status === "available" && meta.status === "available") {
      const c = caps.data;
      const p = c.pullRequest;
      const queue = await section(async () => {
        const data = await graphql(
          `
            query ($owner: String!, $repo: String!, $branch: String!) {
              repository(owner: $owner, name: $repo) {
                mergeQueue(branch: $branch) {
                  id
                }
              }
            }
          `,
          { branch: meta.data.base.name },
        );
        return (
          z.object({ mergeQueue: z.object({ id: z.string() }).nullable() }).parse(data.repository)
            .mergeQueue !== null
        );
      });
      let classic: unknown;
      try {
        const r = await pr(
          "baseRef{branchProtectionRule{requiredStatusCheckContexts requiredStatusChecks{context app{databaseId}} requiredApprovingReviewCount requiresApprovingReviews requiresStatusChecks requiresCodeOwnerReviews requiresConversationResolution requiresLinearHistory}}",
        );
        classic = z
          .object({ branchProtectionRule: z.unknown() })
          .parse(r.baseRef).branchProtectionRule;
      } catch {
        classic = undefined;
      }
      const requirements = await readPrBranchRequirements(
        classic,
        (path) => http(path, "GET", undefined),
        scope,
        meta.data.base.name,
        options.maxPages ?? 1000,
      );
      const methods: PrMergeMethod[] = [];
      if (c.mergeCommitAllowed) methods.push("merge");
      if (c.squashMergeAllowed) methods.push("squash");
      if (c.rebaseMergeAllowed) methods.push("rebase");
      const writable =
        viewer.status === "available" &&
        ["WRITE", "MAINTAIN", "ADMIN"].includes(c.viewerPermission ?? "");
      const open =
        meta.data.state === "OPEN" && !meta.data.draft && !p.mergeQueueEntry && !p.autoMergeRequest;
      const rules = requirements.status === "available" ? requirements.data : null;
      const queueRequired =
        queue.status === "available" && requirements.status === "available" && requirements.complete
          ? queue.data || !!rules?.queueRequired
          : null;
      const common: PolicyFailure | null = !open
        ? {
            code: "not-open",
            message: "Pull request is closed, draft, queued, or already has auto-merge enabled.",
          }
        : !writable
          ? {
              code: "permission-unknown",
              message: "Current actor and write permission are not verified.",
            }
          : p.mergeable !== "MERGEABLE"
            ? {
                code: "mergeability-unknown",
                message: "GitHub has not confirmed conflict-free mergeability.",
              }
            : null;
      const policy =
        requiredChecksFailure(requirements, empty.checks) ??
        (p.reviewDecision === "CHANGES_REQUESTED"
          ? { code: "changes-requested", message: "Changes have been requested." }
          : p.reviewDecision === "REVIEW_REQUIRED"
            ? { code: "review-required", message: "Required reviews are missing." }
            : rules?.requiresApprovingReviews && p.reviewDecision !== "APPROVED"
              ? {
                  code: "review-unknown",
                  message: "Required review approval could not be verified.",
                }
              : !["CLEAN", "HAS_HOOKS", "UNSTABLE"].includes(p.mergeStateStatus)
                ? {
                    code: "merge-state-blocked",
                    message: `GitHub merge state '${p.mergeStateStatus}' does not permit this action.`,
                  }
                : null);
      const value: PrMergeCapabilities = {
        allowedMethods: methods,
        viewerPermission: c.viewerPermission,
        viewerCanMergeAsAdmin: p.viewerCanMergeAsAdmin,
        mergeable: p.mergeable,
        mergeStateStatus: p.mergeStateStatus,
        reviewDecision: p.reviewDecision,
        queueRequired,
        queueEntry: p.mergeQueueEntry,
        autoMergeEnabled: !!p.autoMergeRequest,
        branchRequirements: requirements,
        actions: [],
      };
      for (const method of methods)
        for (const kind of ["merge", "admin-merge"] as const) {
          const failure =
            common ??
            (kind === "admin-merge"
              ? p.viewerCanMergeAsAdmin === true
                ? null
                : {
                    code: "admin-bypass-unavailable",
                    message: "GitHub did not explicitly grant administrator bypass.",
                  }
              : (policy ??
                (rules?.allowedMergeMethods && !rules.allowedMergeMethods.includes(method)
                  ? {
                      code: "method-restricted",
                      message: "Branch rules disallow this merge method.",
                    }
                  : null) ??
                (queueRequired === null
                  ? { code: "queue-unknown", message: "Merge queue requirements are unknown." }
                  : queueRequired
                    ? { code: "queue-required", message: "This branch requires the merge queue." }
                    : null)));
          const enabled = !failure;
          value.actions.push({
            action: { kind, method },
            enabled,
            reason: failure?.message ?? null,
            reasonCode: failure?.code ?? null,
          });
        }
      const enqueueFailure =
        common ??
        policy ??
        (queueRequired === true
          ? null
          : {
              code: queueRequired === null ? "queue-unknown" : "queue-not-required",
              message: "Merge queue eligibility is not established.",
            });
      const enqueue = !enqueueFailure;
      value.actions.push({
        action: { kind: "enqueue" },
        enabled: enqueue,
        reason: enqueueFailure?.message ?? null,
        reasonCode: enqueueFailure?.code ?? null,
      });
      empty.mergeCapabilities = available(value);
    }
    if (meta.status === "available") {
      try {
        const final = z
          .object({
            headRefOid: z.string(),
            baseRefOid: z.string(),
            baseRefName: z.string(),
            state: z.string(),
            isDraft: z.boolean(),
          })
          .parse(await pr("headRefOid baseRefOid baseRefName state isDraft"));
        const cap = caps.status === "available" ? caps.data.pullRequest : null;
        if (
          final.state !== meta.data.state ||
          final.isDraft !== meta.data.draft ||
          final.headRefOid !== meta.data.head.sha ||
          final.baseRefOid !== meta.data.base.sha ||
          final.baseRefName !== meta.data.base.name ||
          (cap &&
            (cap.state !== final.state ||
              cap.isDraft !== final.isDraft ||
              cap.headRefOid !== final.headRefOid ||
              cap.baseRefOid !== final.baseRefOid ||
              cap.baseRefName !== final.baseRefName))
        )
          throw new Error("Revision changed");
      } catch {
        const stale = unavailable(
          "Pull request head or base changed during the read, or could not be rechecked. Refresh required.",
        );
        empty.metadata = stale;
        empty.checks = stale;
        empty.mergeCapabilities = stale;
        empty.reviews = stale;
        empty.reviewRequests = stale;
      }
    }
    return empty;
  }
  return { get: snapshot, refresh: snapshot };
}
