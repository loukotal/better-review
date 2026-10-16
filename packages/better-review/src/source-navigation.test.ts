import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { gitSourceRepository, resolveSourceNavigation } from "./source-navigation";

const head = "a".repeat(40),
  old = "b".repeat(40),
  base = "c".repeat(40);
const input = {
  path: "user-rent-config.ts",
  line: 76,
  ref: head,
  currentRef: head,
  allowedRefs: [head, old, base],
};
const contents: Record<string, Record<string, string>> = {
  [head]: {
    "functions/src/user-rent-config.ts": "one\ntwo\nthree\n",
    "src/new-name.ts": "new",
    "a/index.ts": "a",
    "b/index.ts": "b",
  },
  [old]: { "src/deleted.ts": "original\nprevious", "src/old-name.ts": "before rename" },
};
const repo = {
  files: async (ref: string) => Object.keys(contents[ref] ?? {}),
  read: async (ref: string, path: string) => contents[ref]?.[path] ?? null,
  renames: async () => [{ from: "src/old-name.ts", to: "src/new-name.ts" }],
};
test("unchanged full-repository basename/suffix lookup clamps stale lines with an approximation notice", async () => {
  const result = await resolveSourceNavigation(input, repo);
  assert.equal(result.status, "found");
  if (result.status !== "found") return;
  assert.equal(result.path, "functions/src/user-rent-config.ts");
  assert.equal(result.line, 3);
  assert.equal(result.approximate, true);
  assert.match(result.notice!, /Requested line 76/);
  const suffix = await resolveSourceNavigation(
    { ...input, path: "src/user-rent-config.ts", line: 2 },
    repo,
  );
  assert.equal(suffix.status === "found" && suffix.approximate, false);
});
test("original previous/deleted source stays at exact authorized ref and side", async () => {
  const result = await resolveSourceNavigation(
    { ...input, path: "src/deleted.ts", ref: old, side: "LEFT", line: 2 },
    repo,
  );
  assert.deepEqual(result, {
    status: "found",
    path: "src/deleted.ts",
    ref: old,
    side: "LEFT",
    content: "original\nprevious",
    line: 2,
    approximate: false,
    notice: null,
  });
});
test("deleted current path can show previous source read-only without inventing a current target", async () => {
  const result = await resolveSourceNavigation(
    { ...input, path: "src/deleted.ts", previousRef: old, line: 2 },
    repo,
  );
  assert.ok(
    result.status === "found" && result.ref === old && result.side === "LEFT" && result.approximate,
  );
  if (result.status === "found") assert.match(result.notice!, /previous\/deleted source/);
});
test("missing historical/unknown revision falls back explicitly to immutable reviewed source, never authorizes arbitrary refs", async () => {
  for (const ref of [old, "unknown", undefined]) {
    const reads: string[] = [];
    const result = await resolveSourceNavigation(
      { ...input, line: 2, ref, side: "LEFT" },
      {
        ...repo,
        files: async (ref) => {
          reads.push(ref);
          return repo.files(ref);
        },
      },
    );
    assert.equal(result.status, "found");
    if (result.status !== "found") continue;
    assert.equal(result.ref, head);
    assert.equal(result.side, "RIGHT");
    assert.equal(result.approximate, true);
    assert.match(result.notice!, /correspondence is approximate/);
    assert.ok(reads.every((ref) => input.allowedRefs.includes(ref)));
  }
});
test("rename mapping supports a changed basename but does not redirect accessible original source", async () => {
  const result = await resolveSourceNavigation(
    { ...input, path: "src/old-name.ts", line: 1 },
    repo,
  );
  assert.ok(result.status === "found" && result.path === "src/new-name.ts" && result.approximate);
  const historical = await resolveSourceNavigation(
    { ...input, path: "src/old-name.ts", ref: old, line: 1 },
    repo,
  );
  assert.ok(
    historical.status === "found" &&
      historical.path === "src/old-name.ts" &&
      !historical.approximate,
  );
});
test("stale directory paths can use a unique repository basename only with an approximation notice", async () => {
  const result = await resolveSourceNavigation(
    { ...input, path: "removed/directory/user-rent-config.ts", line: 2 },
    repo,
  );
  assert.ok(
    result.status === "found" &&
      result.path === "functions/src/user-rent-config.ts" &&
      result.approximate,
  );
  if (result.status === "found") assert.match(result.notice!, /unique repository basename/);
});
test("ambiguous repository paths require explicit choice; exact paths win", async () => {
  const ambiguous = await resolveSourceNavigation({ ...input, path: "index.ts" }, repo);
  assert.ok(ambiguous.status === "ambiguous");
  if (ambiguous.status === "ambiguous")
    assert.deepEqual(ambiguous.candidates, ["a/index.ts", "b/index.ts"]);
  const exact = await resolveSourceNavigation({ ...input, path: "b/index.ts", line: 1 }, repo);
  assert.ok(exact.status === "found" && exact.path === "b/index.ts");
});
test("same-revision stale-directory ambiguity is approximate before a candidate is chosen", async () => {
  const repository = {
    ...repo,
    files: async () => ["a/config.ts", "b/config.ts"],
    renames: async () => [],
  };
  const result = await resolveSourceNavigation(
    { ...input, path: "removed/config.ts", line: 2, side: "RIGHT" },
    repository,
  );
  assert.ok(result.status === "ambiguous");
  if (result.status !== "ambiguous") return;
  assert.deepEqual(result.candidates, ["a/config.ts", "b/config.ts"]);
  assert.equal(result.ref, head);
  assert.equal(result.side, "RIGHT");
  assert.equal(
    result.approximate,
    true,
    "Basename-only fallback stays approximate even with multiple candidates at the SAME revision",
  );
  assert.match(result.notice, /basename.*approximate/s);
  // A genuine suffix match at the same ref is not a relocated-directory fallback.
  const suffix = await resolveSourceNavigation({ ...input, path: "config.ts" }, repository);
  assert.ok(suffix.status === "ambiguous" && !suffix.approximate);
});
test("missing historical LEFT ambiguity carries the resolved current RIGHT side and approximation", async () => {
  const result = await resolveSourceNavigation(
    { ...input, path: "index.ts", ref: old, side: "LEFT" },
    repo,
  );
  assert.ok(
    result.status === "ambiguous" &&
      result.ref === head &&
      result.side === "RIGHT" &&
      result.approximate,
  );
  if (result.status === "ambiguous") assert.match(result.notice, /approximate/);
});
test("unsafe references never reach Git lookup", async () => {
  for (const path of [
    "../secret",
    "/etc/passwd",
    "src/../secret",
    "a\\b.ts",
    "a.ts\0",
    "a.ts?x",
    "a.ts:other",
  ]) {
    await assert.rejects(
      resolveSourceNavigation(
        { ...input, path },
        {
          ...repo,
          files: async () => {
            throw new Error("must not read git");
          },
        },
      ),
      /Unsafe/,
    );
  }
});
test("Git adapter enumerates full immutable tree and reads an unchanged file without checkout mutation", async () => {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const ref = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const repository = gitSourceRepository(root);
  assert.ok((await repository.files(ref)).includes("packages/web/package.json"));
  const result = await resolveSourceNavigation(
    { path: "packages/web/package.json", ref, currentRef: ref, allowedRefs: [ref], line: 1 },
    repository,
  );
  assert.ok(result.status === "found" && result.content.includes('"name"') && result.ref === ref);
});
