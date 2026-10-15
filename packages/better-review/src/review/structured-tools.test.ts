import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { reviewBaseRef } from "../pr-checkout";
import type { PrReviewSession } from "../pr-review-sessions";
import type { SubmissionSandbox } from "./microsandbox";
import {
  decodeGitPath,
  mergeRanges,
  repositoryPath,
  ReviewToolCache,
  StructuredReviewTools,
} from "./structured-tools";

const exec = promisify(execFile);

// Real Git + shell integration through the same exec interface used by Microsandbox.
// Production never executes these commands on the host; this adapter is test-only.
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "review-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await exec("git", args, { cwd: root })).stdout.trim();
  await git("init", "-q");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.com");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/a.ts"), "first\nliteral a.b\nlast\n");
  await writeFile(join(root, "old name.ts"), "rename me\n".repeat(20));
  await git("add", ".");
  await git("commit", "-qm", "base");
  const baseSha = await git("rev-parse", "HEAD");
  await writeFile(join(root, "src/a.ts"), "first\nliteral a.b\nadded aXb\nlast\n");
  await rename(join(root, "old name.ts"), join(root, "new name.ts"));
  await writeFile(
    join(root, "many.ts"),
    Array.from({ length: 245 }, (_, i) => `needle ${i + 1}`).join("\n") + "\n",
  );
  await writeFile(join(root, "long.ts"), "é🦀".repeat(5000) + "\nend\n");
  await writeFile(join(root, "strange:' file.ts"), "needle quoted\n");
  await symlink("/etc/passwd", join(root, "link"));
  await git("add", ".");
  await git("commit", "-qm", "head");
  const headSha = await git("rev-parse", "HEAD");
  let session: PrReviewSession = {
    runtimeVersion: 3,
    id: "test",
    owner: "acme",
    repo: "app",
    number: 42,
    prUrl: "https://github.com/acme/app/pull/42",
    baseSha,
    headSha,
    reviewMode: "full",
    commitSha: null,
    worktreePath: root,
    files: ["src/a.ts"],
    createdAt: 0,
    updatedAt: 0,
  };
  await git("update-ref", reviewBaseRef(session), baseSha);
  let calls = 0;
  const sandbox = {
    cwd: root,
    async exec(command: string, options: { signal?: AbortSignal } = {}) {
      calls++;
      try {
        const result = await exec("/bin/sh", ["-c", command], {
          cwd: root,
          signal: options.signal,
          maxBuffer: 30000,
        });
        return { ...result, exitCode: 0 };
      } catch (error) {
        const failed = error as Error & { code: number; stdout: string; stderr: string };
        if (options.signal?.aborted) throw error;
        return { stdout: failed.stdout, stderr: failed.stderr, exitCode: failed.code };
      }
    },
  } as SubmissionSandbox;
  sandbox.execStructured = sandbox.exec;
  const cache = new ReviewToolCache();
  return {
    root,
    git,
    tools: new StructuredReviewTools(
      async () => session,
      async () => sandbox,
      cache,
    ),
    get session() {
      return session;
    },
    setSession(next: PrReviewSession) {
      session = next;
    },
    get calls() {
      return calls;
    },
  };
}

test("paths reject traversal, absolute/scratch paths and Git internals; ranges normalize and merge", () => {
  for (const path of ["../x", "/tmp/x", "src/../../etc/passwd", ".git/config", "src\nfoo", ""])
    assert.throws(() => repositoryPath(path));
  assert.equal(repositoryPath("./src//a.ts"), "src/a.ts");
  assert.deepEqual(
    mergeRanges([
      { path: "src/a.ts", start: 4, end: 8 },
      { path: "./src/a.ts", start: 1, end: 5 },
    ]),
    [{ path: "src/a.ts", start: 1, end: 8 }],
  );
  assert.throws(() => mergeRanges([{ path: "file", start: 4, end: 2 }]));
});

test("search distinguishes literal, regex, context, missing matches, invalid regex and quoted paths", async (t) => {
  const f = await fixture(t);
  const literal = await f.tools.search({ pattern: "a.b", paths: ["src"], context: 0 });
  assert.equal(literal.status, "ok");
  assert.deepEqual(
    literal.records.map((row) => row.text),
    ["literal a.b"],
  );
  const regex = await f.tools.search({ pattern: "a.b", mode: "regex", paths: ["src"], context: 0 });
  assert.equal(regex.records.length, 2);
  const context = await f.tools.search({ pattern: "literal", paths: ["src"], context: 1 });
  assert.deepEqual(
    context.records.map((row) => ("line" in row ? row.line : null)),
    [1, 2, 3],
  );
  assert.equal((await f.tools.search({ pattern: "absent" })).status, "no_match");
  const failed = await f.tools.search({ pattern: "[", mode: "regex" });
  assert.equal(failed.status, "error");
  assert.ok(failed.error);
  const quoted = await f.tools.search({
    pattern: "needle",
    paths: ["strange:' file.ts"],
    context: 0,
  });
  assert.equal(quoted.records[0]?.text, "needle quoted");
  assert.equal("path" in quoted.records[0]! && quoted.records[0].path, "strange:' file.ts");
});

test("search pagination is complete, bounded, cached and bound to query/revision/repository", async (t) => {
  const f = await fixture(t);
  const args = { pattern: "needle", paths: ["many.ts"], context: 0 };
  const first = await f.tools.search(args);
  assert.equal(first.records.length, 100);
  assert.ok(first.truncated);
  assert.ok(first.continuation);
  const calls = f.calls;
  let hit = false;
  assert.deepEqual(
    await f.tools.search(args, undefined, {
      output() {},
      metadata(value) {
        hit ||= value.cacheHit === true;
      },
    }),
    first,
  );
  assert.equal(f.calls, calls);
  assert.ok(hit);
  const all = [...first.records];
  let token: string | null = first.continuation;
  while (token) {
    const page = await f.tools.search({ ...args, continuation: token });
    all.push(...page.records);
    token = page.continuation;
  }
  assert.equal(all.length, 245);
  assert.deepEqual(
    all.map((row) => ("line" in row ? row.line : null)),
    Array.from({ length: 245 }, (_, i) => i + 1),
  );
  await assert.rejects(
    f.tools.search({ ...args, pattern: "other", continuation: first.continuation! }),
    /different query/,
  );
  f.setSession({ ...f.session, repo: "another" });
  await assert.rejects(
    f.tools.search({ ...args, continuation: first.continuation! }),
    /different query/,
  );
  f.setSession({ ...f.session, headSha: f.session.baseSha });
  await assert.rejects(
    f.tools.search({ ...args, continuation: first.continuation! }),
    /different query/,
  );
});

test("batch reads merge overlaps, preserve independent errors and share a page budget", async (t) => {
  const f = await fixture(t);
  const ranges = [
    { path: "missing.ts" },
    { path: "src/a.ts", start: 1, end: 3 },
    { path: "src/a.ts", start: 2, end: 4 },
  ];
  const result = await f.tools.read({ ranges });
  assert.equal(result.files.length, 2);
  assert.ok(result.files[0]?.error);
  assert.deepEqual(
    result.files[1]?.lines.map((line) => line.row),
    [1, 2, 3, 4],
  );
  const many = await f.tools.read({
    ranges: [{ path: "many.ts", end: 245 }, { path: "src/a.ts" }],
  });
  assert.equal(many.files.flatMap((file) => file.lines).length, 100);
  assert.ok(many.truncated);
  const rows = many.files.flatMap((file) => file.lines);
  let token = many.continuation;
  while (token) {
    const page = await f.tools.read({
      ranges: [{ path: "many.ts", end: 245 }, { path: "src/a.ts" }],
      continuation: token,
    });
    rows.push(...page.files.flatMap((file) => file.lines));
    token = page.continuation;
  }
  assert.equal(rows.length, 249);
});

test("long UTF-8 lines continue without loss; immutable reads do not follow symlinks or checkout edits", async (t) => {
  const f = await fixture(t);
  const args = { ranges: [{ path: "long.ts", start: 1, end: 1 }] };
  let result = await f.tools.read(args);
  const chunks = [...result.files[0]!.lines];
  assert.ok(result.truncated);
  while (result.continuation) {
    result = await f.tools.read({ ...args, continuation: result.continuation });
    chunks.push(...result.files[0]!.lines);
  }
  assert.equal(chunks.map((row) => row.text).join(""), "é🦀".repeat(5000));
  assert.ok(chunks.every((row) => row.row === 1 && !row.text.includes("�")));
  assert.equal(
    (await f.tools.read({ ranges: [{ path: "link" }] })).files[0]?.lines[0]?.text,
    "/etc/passwd",
  );
  await writeFile(join(f.root, "src/a.ts"), "mutable checkout\n");
  assert.equal(
    (await f.tools.read({ ranges: [{ path: "src/a.ts", start: 1, end: 1 }] })).files[0]?.lines[0]
      ?.text,
    "first",
  );
});

test("canonical diff supports renames and old/new hunk numbers across pages and saved modes", async (t) => {
  const f = await fixture(t);
  const diff = await f.tools.diff({ paths: ["src/a.ts"], context: 1 });
  assert.equal(diff.status, "ok");
  const added = diff.lines.find((line) => line.text === "+added aXb");
  assert.equal(added?.oldLine, null);
  assert.equal(added?.newLine, 3);
  const context = diff.lines.find((line) => line.text === " last");
  assert.equal(context?.oldLine, 3);
  assert.equal(context?.newLine, 4);
  const rename = await f.tools.diff({ paths: ["old name.ts", "new name.ts"] });
  assert.ok(rename.lines.some((line) => line.text === "rename from old name.ts"));
  assert.ok(rename.lines.some((line) => line.text === "rename to new name.ts"));
  let many = await f.tools.diff({ paths: ["many.ts"], context: 0 });
  const addedRows = many.lines.filter((line) => line.newLine !== null).map((line) => line.newLine);
  while (many.continuation) {
    many = await f.tools.diff({ paths: ["many.ts"], context: 0, continuation: many.continuation });
    addedRows.push(
      ...many.lines.filter((line) => line.newLine !== null).map((line) => line.newLine),
    );
  }
  assert.deepEqual(
    addedRows,
    Array.from({ length: 245 }, (_, i) => i + 1),
  );
  f.setSession({ ...f.session, reviewMode: "commit", commitSha: f.session.headSha });
  const commit = await f.tools.diff({ paths: ["src/a.ts"] });
  assert.equal(commit.range, `${f.session.headSha}^..${f.session.headSha}`);
  await f.git("update-ref", reviewBaseRef(f.session), f.session.headSha);
  f.setSession({ ...f.session, reviewMode: "full" });
  await assert.rejects(f.tools.diff({ paths: ["src/a.ts"], context: 10 }), /base ref/);
});

test("cache is bounded, LRU and immune to caller mutation; Git paths decode octal UTF-8", () => {
  const cache = new ReviewToolCache(200, 2);
  cache.set("a", { value: 1 });
  cache.set("b", { value: 2 });
  const first = cache.get<{ value: number }>("a")!;
  first.value = 9;
  assert.equal(cache.get<{ value: number }>("a")?.value, 1);
  cache.set("c", { value: 3 });
  assert.equal(cache.get("b"), undefined);
  cache.set("huge", "x".repeat(300));
  assert.equal(cache.get("huge"), undefined);
  assert.equal(decodeGitPath('"a/\\303\\251\\tfile"'), "a/é\tfile");
});

test("aborted requests fail even when results are cached", async (t) => {
  const f = await fixture(t);
  await f.tools.search({ pattern: "needle" });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(f.tools.search({ pattern: "needle" }, abort.signal), /abort/i);
});
