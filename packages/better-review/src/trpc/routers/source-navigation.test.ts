import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import test, { type TestContext } from "node:test";

import { Effect } from "effect";

import { PrCheckoutService } from "../../pr-checkout";
import { PrReviewSessionService, type PrReviewSession } from "../../pr-review-sessions";
import { runtime } from "../../runtime";
import { prepareSessionCheckout } from "../../session-checkout";
import { STORE_BASE_DIR } from "../../store";
import { prReviewRouter } from "./pr-review";

test("source navigation RPC searches the entire immutable repository, discloses fallback, and rejects traversal before session lookup", async (t) => {
  const worktreePath = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  let lookups = 0;
  const session = {
    runtimeVersion: 3,
    id: "source-rpc",
    prUrl: "https://github.com/source-test/source-test/pull/1",
    owner: "source-test",
    repo: "source-test",
    number: 1,
    headSha,
    baseSha: headSha,
    reviewMode: "full",
    commitSha: null,
    worktreePath,
    files: ["only-changed-file.ts"],
    createdAt: 1,
    updatedAt: 1,
  } satisfies PrReviewSession;
  const store = {
    get: () =>
      Effect.sync(() => {
        lookups++;
        return session;
      }),
  } as unknown as PrReviewSessionService;
  t.mock.method(runtime, "runPromise", <A>(effect: Effect.Effect<A, unknown, unknown>) =>
    Effect.runPromise(
      effect.pipe(Effect.provideService(PrReviewSessionService, store)) as Effect.Effect<
        A,
        unknown
      >,
    ),
  );
  const caller = prReviewRouter.createCaller({
    gh: null,
    opencode: null,
    diffCache: null,
    prContext: null,
  });
  const result = await caller.navigateSource({
    sessionId: session.id,
    path: "web/package.json",
    ref: "unavailable-history",
    line: 99999,
  });
  assert.equal(result.status, "found");
  if (result.status !== "found") return;
  assert.equal(result.path, "packages/web/package.json");
  assert.equal(result.ref, headSha);
  assert.equal(result.approximate, true);
  assert.match(result.notice!, /approximate/);
  assert.ok(result.line < 99999);
  assert.ok(result.content.includes('"name"'));
  const before = lookups;
  await assert.rejects(
    caller.navigateSource({ sessionId: session.id, path: "../secret" }),
    /Unsafe/,
  );
  assert.equal(lookups, before);
});

/** Construct immutable Git objects only: no branch/ref updates or workspace commits. */
async function sourceFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const cacheRoot = join(STORE_BASE_DIR, "git-cache", "github");
  await mkdir(cacheRoot, { recursive: true });
  const ownerRoot = await mkdtemp(join(cacheRoot, "source-rpc-test-"));
  t.after(() => rm(ownerRoot, { recursive: true, force: true }));
  const path = join(ownerRoot, "repo.git");
  execFileSync("git", ["init", "--bare", path], { stdio: "pipe" });
  const git = (args: string[], input?: string) =>
    execFileSync("git", ["-C", path, ...args], { encoding: "utf8", input }).trim();
  const commit = (files: Record<string, string>, parents: string[] = []) => {
    const entries = Object.entries(files)
      .sort()
      .map(
        ([name, content]) =>
          `100644 blob ${git(["hash-object", "-w", "--stdin"], content)}\t${name}\n`,
      )
      .join("");
    const tree = git(["mktree"], entries);
    return git(
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      `tree ${tree}\n${parents.map((parent) => `parent ${parent}\n`).join("")}author Source Test <test@example.invalid> 1700000000 +0000\ncommitter Source Test <test@example.invalid> 1700000000 +0000\n\nfixture\n`,
    );
  };
  const base = commit({ "changed.ts": "base contents" });
  const parent = commit(
    { "changed.ts": "parent contents", "introduced.ts": "introduced after base" },
    [base],
  );
  const head = commit({}, [parent]);
  const baseTip = commit({ "changed.ts": "unrelated base tip contents" }, [base]);
  return { path, owner: basename(ownerRoot), git, commit, base, parent, head, baseTip, ownerRoot };
}

function sourceCaller(
  t: TestContext,
  initial: PrReviewSession,
  prepare?: () => Promise<{ worktreePath: string; repoAccess: PrReviewSession["repoAccess"] }>,
) {
  let session = initial;
  const store = {
    get: () => Effect.succeed(session),
    save: (updated: PrReviewSession) =>
      Effect.sync(() => {
        session = updated;
      }),
  } as unknown as PrReviewSessionService;
  const checkout = {
    prepare: () =>
      Effect.tryPromise(
        prepare ??
          (async () => {
            throw new Error("Unexpected checkout preparation");
          }),
      ),
  } as unknown as PrCheckoutService;
  t.mock.method(runtime, "runPromise", <A>(effect: Effect.Effect<A, unknown, unknown>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(PrReviewSessionService, store),
        Effect.provideService(PrCheckoutService, checkout),
      ) as Effect.Effect<A, unknown>,
    ),
  );
  return prReviewRouter.createCaller({
    gh: null,
    opencode: null,
    diffCache: null,
    prContext: null,
  });
}

test("RPC uses selected commit parent for changed-then-deleted and introduced-then-deleted source; deleted worktree uses surviving cache", async (t) => {
  const fixture = await sourceFixture(t);
  const session: PrReviewSession = {
    runtimeVersion: 3,
    id: `commit-${fixture.owner}`,
    owner: fixture.owner,
    repo: "repo",
    prUrl: "https://github.com/test/repo/pull/1",
    number: 1,
    headSha: fixture.head,
    commitSha: fixture.head,
    baseSha: fixture.baseTip,
    reviewMode: "commit",
    worktreePath: join(fixture.ownerRoot, "deleted-worktree"),
    files: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const caller = sourceCaller(t, session);
  for (const [path, expected] of [
    ["changed.ts", "parent contents"],
    ["introduced.ts", "introduced after base"],
  ]) {
    const result = await caller.navigateSource({
      sessionId: session.id,
      path,
      ref: fixture.head,
      line: 1,
    });
    assert.ok(result.status === "found", `${path}: expected deleted comparison source`);
    if (result.status !== "found") continue;
    assert.equal(result.content, expected);
    assert.equal(result.ref, fixture.parent);
    assert.equal(result.side, "LEFT");
    const explicit = await caller.navigateSource({
      sessionId: session.id,
      path,
      ref: fixture.parent,
      side: "LEFT",
      line: 1,
    });
    assert.ok(
      explicit.status === "found" && explicit.ref === fixture.parent && !explicit.approximate,
    );
  }
});

test("RPC full-PR comparison uses merge-base, not newer unrelated PR base tip", async (t) => {
  const fixture = await sourceFixture(t);
  const session: PrReviewSession = {
    runtimeVersion: 3,
    id: `full-${fixture.owner}`,
    owner: fixture.owner,
    repo: "repo",
    prUrl: "https://github.com/test/repo/pull/1",
    number: 1,
    headSha: fixture.head,
    commitSha: null,
    baseSha: fixture.baseTip,
    reviewMode: "full",
    worktreePath: join(fixture.ownerRoot, "deleted-worktree"),
    files: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const caller = sourceCaller(t, session);
  const result = await caller.navigateSource({
    sessionId: session.id,
    path: "changed.ts",
    ref: fixture.head,
    line: 1,
  });
  assert.ok(result.status === "found");
  if (result.status === "found") {
    assert.equal(result.content, "base contents");
    assert.equal(result.ref, fixture.base);
    assert.equal(result.side, "LEFT");
  }
  const unrelated = await caller.navigateSource({
    sessionId: session.id,
    path: "changed.ts",
    ref: fixture.baseTip,
    side: "LEFT",
    line: 1,
  });
  assert.ok(
    unrelated.status === "found" &&
      unrelated.ref === fixture.base &&
      unrelated.approximate &&
      unrelated.content === "base contents",
    "Unrelated base tip must not be authorized as exact comparison source",
  );
});

test("RPC existing cache without current commit awaits checkout preparation instead of false missing", async (t) => {
  const fixture = await sourceFixture(t);
  const ready = join(fixture.ownerRoot, "ready.git");
  execFileSync("git", ["clone", "--bare", fixture.path, ready], { stdio: "pipe" });
  // The ready repository gets a new immutable object absent from the existing cache.
  const blob = execFileSync("git", ["-C", ready, "hash-object", "-w", "--stdin"], {
    input: "prepared source",
    encoding: "utf8",
  }).trim();
  const tree = execFileSync("git", ["-C", ready, "mktree"], {
    input: `100644 blob ${blob}\tready.ts\n`,
    encoding: "utf8",
  }).trim();
  const current = execFileSync(
    "git",
    ["-C", ready, "hash-object", "-t", "commit", "-w", "--stdin"],
    {
      input: `tree ${tree}\nparent ${fixture.head}\nauthor Test <test@example.invalid> 1700000000 +0000\ncommitter Test <test@example.invalid> 1700000000 +0000\n\nready\n`,
      encoding: "utf8",
    },
  ).trim();
  const session: PrReviewSession = {
    runtimeVersion: 3,
    id: `preparing-${fixture.owner}`,
    owner: fixture.owner,
    repo: "repo",
    prUrl: "https://github.com/test/repo/pull/1",
    number: 1,
    headSha: current,
    commitSha: current,
    baseSha: fixture.base,
    reviewMode: "commit",
    worktreePath: join(fixture.ownerRoot, "pending-worktree"),
    files: [],
    createdAt: 1,
    updatedAt: 1,
  };
  let preparations = 0,
    release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const caller = sourceCaller(t, session, async () => {
    preparations++;
    await barrier;
    return {
      worktreePath: ready,
      repoAccess: {
        checkedAt: 1,
        trackedFileCount: 1,
        sampledFiles: ["ready.ts"],
        sparseCheckout: false,
      },
    };
  });
  let settled = false;
  const request = caller
    .navigateSource({ sessionId: session.id, path: "ready.ts", ref: current, line: 1 })
    .finally(() => {
      settled = true;
    });
  for (let i = 0; i < 200 && !preparations && !settled; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  try {
    assert.equal(preparations, 1);
    assert.equal(settled, false, "RPC must wait for the preparation it needs");
  } finally {
    release();
  }
  const result = await request;
  assert.ok(
    result.status === "found" && result.ref === current && result.content === "prepared source",
  );
  assert.equal(preparations, 1);
});

test("RPC joins already-running source preparation when its cache lacks the current commit", async (t) => {
  const fixture = await sourceFixture(t);
  // Empty but valid cache, with the immutable objects held only in the pending result.
  const ready = join(fixture.ownerRoot, "ready.git");
  execFileSync("git", ["clone", "--bare", fixture.path, ready], { stdio: "pipe" });
  await rm(join(fixture.path, "objects"), { recursive: true, force: true });
  await mkdir(join(fixture.path, "objects"));
  const session: PrReviewSession = {
    runtimeVersion: 3,
    id: `pending-${fixture.owner}`,
    owner: fixture.owner,
    repo: "repo",
    prUrl: "https://github.com/test/repo/pull/1",
    number: 1,
    headSha: fixture.parent,
    commitSha: fixture.parent,
    baseSha: fixture.baseTip,
    reviewMode: "commit",
    worktreePath: join(fixture.ownerRoot, "pending-worktree"),
    files: [],
    createdAt: 1,
    updatedAt: 1,
  };
  let preparations = 0,
    release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const caller = sourceCaller(t, session, async () => {
    preparations++;
    await barrier;
    return {
      worktreePath: ready,
      repoAccess: {
        checkedAt: 1,
        trackedFileCount: 1,
        sampledFiles: ["changed.ts"],
        sparseCheckout: false,
      },
    };
  });
  const preparing = prepareSessionCheckout(session.id);
  let settled = false;
  const request = caller
    .navigateSource({ sessionId: session.id, path: "changed.ts", ref: fixture.parent, line: 1 })
    .finally(() => {
      settled = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    assert.equal(preparations, 1);
    assert.equal(settled, false);
  } finally {
    release();
  }
  await preparing;
  const result = await request;
  assert.ok(
    result.status === "found" &&
      result.ref === fixture.parent &&
      result.content === "parent contents",
  );
  assert.equal(preparations, 1, "Source RPC should join existing preparation, not start another");
});

test("RPC repository failures surface retryable errors rather than false source missing", async (t) => {
  const fixture = await sourceFixture(t);
  // A directory which is not a Git repository is an operational failure, not a missing path.
  await rm(fixture.path, { recursive: true, force: true });
  await mkdir(fixture.path);
  const session: PrReviewSession = {
    runtimeVersion: 3,
    id: `broken-${fixture.owner}`,
    owner: fixture.owner,
    repo: "repo",
    prUrl: "https://github.com/test/repo/pull/1",
    number: 1,
    headSha: fixture.head,
    commitSha: fixture.head,
    baseSha: fixture.base,
    reviewMode: "commit",
    worktreePath: join(fixture.ownerRoot, "deleted-worktree"),
    files: [],
    createdAt: 1,
    updatedAt: 1,
  };
  await assert.rejects(
    sourceCaller(t, session).navigateSource({
      sessionId: session.id,
      path: "changed.ts",
      ref: fixture.head,
    }),
    /readiness check failed.*Retry/s,
  );
});

test("RPC unreadable Git tree is a retryable source error, not an empty repository", async (t) => {
  const fixture = await sourceFixture(t);
  const broken = fixture.git(
    ["hash-object", "-t", "commit", "-w", "--stdin"],
    `tree ${"1".repeat(40)}\nparent ${fixture.head}\nauthor Test <test@example.invalid> 1700000000 +0000\ncommitter Test <test@example.invalid> 1700000000 +0000\n\nbroken tree fixture\n`,
  );
  const session: PrReviewSession = {
    runtimeVersion: 3,
    id: `broken-tree-${fixture.owner}`,
    owner: fixture.owner,
    repo: "repo",
    prUrl: "https://github.com/test/repo/pull/1",
    number: 1,
    headSha: broken,
    commitSha: broken,
    baseSha: fixture.base,
    reviewMode: "commit",
    worktreePath: join(fixture.ownerRoot, "deleted-worktree"),
    files: [],
    createdAt: 1,
    updatedAt: 1,
  };
  await assert.rejects(
    sourceCaller(t, session).navigateSource({
      sessionId: session.id,
      path: "changed.ts",
      ref: broken,
    }),
    /Source repository read failed \(ls-tree\).*Retry/s,
  );
});
