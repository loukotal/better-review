import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  gitSourceRepository,
  resolveSourceNavigation,
  SourceNavigationCache,
} from "./source-navigation";

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

test("line ranges are opt-in, absolute, bounded, and preserve original revision/side provenance", async () => {
  const result = await resolveSourceNavigation(
    {
      ...input,
      path: "src/deleted.ts",
      ref: old,
      side: "LEFT",
      line: 2,
      range: { startLine: 2, endLine: 20 },
    },
    repo,
  );
  assert.deepEqual(result, {
    status: "found",
    path: "src/deleted.ts",
    ref: old,
    side: "LEFT",
    content: "previous",
    line: 2,
    totalLines: 2,
    contentStartLine: 2,
    contentEndLine: 2,
    approximate: false,
    notice: null,
  });
  for (const content of ["", "one\n", "one\r\ntwo\r\n", "one\ntwo"]) {
    const ranged = await resolveSourceNavigation(
      { ...input, line: 1, range: { startLine: 1, endLine: 1 } },
      { ...repo, read: async () => content },
    );
    assert.ok(ranged.status === "found");
    if (ranged.status === "found") {
      assert.equal(ranged.contentStartLine, 1);
      assert.equal(ranged.contentEndLine, 1);
      assert.equal(
        ranged.content,
        content.includes("\n") ? content.slice(0, content.indexOf("\n") + 1) : content,
      );
    }
  }
  for (const range of [
    { startLine: 0, endLine: 1 },
    { startLine: 2, endLine: 1 },
    { startLine: 1, endLine: 2001 },
  ])
    await assert.rejects(resolveSourceNavigation({ ...input, range }, repo), /between 1 and 2000/);
});

test("cache coalesces loads and distinguishes cancellation from shared failures; retries failures", async () => {
  const cache = new SourceNavigationCache();
  let loads = 0;
  let release!: (value: string) => void;
  const load = () => {
    loads++;
    return new Promise<string>((resolve) => {
      release = resolve;
    });
  };
  const controller = new AbortController();
  const first = cache.get("blob", load, controller.signal);
  const second = cache.get("blob", load);
  controller.abort();
  await assert.rejects(first, { name: "AbortError" });
  release("content");
  assert.equal(await second, "content");
  assert.equal(await cache.get("blob", load), "content");
  assert.equal(loads, 1);
  let failures = 0;
  const fail = async () => {
    failures++;
    throw new Error("Git failure");
  };
  await Promise.all([
    assert.rejects(cache.get("broken", fail), /Git failure/),
    assert.rejects(cache.get("broken", fail), /Git failure/),
  ]);
  assert.equal(failures, 1);
  await assert.rejects(cache.get("broken", fail), /Git failure/);
  assert.equal(failures, 2);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(cache.get("never-start", load, aborted.signal), { name: "AbortError" });
  assert.equal(loads, 1);
});

test("an aborted sole waiter does not discard a successful cold load or cache a failed one", async () => {
  const cache = new SourceNavigationCache();
  for (const fails of [false, true]) {
    const controller = new AbortController();
    let finish!: () => void;
    let loads = 0;
    const load = () => {
      loads++;
      return new Promise<string>((resolve, reject) => {
        finish = () => (fails ? reject(new Error("cold failure")) : resolve("ready"));
      });
    };
    const key = String(fails);
    const waiter = cache.get(key, load, controller.signal);
    controller.abort();
    await assert.rejects(waiter, { name: "AbortError" });
    finish();
    // Joining immediately also checks settlement/removal races in the registry.
    if (fails) await assert.rejects(cache.get(key, load), /cold failure/);
    else assert.equal(await cache.get(key, load), "ready");
    assert.equal(
      await cache.get(key, async () => {
        loads++;
        return "retry";
      }),
      fails ? "retry" : "ready",
    );
    assert.equal(loads, fails ? 2 : 1);
  }
});

test("range boundaries retain exact bytes and absolute offsets for empty, unicode, binary and newline variants", async () => {
  for (const content of ["", "\n", "\n\n", "😀\r\nβ\r\n", "😀\nβ", "zero\0byte\nlast\n"]) {
    const lines = content.split("\n");
    const count = Math.max(1, lines.length - (content.endsWith("\n") ? 1 : 0));
    for (const requested of [1, count, count + 10]) {
      const line = Math.min(requested, count);
      const result = await resolveSourceNavigation(
        { ...input, line: requested, range: { startLine: requested, endLine: requested } },
        { ...repo, read: async () => content },
      );
      assert.ok(result.status === "found");
      if (result.status !== "found") continue;
      assert.equal(
        result.content,
        lines[line - 1] + (line < count || content.endsWith("\n") ? "\n" : ""),
      );
      assert.equal(result.totalLines, count);
      assert.equal(result.line, line);
      assert.equal(result.contentStartLine, line);
      assert.equal(result.contentEndLine, line);
    }
  }
  const content = "line\n".repeat(2001);
  const result = await resolveSourceNavigation(
    { ...input, line: 2000, range: { startLine: 2, endLine: 2001 } },
    { ...repo, read: async () => content },
  );
  assert.ok(result.status === "found" && result.totalLines === 2001);
  if (result.status === "found") {
    assert.equal(result.content, "line\n".repeat(2000));
    assert.equal(result.contentStartLine, 2);
    assert.equal(result.contentEndLine, 2001);
    assert.equal(result.line, 2000);
  }
});

test("cache enforces LRU entry and UTF-16 byte budgets, including oversized blobs", async () => {
  const cache = new SourceNavigationCache(1000, 2);
  let loads = 0;
  const get = (key: string, content = key) =>
    cache.get(key, async () => {
      loads++;
      return content;
    });
  await get("a");
  await get("b");
  await get("a");
  await get("c");
  assert.equal(loads, 3);
  await get("b");
  assert.equal(loads, 4, "oldest entry was evicted");
  await get("huge", "x".repeat(1000));
  await get("huge", "x".repeat(1000));
  assert.equal(loads, 6, "oversized values aren't retained");
  const small = new SourceNavigationCache(300, 20);
  let smallLoads = 0;
  const smallGet = (key: string) =>
    small.get(key, async () => {
      smallLoads++;
      return "x".repeat(40);
    });
  await smallGet("a");
  await smallGet("b");
  await smallGet("a");
  assert.equal(smallLoads, 3, "byte budget evicts even below entry limit");
  let arrayLoads = 0;
  const arrayGet = () =>
    cache.get("tree", async () => {
      arrayLoads++;
      return Array.from({ length: 10 }, () => "a");
    });
  await arrayGet();
  await arrayGet();
  assert.equal(
    arrayLoads,
    2,
    "array element overhead counts even when serialized strings are tiny",
  );
});

test("Git cache isolates repositories, rejects mutable refs and unsafe paths, and never caches missing objects", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "source-cache-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const git = (args: string[], input?: string) =>
    execFileSync("git", ["-C", path, ...args], { input, encoding: "utf8" }).trim();
  git(["init", "--bare"]);
  const cache = new SourceNavigationCache();
  const pendingPath = join(path, "not-created-yet.git");
  const pendingRepository = gitSourceRepository(pendingPath, { cache });
  await assert.rejects(pendingRepository.hasCommit(head), { code: "ENOENT" });
  execFileSync("git", ["init", "--bare", pendingPath], { stdio: "pipe" });
  assert.equal(
    await pendingRepository.hasCommit(head),
    false,
    "path readiness failures are retryable",
  );
  const repository = gitSourceRepository(path, { cache });
  await assert.rejects(repository.files("HEAD"), /immutable/);
  await assert.rejects(async () => repository.read("main", "file.ts"), /immutable/);
  await assert.rejects(async () => repository.read(head, "../secret"), /Unsafe/);
  await assert.rejects(repository.renames("HEAD", head), /immutable/);
  await assert.rejects(
    repository.comparisonRef({ headSha: "HEAD", baseSha: old, commitSha: null }),
    /immutable/,
  );
  const blob = git(["hash-object", "-w", "--stdin"], "source\n");
  const tree = git(["mktree"], `100644 blob ${blob}\tfile.ts\n`);
  const raw = `tree ${tree}\nauthor Test <test@example.invalid> 1700000000 +0000\ncommitter Test <test@example.invalid> 1700000000 +0000\n\nfixture\n`;
  const ref = git(["hash-object", "-t", "commit", "--stdin"], raw);
  assert.equal(await repository.hasCommit(ref), false);
  assert.deepEqual(await repository.files(ref), []);
  git(["hash-object", "-t", "commit", "-w", "--stdin"], raw);
  assert.equal(await repository.hasCommit(ref), true);
  assert.deepEqual(await repository.files(ref), ["file.ts"]);
  assert.equal(await repository.read(ref, "file.ts"), "source\n");
  const other = join(path, "other.git");
  execFileSync("git", ["init", "--bare", other], { stdio: "pipe" });
  assert.deepEqual(await gitSourceRepository(other, { cache }).files(ref), []);
  // A failed blob read must be retried after the object is restored.
  const objectPath = join(path, "objects", blob.slice(0, 2), blob.slice(2));
  const fresh = gitSourceRepository(path, { cache: new SourceNavigationCache() });
  await rm(objectPath);
  await assert.rejects(fresh.read(ref, "file.ts"), /Source repository read failed/);
  git(["hash-object", "-w", "--stdin"], "source\n");
  assert.equal(await fresh.read(ref, "file.ts"), "source\n");
  const misses = new Map<string, number>();
  class CountingCache extends SourceNavigationCache {
    override get<T>(key: string, load: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      return super.get(
        key,
        () => {
          const kind = JSON.parse(key)[1] as string;
          misses.set(kind, (misses.get(kind) ?? 0) + 1);
          return load();
        },
        signal,
      );
    }
  }
  const sharedCache = new CountingCache();
  const first = gitSourceRepository(path, { cache: sharedCache });
  const alias = join(path, "alias.git");
  await symlink(path, alias);
  const second = gitSourceRepository(alias, { cache: sharedCache });
  for (let i = 0; i < 2; i++) {
    await Promise.all([first.files(ref), second.files(ref)]);
    await Promise.all([first.read(ref, "file.ts"), second.read(ref, "file.ts")]);
    await Promise.all([first.renames(ref, ref), second.renames(ref, ref)]);
    await Promise.all([
      first.comparisonRef({ headSha: ref, baseSha: ref, commitSha: null }),
      second.comparisonRef({ headSha: ref, baseSha: ref, commitSha: null }),
    ]);
  }
  assert.deepEqual(Object.fromEntries(misses), {
    commit: 1,
    tree: 1,
    blob: 1,
    renames: 1,
    comparison: 1,
  });
  const files = await first.files(ref);
  files.splice(0, files.length, "injected.ts");
  assert.deepEqual(await second.files(ref), ["file.ts"], "callers cannot mutate cached trees");
  const renamedTree = git(["mktree"], `100644 blob ${blob}\trenamed.ts\n`);
  const renamedRef = git(
    ["hash-object", "-t", "commit", "-w", "--stdin"],
    raw.replace(tree, renamedTree),
  );
  const renames = await first.renames(ref, renamedRef);
  assert.deepEqual(renames, [{ from: "file.ts", to: "renamed.ts" }]);
  renames[0].to = "injected.ts";
  renames.push({ from: "other.ts", to: "also-injected.ts" });
  assert.deepEqual(await second.renames(ref, renamedRef), [{ from: "file.ts", to: "renamed.ts" }]);
});
