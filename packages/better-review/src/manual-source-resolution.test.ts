import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import type { ReviewSessionDiffVariant } from "@better-review/shared";

import {
  resolveManualSource,
  type ManualSourceDependencies,
  type ManualSourceInput,
} from "./manual-source-resolution";

type Source = NonNullable<ReviewSessionDiffVariant["contentSource"]>;
const url = "https://github.com/owner/repo/pull/1";
function input(source?: Source): ManualSourceInput {
  return {
    session: {
      repoRoot: "/repo",
      cwd: "/cwd",
      payload: {
        kind: "diff",
        rawPatch: "",
        variants: [{ id: "selected", label: "Selected", rawPatch: "", contentSource: source }],
      },
    },
    prUrl: url,
    sessionScope: { mode: "full", commitSha: null },
    filePath: "new.ts",
    prevPath: "old.ts",
    variantId: "selected",
  };
}
function fixture() {
  const calls: unknown[][] = [];
  const deps: ManualSourceDependencies = {
    git: async (args) => {
      calls.push(["git", ...args]);
      return { stdout: "", exitCode: 1 };
    },
    readFile: async (absolute) => {
      calls.push(["worktree", absolute]);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    prRefs: async (pr) => {
      calls.push(["refs", pr]);
      return ["pr-base", "pr-head"];
    },
    prInfo: async (pr) => {
      calls.push(["info", pr]);
      return { owner: "owner", repo: "repo" };
    },
    remoteContent: async (request) => {
      calls.push(["remote", request]);
      return `remote:${request.ref}:${request.path}`;
    },
  };
  return { calls, deps };
}
const gitCall = (ref: string, file: string, root = "/repo") => [
  "git",
  "-C",
  root,
  "show",
  `${ref}:${file}`,
];

for (const row of [
  {
    source: { kind: "working-tree", baseSha: "base" },
    label: "local-working-tree",
    old: "base:old.ts",
    next: "worktree",
    calls: [gitCall("base", "old.ts"), ["worktree", "/repo/new.ts"]],
  },
  {
    source: { kind: "unstaged", headSha: "ignored" },
    label: "local-unstaged",
    old: ":old.ts",
    next: "worktree",
    calls: [gitCall("", "old.ts"), ["worktree", "/repo/new.ts"]],
  },
  {
    source: { kind: "staged", headSha: "head" },
    label: "local-staged",
    old: "head:old.ts",
    next: ":new.ts",
    calls: [gitCall("head", "old.ts"), gitCall("", "new.ts")],
  },
  {
    source: { kind: "commit", baseSha: "base", headSha: "head" },
    label: "local-git",
    old: "base:old.ts",
    next: "head:new.ts",
    calls: [gitCall("base", "old.ts"), gitCall("head", "new.ts")],
  },
  {
    source: { kind: "git-refs", baseSha: "base", headSha: "head" },
    label: "local-git",
    old: "base:old.ts",
    next: "head:new.ts",
    calls: [gitCall("base", "old.ts"), gitCall("head", "new.ts")],
  },
] satisfies { source: Source; label: string; old: string; next: string; calls: unknown[][] }[]) {
  test(`${row.source.kind}: exact local pair, rename paths and label without fallback requests`, async () => {
    const { calls, deps } = fixture();
    deps.git = async (args) => {
      calls.push(["git", ...args]);
      return { stdout: args.at(-1)!, exitCode: 0 };
    };
    deps.readFile = async (absolute) => {
      calls.push(["worktree", absolute]);
      return "worktree";
    };
    assert.deepEqual(await resolveManualSource(input(row.source), deps), {
      oldContent: row.old,
      newContent: row.next,
      source: row.label,
    });
    assert.deepEqual(calls, row.calls);
  });
}

test("matching explicit variant beats parsed range; nonmatching and non-diff payloads do not", async () => {
  const value = input({ kind: "unstaged" });
  const variantId = "commit-range:abcdef0:1234567";
  value.variantId = variantId;
  if (value.session.payload.kind === "diff") value.session.payload.variants![0]!.id = variantId;
  const { deps, calls } = fixture();
  deps.git = async (args) => {
    calls.push(["git", ...args]);
    return { stdout: "git", exitCode: 0 };
  };
  assert.equal((await resolveManualSource(value, deps))?.source, "local-unstaged");
  assert.deepEqual(calls, [gitCall("", "old.ts"), ["worktree", "/repo/new.ts"]]);
  calls.length = 0;
  value.variantId += ":accepted-trailing-fields";
  assert.equal((await resolveManualSource(value, deps))?.source, "local-git");
  assert.deepEqual(calls, [gitCall("abcdef0", "old.ts"), gitCall("1234567", "new.ts")]);
  calls.length = 0;
  value.session.payload = { kind: "message", content: "" };
  assert.equal((await resolveManualSource(value, deps))?.source, "local-git");
});

test("an unrecognized stored source kind retains the existing PR-ref fallback", async () => {
  const { deps, calls } = fixture();
  const value = input();
  if (value.session.payload.kind === "diff") {
    Reflect.set(value.session.payload.variants![0]!, "contentSource", { kind: "future-source" });
  }
  assert.equal((await resolveManualSource(value, deps))?.source, "github");
  assert.deepEqual(calls.slice(0, 3), [
    ["refs", url],
    gitCall("pr-base", "old.ts"),
    gitCall("pr-head", "new.ts"),
  ]);
});

for (const [variantId, accepted] of [
  ["commit-range:ABCDEF0:1234567", true],
  [`commit-range:${"a".repeat(40)}:${"b".repeat(40)}`, true],
  ["commit-range:abcdef:1234567", false],
  [`commit-range:${"a".repeat(41)}:1234567`, false],
  ["commit-range:abcdefg:1234567", false],
  ["commit-range::1234567", false],
  ["commit-range:abcdef0:", false],
  ["Commit-range:abcdef0:1234567", false],
  ["", false],
] as const) {
  test(`range variant acceptance remains ${accepted}: ${variantId}`, async () => {
    const { deps, calls } = fixture();
    const value = { ...input(), variantId, prUrl: null };
    deps.git = async (args) => {
      calls.push(["git", ...args]);
      return { stdout: "", exitCode: 0 };
    };
    const result = await resolveManualSource(value, deps);
    assert.equal(result?.source, accepted ? "local-git" : undefined);
    assert.equal(calls.length, accepted ? 2 : 0);
  });
}

for (const available of ["old", "new"] as const) {
  test(`empty ${available} content retains the entire local pair, never remote-fills its missing side`, async () => {
    const { deps, calls } = fixture();
    deps.git = async (args) => {
      calls.push(["git", ...args]);
      return {
        stdout: "",
        exitCode: args.at(-1) === `${available === "old" ? "base:old" : "head:new"}.ts` ? 0 : 1,
      };
    };
    assert.deepEqual(
      await resolveManualSource(input({ kind: "commit", baseSha: "base", headSha: "head" }), deps),
      {
        oldContent: available === "old" ? "" : null,
        newContent: available === "new" ? "" : null,
        source: "local-git",
      },
    );
    assert.deepEqual(calls, [gitCall("base", "old.ts"), gitCall("head", "new.ts")]);
  });
}

for (const headSha of [undefined, null, ""] as const) {
  test(`staged missing head ${String(headSha)} reads only the index and preserves null old content`, async () => {
    const { deps, calls } = fixture();
    deps.git = async (args) => {
      calls.push(["git", ...args]);
      return { stdout: "", exitCode: 0 };
    };
    assert.deepEqual(await resolveManualSource(input({ kind: "staged", headSha }), deps), {
      oldContent: null,
      newContent: "",
      source: "local-staged",
    });
    assert.deepEqual(calls, [gitCall("", "new.ts")]);
  });
}

test("explicit refs beat session/PR refs; failed explicit local pair is retried as the local fallback before remote", async () => {
  const { deps, calls } = fixture();
  const value = input({ kind: "commit", baseSha: "explicit-base", headSha: "explicit-head" });
  value.sessionScope = { mode: "commit", commitSha: "session-commit" };
  assert.deepEqual(await resolveManualSource(value, deps), {
    oldContent: "remote:explicit-base:old.ts",
    newContent: "remote:explicit-head:new.ts",
    source: "github",
  });
  assert.deepEqual(calls, [
    gitCall("explicit-base", "old.ts"),
    gitCall("explicit-head", "new.ts"),
    gitCall("explicit-base", "old.ts"),
    gitCall("explicit-head", "new.ts"),
    ["info", url],
    ["remote", { owner: "owner", repo: "repo", path: "old.ts", ref: "explicit-base" }],
    ["remote", { owner: "owner", repo: "repo", path: "new.ts", ref: "explicit-head" }],
  ]);
});

test("failed mutable variant falls back to session parent/current, never the session branch or PR refs", async () => {
  const { deps, calls } = fixture();
  const value = input({ kind: "working-tree", baseSha: "work-base" });
  value.sessionScope = { mode: "commit", commitSha: "session-commit" };
  deps.git = async (args) => {
    calls.push(["git", ...args]);
    return {
      stdout: "",
      exitCode: args.at(-1) === "session-commit^:old.ts" ? 0 : 1,
    };
  };
  assert.deepEqual(await resolveManualSource(value, deps), {
    oldContent: "",
    newContent: null,
    source: "local",
  });
  assert.deepEqual(calls, [
    gitCall("work-base", "old.ts"),
    ["worktree", "/repo/new.ts"],
    gitCall("session-commit^", "old.ts"),
    gitCall("session-commit", "new.ts"),
  ]);
});

test("PR base/head fallback tries a whole local pair before remote info/content", async () => {
  const { deps, calls } = fixture();
  const result = await resolveManualSource(input(), deps);
  assert.equal(result?.source, "github");
  assert.deepEqual(calls.slice(0, 4), [
    ["refs", url],
    gitCall("pr-base", "old.ts"),
    gitCall("pr-head", "new.ts"),
    ["info", url],
  ]);
  assert.equal(calls.length, 6);
});

test("repoRoot and prevPath use nullish semantics, not truthiness", async () => {
  const { deps, calls } = fixture();
  const value = input({ kind: "unstaged" });
  value.prevPath = "";
  deps.readFile = async (absolute) => {
    calls.push(["worktree", absolute]);
    return "";
  };
  assert.deepEqual(await resolveManualSource(value, deps), {
    oldContent: null,
    newContent: "",
    source: "local-unstaged",
  });
  assert.deepEqual(calls, [["worktree", "/repo/new.ts"]]);
  calls.length = 0;
  value.session.repoRoot = "";
  const result = await resolveManualSource(value, deps);
  assert.equal(result?.source, "github");
  assert.deepEqual(calls, [
    ["refs", url],
    ["info", url],
    ["remote", { owner: "owner", repo: "repo", path: "", ref: "pr-base" }],
    ["remote", { owner: "owner", repo: "repo", path: "new.ts", ref: "pr-head" }],
  ]);
  calls.length = 0;
  value.session.repoRoot = undefined;
  assert.equal((await resolveManualSource(value, deps))?.source, "local-unstaged");
  assert.deepEqual(calls, [["worktree", "/cwd/new.ts"]]);
  calls.length = 0;
  Reflect.set(value.session, "repoRoot", null);
  assert.equal((await resolveManualSource(value, deps))?.source, "local-unstaged");
  assert.deepEqual(calls, [["worktree", "/cwd/new.ts"]]);
});

for (const filePath of [
  "../escape",
  "a/../../escape",
  "..\\escape",
  "/absolute",
  ".",
  "",
  "bad\0path",
]) {
  test(`unsafe local path ${JSON.stringify(filePath)} performs no Git/index/worktree access`, async () => {
    for (const source of [
      { kind: "working-tree", baseSha: "base" },
      { kind: "unstaged" },
      { kind: "staged", headSha: "head" },
    ] satisfies Source[]) {
      const { deps, calls } = fixture();
      const value = { ...input(source), filePath, prevPath: filePath, prUrl: null };
      assert.equal(await resolveManualSource(value, deps), undefined);
      assert.deepEqual(calls, []);
    }
  });
}

test("safe normalized paths retain original Git arguments and contained worktree resolution", async () => {
  const { deps, calls } = fixture();
  const value = {
    ...input({ kind: "working-tree", baseSha: "base" }),
    filePath: "dir/../file with space.ts",
    prevPath: "renamed old.ts",
  };
  deps.readFile = async (absolute) => {
    calls.push(["worktree", absolute]);
    return "file";
  };
  await resolveManualSource(value, deps);
  assert.deepEqual(calls, [
    gitCall("base", "renamed old.ts"),
    ["worktree", path.resolve("/repo", value.filePath)],
  ]);
});

test("non-ENOENT worktree and thrown Git errors propagate rather than invoking remote fallback", async () => {
  for (const kind of ["worktree", "git"] as const) {
    const { deps, calls } = fixture(),
      failure = new Error(`${kind} unavailable`);
    if (kind === "worktree")
      deps.readFile = async () => {
        throw Object.assign(failure, { code: "EACCES" });
      };
    else
      deps.git = async () => {
        throw failure;
      };
    await assert.rejects(
      resolveManualSource(input({ kind: "working-tree", baseSha: "base" }), deps),
      (error) => error === failure,
    );
    assert.ok(!calls.some((call) => call[0] === "refs" || call[0] === "remote"));
  }
});

test("remote ref/info errors propagate; independent content failures become null, including both missing", async () => {
  for (const port of ["prRefs", "prInfo"] as const) {
    const { deps } = fixture(),
      failure = new Error(port);
    deps[port] = async () => {
      throw failure;
    };
    await assert.rejects(resolveManualSource(input(), deps), (error) => error === failure);
  }
  for (const failed of ["old", "new", "both"] as const) {
    const { deps, calls } = fixture();
    deps.remoteContent = async (request) => {
      calls.push(["remote", request]);
      if (failed === "both" || request.path === `${failed}.ts`) throw new Error("remote missing");
      return "";
    };
    assert.deepEqual(await resolveManualSource(input(), deps), {
      oldContent: failed === "old" || failed === "both" ? null : "",
      newContent: failed === "new" || failed === "both" ? null : "",
      source: "github",
    });
    assert.equal(calls.filter((call) => call[0] === "remote").length, 2);
  }
});

test("both local sides start together and fallback waits for the entire pair", async () => {
  const { deps, calls } = fixture();
  const releases: Array<(result: { stdout: string; exitCode: number }) => void> = [];
  deps.git = (args) => {
    calls.push(["git", ...args]);
    return new Promise((resolve) => releases.push(resolve));
  };
  const resolving = resolveManualSource(input(), deps);
  await Promise.resolve();
  assert.equal(releases.length, 2);
  releases[0]!({ stdout: "", exitCode: 1 });
  await Promise.resolve();
  assert.equal(
    calls.some((call) => call[0] === "info"),
    false,
  );
  releases[1]!({ stdout: "", exitCode: 1 });
  assert.equal((await resolving)?.source, "github");
});

test("remote pair starts together and independently settles a failed side without early response", async () => {
  const { deps, calls } = fixture();
  const value = input();
  delete value.session.repoRoot;
  delete value.session.cwd;
  let started!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const releases: Array<(content: string | null) => void> = [];
  deps.remoteContent = (request) => {
    calls.push(["remote", request]);
    return new Promise<string | null>((resolve) => {
      releases.push(resolve);
      if (releases.length === 2) started();
    }).then((content) => {
      if (content === null) throw new Error("missing side");
      return content;
    });
  };
  let settled = false;
  const resolving = resolveManualSource(value, deps).then((result) => {
    settled = true;
    return result;
  });
  await bothStarted;
  releases[0]!(null);
  await Promise.resolve();
  assert.equal(settled, false);
  releases[1]!("");
  assert.deepEqual(await resolving, { oldContent: null, newContent: "", source: "github" });
  assert.equal(calls.filter((call) => call[0] === "remote").length, 2);
});

test("no refs/context is unresolved, while commit scope can resolve locally without a PR", async () => {
  const { deps, calls } = fixture(),
    value = { ...input(), prUrl: null };
  assert.equal(await resolveManualSource(value, deps), undefined);
  assert.equal(calls.length, 0);
  value.sessionScope = { mode: "commit", commitSha: "current" };
  deps.git = async (args) => {
    calls.push(["git", ...args]);
    return { stdout: "", exitCode: 0 };
  };
  assert.deepEqual(await resolveManualSource(value, deps), {
    oldContent: "",
    newContent: "",
    source: "local",
  });
  assert.deepEqual(calls, [gitCall("current^", "old.ts"), gitCall("current", "new.ts")]);
});
