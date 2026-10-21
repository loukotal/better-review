import assert from "node:assert/strict";
import { test } from "node:test";

import { readPrBranchRequirements, requiredChecksFailure } from "./pr-detail-policy";

const scope = { owner: "o", repo: "r" };
test("effective inherited rules are paginated and combined with classic protection", async () => {
  const classic = {
    requiredStatusCheckContexts: ["classic"],
    requiredStatusChecks: [{ context: "classic", app: null }],
    requiredApprovingReviewCount: 1,
    requiresLinearHistory: false,
    requiresApprovingReviews: true,
    requiresStatusChecks: true,
    requiresCodeOwnerReviews: false,
    requiresConversationResolution: false,
  };
  const paths: string[] = [];
  const result = await readPrBranchRequirements(
    classic,
    async (path) => {
      paths.push(path);
      return path.endsWith("page=1")
        ? Array.from({ length: 100 }, () => ({ type: "deletion" }))
        : [
            {
              type: "pull_request",
              parameters: {
                required_approving_review_count: 3,
                require_code_owner_review: true,
                required_review_thread_resolution: true,
                allowed_merge_methods: ["squash"],
              },
            },
            {
              type: "required_status_checks",
              parameters: {
                required_status_checks: [{ context: "inherited", integration_id: 123 }],
              },
            },
            { type: "merge_queue" },
          ];
    },
    scope,
    "release/one",
    10,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.complete, true);
  assert.equal(result.data.requiredApprovingReviewCount, 3);
  assert.equal(result.data.queueRequired, true);
  assert.deepEqual(result.data.requiredStatusCheckContexts, ["classic", "inherited"]);
  assert.deepEqual(result.data.allowedMergeMethods, ["squash"]);
  assert.equal(paths.length, 2);
  assert.ok(paths[0]!.includes("release%2Fone"));
});

const disabledClassic = {
  requiredStatusCheckContexts: [] as string[],
  requiredStatusChecks: [],
  requiredApprovingReviewCount: 0,
  requiresStatusChecks: false,
  requiresApprovingReviews: false,
  requiresLinearHistory: false,
  requiresCodeOwnerReviews: false,
  requiresConversationResolution: false,
};
for (const missing of [null, undefined]) {
  test(`disabled classic requirements normalize ${missing} exactly like zero and empty arrays`, async () => {
    const empty = await readPrBranchRequirements(disabledClassic, async () => [], scope, "main", 1);
    const nullable = await readPrBranchRequirements(
      {
        ...disabledClassic,
        requiredApprovingReviewCount: missing,
        requiredStatusCheckContexts: missing,
        requiredStatusChecks: missing,
      },
      async () => [],
      scope,
      "main",
      1,
    );
    assert.deepEqual(nullable, empty);
    assert.equal(
      requiredChecksFailure(nullable, { status: "available", data: [], complete: true }),
      null,
    );
  });
  for (const [field, flag] of [
    ["requiredApprovingReviewCount", "requiresApprovingReviews"],
    ["requiredStatusCheckContexts", "requiresStatusChecks"],
    ["requiredStatusChecks", "requiresStatusChecks"],
  ] as const) {
    for (const enabled of [true, false])
      test(`${field}=${missing} with ${flag}=${enabled} preserves evidence completeness`, async () => {
        const result = await readPrBranchRequirements(
          { ...disabledClassic, [field]: missing, [flag]: enabled },
          async () => [],
          scope,
          "main",
          1,
        );
        assert.equal(result.status, "available");
        if (result.status !== "available") return;
        assert.equal(result.complete, !enabled);
        assert.equal(
          requiredChecksFailure(result, { status: "available", data: [], complete: true })?.code ??
            null,
          enabled ? "requirements-unknown" : null,
        );
      });
  }
}

test("nullable parameters are normalized independently by their corresponding explicit disabled flag", async () => {
  for (const classic of [
    {
      ...disabledClassic,
      requiresApprovingReviews: true,
      requiredApprovingReviewCount: 2,
      requiredStatusCheckContexts: null,
      requiredStatusChecks: null,
    },
    { ...disabledClassic, requiresStatusChecks: true, requiredApprovingReviewCount: null },
  ]) {
    const result = await readPrBranchRequirements(classic, async () => [], scope, "main", 1);
    assert.equal(result.status, "available");
    if (result.status === "available") assert.equal(result.complete, true);
  }
});
for (const flag of ["requiresApprovingReviews", "requiresStatusChecks"] as const)
  for (const missing of [null, undefined])
    test(`${flag}=${missing} is unknown, never an explicit disabled flag`, async () => {
      const result = await readPrBranchRequirements(
        {
          ...disabledClassic,
          [flag]: missing,
          requiredApprovingReviewCount: null,
          requiredStatusCheckContexts: null,
          requiredStatusChecks: null,
        },
        async () => [],
        scope,
        "main",
        1,
      );
      assert.equal(result.status, "available");
      if (result.status === "available") assert.equal(result.complete, false);
    });
test("incomplete or unsupported active rules preserve known requirements without claiming clear", async () => {
  const partial = await readPrBranchRequirements(
    null,
    async () => Array.from({ length: 100 }, () => ({ type: "deletion" })),
    scope,
    "main",
    1,
  );
  assert.equal(partial.status, "available");
  if (partial.status === "available") assert.equal(partial.complete, false);
  const unsupported = await readPrBranchRequirements(
    null,
    async () => [
      {
        type: "required_deployments",
        parameters: { required_deployment_environments: ["production"] },
      },
    ],
    scope,
    "main",
    1,
  );
  assert.equal(unsupported.status, "available");
  if (unsupported.status === "available") {
    assert.equal(unsupported.complete, false);
    assert.deepEqual(unsupported.data.unsupportedRules, ["required_deployments"]);
  }
});
test("unknown completed conclusion and unavailable app identity are not success or proven failure", async () => {
  const requirements = await readPrBranchRequirements(
    null,
    async () => [
      {
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "test", integration_id: 1 }] },
      },
    ],
    scope,
    "main",
    1,
  );
  assert.equal(
    requiredChecksFailure(requirements, {
      status: "available",
      complete: true,
      data: [
        {
          id: "C",
          kind: "check-run",
          name: "test",
          status: "COMPLETED",
          conclusion: null,
          url: null,
          appId: 1,
        },
      ],
    })?.code,
    "required-checks-unknown",
  );
  assert.equal(
    requiredChecksFailure(requirements, {
      status: "available",
      complete: true,
      data: [
        {
          id: "C",
          kind: "check-run",
          name: "test",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          url: null,
          appId: null,
        },
      ],
    })?.code,
    "required-checks-unknown",
  );
});
