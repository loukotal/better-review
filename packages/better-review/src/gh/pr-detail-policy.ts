import { z } from "zod";

import type { PrBranchRequirements, PrDetailCheck, PrDetailSection } from "@better-review/shared";

const absent = (value: unknown) => value === null || value === undefined;
const classicSchema = z
  .object({
    requiredStatusCheckContexts: z.array(z.string()).nullish(),
    requiredStatusChecks: z
      .array(
        z.object({
          context: z.string(),
          app: z.object({ databaseId: z.number().nullable() }).nullable(),
        }),
      )
      .nullish(),
    requiredApprovingReviewCount: z.number().int().nonnegative().nullish(),
    requiresLinearHistory: z.boolean(),
    requiresApprovingReviews: z.boolean(),
    requiresStatusChecks: z.boolean(),
    requiresCodeOwnerReviews: z.boolean(),
    requiresConversationResolution: z.boolean(),
  })
  .nullable();
/** Effective branch rules include applicable active repository AND inherited organization rulesets.
 * Unlike listing repository rulesets, this endpoint already evaluates ref selectors and enforcement.
 * Classic branch protection is separate and must also be read. */
export async function readPrBranchRequirements(
  classic: unknown,
  read: (path: string) => Promise<unknown>,
  scope: { owner: string; repo: string },
  branch: string,
  maxPages: number,
): Promise<PrDetailSection<PrBranchRequirements>> {
  const data: PrBranchRequirements = {
    requiredStatusCheckContexts: [],
    requiredChecks: [],
    requiredApprovingReviewCount: 0,
    requiresApprovingReviews: false,
    requiresCodeOwnerReviews: false,
    requiresConversationResolution: false,
    queueRequired: false,
    unsupportedRules: [],
    allowedMergeMethods: ["merge", "squash", "rebase"],
    requiresLinearHistory: false,
  };
  let complete = true;
  try {
    const c = classicSchema.parse(classic);
    if (c) {
      // GitHub returns nullable parameters for disabled requirements. Null is only
      // a known zero/empty value when the corresponding enabling flag is false.
      if (c.requiresApprovingReviews && absent(c.requiredApprovingReviewCount)) {
        complete = false;
        data.unsupportedRules!.push("required-review-count-unknown");
      }
      if (
        c.requiresStatusChecks &&
        (absent(c.requiredStatusCheckContexts) || absent(c.requiredStatusChecks))
      ) {
        complete = false;
        data.unsupportedRules!.push("required-status-checks-unknown");
      }
      const count = c.requiredApprovingReviewCount ?? 0;
      const contexts = c.requiredStatusCheckContexts ?? [];
      const checks = c.requiredStatusChecks ?? [];
      Object.assign(data, {
        requiresApprovingReviews: c.requiresApprovingReviews || count > 0,
        requiresCodeOwnerReviews: c.requiresCodeOwnerReviews,
        requiresConversationResolution: c.requiresConversationResolution,
        requiredApprovingReviewCount: count,
        requiresLinearHistory: c.requiresLinearHistory,
      });
      data.requiredStatusCheckContexts.push(...contexts);
      if (checks.some((check) => check.app !== null && check.app.databaseId === null)) {
        complete = false;
        data.unsupportedRules!.push("required-check-integration-unknown");
      }
      data.requiredChecks!.push(
        ...checks.map((check) => ({
          context: check.context,
          appId: check.app?.databaseId ?? null,
        })),
      );
      // Contexts without integration details remain explicit requirements, never disappear.
      for (const context of contexts)
        if (!data.requiredChecks!.some((check) => check.context === context))
          data.requiredChecks!.push({ context, appId: null });
    }
  } catch {
    complete = false;
    data.unsupportedRules!.push("classic-protection-unavailable");
  }
  try {
    let exhausted = false;
    for (let page = 1; page <= maxPages; page++) {
      const rules = z
        .array(z.object({ type: z.string(), parameters: z.unknown().optional() }))
        .parse(
          await read(
            `/repos/${scope.owner}/${scope.repo}/rules/branches/${encodeURIComponent(branch)}?per_page=100&page=${page}`,
          ),
        );
      for (const rule of rules) {
        if (rule.type === "pull_request") {
          const p = z
            .object({
              required_approving_review_count: z.number().int().nonnegative(),
              require_code_owner_review: z.boolean(),
              required_review_thread_resolution: z.boolean(),
              allowed_merge_methods: z.array(z.enum(["merge", "squash", "rebase"])).optional(),
            })
            .parse(rule.parameters);
          data.requiredApprovingReviewCount = Math.max(
            data.requiredApprovingReviewCount!,
            p.required_approving_review_count,
          );
          data.requiresApprovingReviews ||= p.required_approving_review_count > 0;
          data.requiresCodeOwnerReviews ||= p.require_code_owner_review;
          data.requiresConversationResolution ||= p.required_review_thread_resolution;
          if (p.allowed_merge_methods)
            data.allowedMergeMethods = data.allowedMergeMethods!.filter((method) =>
              p.allowed_merge_methods!.includes(method),
            );
        } else if (rule.type === "required_status_checks") {
          const p = z
            .object({
              required_status_checks: z.array(
                z.object({ context: z.string(), integration_id: z.number().nullable().optional() }),
              ),
            })
            .parse(rule.parameters);
          for (const check of p.required_status_checks) {
            data.requiredStatusCheckContexts.push(check.context);
            data.requiredChecks!.push({
              context: check.context,
              appId: check.integration_id && check.integration_id > 0 ? check.integration_id : null,
            });
          }
        } else if (rule.type === "merge_queue") data.queueRequired = true;
        else if (rule.type === "required_linear_history") data.requiresLinearHistory = true;
        else if (!["deletion", "non_fast_forward", "creation"].includes(rule.type)) {
          complete = false;
          data.unsupportedRules!.push(rule.type);
        }
      }
      if (rules.length < 100) {
        exhausted = true;
        break;
      }
    }
    if (!exhausted) {
      complete = false;
      data.unsupportedRules!.push("rules-pagination-incomplete");
    }
  } catch {
    complete = false;
    data.unsupportedRules!.push("effective-rules-unavailable");
  }
  data.requiredStatusCheckContexts = [...new Set(data.requiredStatusCheckContexts)];
  if (data.requiresLinearHistory)
    data.allowedMergeMethods = data.allowedMergeMethods!.filter((method) => method !== "merge");
  return { status: "available", data, complete };
}

export type PolicyFailure = { code: string; message: string };
export function requiredChecksFailure(
  requirements: PrDetailSection<PrBranchRequirements | null>,
  checks: PrDetailSection<PrDetailCheck[]>,
): PolicyFailure | null {
  if (requirements.status !== "available" || !requirements.complete || !requirements.data)
    return {
      code: "requirements-unknown",
      message: "Applicable branch requirements could not be completely verified.",
    };
  const required =
    requirements.data.requiredChecks ??
    requirements.data.requiredStatusCheckContexts.map((context) => ({ context, appId: null }));
  if (!required.length) return null;
  if (checks.status !== "available" || !checks.complete)
    return { code: "required-checks-unknown", message: "Required check evidence is incomplete." };
  for (const requirement of required) {
    const matches = checks.data.filter(
      (check) =>
        check.name === requirement.context &&
        (requirement.appId === null || check.appId === requirement.appId),
    );
    if (!matches.length)
      return {
        code: "required-checks-unknown",
        message: `Required check '${requirement.context}' has no verified result.`,
      };
    if (
      matches.some((check) =>
        check.kind === "status-context"
          ? !["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"].includes(check.status)
          : check.status === "COMPLETED" &&
            ![
              "SUCCESS",
              "NEUTRAL",
              "SKIPPED",
              "FAILURE",
              "CANCELLED",
              "TIMED_OUT",
              "ACTION_REQUIRED",
              "STARTUP_FAILURE",
              "STALE",
            ].includes(check.conclusion ?? ""),
      )
    )
      return {
        code: "required-checks-unknown",
        message: `Required check '${requirement.context}' has an unknown result.`,
      };
    if (
      matches.some((check) =>
        check.kind === "status-context"
          ? ["FAILURE", "ERROR"].includes(check.status)
          : check.status === "COMPLETED" &&
            !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion ?? ""),
      )
    )
      return {
        code: "required-checks-failed",
        message: `Required check '${requirement.context}' failed.`,
      };
    if (
      matches.some((check) =>
        check.kind === "status-context"
          ? check.status !== "SUCCESS"
          : check.status !== "COMPLETED" || !check.conclusion,
      )
    )
      return {
        code: "required-checks-pending",
        message: `Required check '${requirement.context}' is pending.`,
      };
  }
  return null;
}
