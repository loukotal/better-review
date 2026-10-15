import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { reviewBaseRef } from "../pr-checkout";
import type { PrReviewSession } from "../pr-review-sessions";
import { STORE_BASE_DIR } from "../store";
import { cleanupOrphanedMicrosandboxes, createReviewMicrosandbox } from "./microsandbox";
import { ReviewToolCache, StructuredReviewTools } from "./structured-tools";

test(
  "real microVM: structured search/read/diff, continuation, immutable caching and failures",
  {
    skip: process.env.BETTER_REVIEW_SANDBOX_TEST !== "1",
    timeout: 120000,
  },
  async (t) => {
    const cacheRoot = path.join(STORE_BASE_DIR, "git-cache", "github");
    await mkdir(cacheRoot, { recursive: true });
    const root = await mkdtemp(path.join(cacheRoot, "structured-tools-test-"));
    const owner = path.basename(root);
    t.after(async () => {
      await cleanupOrphanedMicrosandboxes(owner);
      await rm(root, { recursive: true, force: true });
    });
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init", "--initial-branch=main", "seed");
    git("-C", "seed", "config", "user.name", "Test");
    git("-C", "seed", "config", "user.email", "test@example.invalid");
    await writeFile(path.join(root, "seed", "old name.ts"), "rename\n".repeat(20));
    await writeFile(path.join(root, "seed", "source.ts"), "first\nold\nlast\n");
    await writeFile(path.join(root, "seed", "space name.ts"), "before\n");
    await writeFile(path.join(root, "seed", 'quote"é.ts'), "before quoted\n");
    git("-C", "seed", "add", ".");
    git("-C", "seed", "commit", "-qm", "base");
    const baseSha = git("-C", "seed", "rev-parse", "HEAD");
    await rename(path.join(root, "seed", "old name.ts"), path.join(root, "seed", "new name.ts"));
    await writeFile(path.join(root, "seed", "source.ts"), "first\nold\nadded a.b\nlast\n");
    await writeFile(
      path.join(root, "seed", "many.ts"),
      Array.from({ length: 205 }, (_, i) => `needle ${i + 1}`).join("\n") + "\n",
    );
    await writeFile(path.join(root, "seed", "long.ts"), "é🦀".repeat(5000) + "\n");
    await writeFile(path.join(root, "seed", "strange:' file.ts"), "needle quoted\n");
    await writeFile(path.join(root, "seed", "invalid.txt"), Buffer.alloc(13000, 0x80));
    await writeFile(path.join(root, "seed", "binary.txt"), Buffer.from("visible\0HIDDEN\nnext\n"));
    await writeFile(path.join(root, "seed", "space name.ts"), "++ pretend.ts\n");
    await writeFile(path.join(root, "seed", 'quote"é.ts'), "after quoted\n");
    await mkdir(path.join(root, "seed", "search-fixture"));
    for (const directory of ["", "search-fixture"]) {
      await writeFile(
        path.join(root, "seed", directory, "source.ts\u0001999\u0001injected"),
        "boundaryneedle real content\n",
      );
      await writeFile(
        path.join(root, "seed", directory, "line\nbreak.ts"),
        "boundaryneedle newline path\n",
      );
    }
    // Include every permitted Git filename control byte, including controls in a
    // directory component. None may enter the line-oriented search protocol.
    for (const code of [...Array.from({ length: 31 }, (_, i) => i + 1), 127]) {
      await writeFile(
        path.join(root, "seed", "search-fixture", `control${String.fromCharCode(code)}name.ts`),
        "boundaryneedle control path\n",
      );
    }
    await mkdir(path.join(root, "seed", "search-fixture", "control\u0002directory"));
    await writeFile(
      path.join(root, "seed", "search-fixture", "control\u0002directory", "source.ts"),
      "boundaryneedle control directory\n",
    );
    await writeFile(
      path.join(root, "seed", "search-fixture", "normal.ts"),
      "boundaryneedle normal\u0001content\n",
    );
    await symlink("/etc/passwd", path.join(root, "seed", "link"));
    git("-C", "seed", "add", ".");
    git("-C", "seed", "commit", "-qm", "head");
    const headSha = git("-C", "seed", "rev-parse", "HEAD");
    git("clone", "--bare", "seed", "cache.git");
    git("--git-dir=cache.git", "worktree", "add", "--detach", path.join(root, "checkout"), "HEAD");
    const session: PrReviewSession = {
      runtimeVersion: 3,
      id: owner,
      owner: "test",
      repo: "fixture",
      number: 1,
      prUrl: "https://github.com/test/fixture/pull/1",
      headSha,
      baseSha,
      reviewMode: "full",
      commitSha: null,
      worktreePath: path.join(root, "checkout"),
      files: ["source.ts"],
      createdAt: 0,
      updatedAt: 0,
    };
    git("--git-dir=cache.git", "update-ref", reviewBaseRef(session), baseSha);
    const vm = await createReviewMicrosandbox(session, owner, owner);
    await vm.beginSubmission();
    let ended = false;
    try {
      // An escape-hatch command may mutate scratch Git config; immutable structured
      // results must not inherit those formatting settings or cache their effects.
      assert.equal(
        (
          await vm.exec(
            "git config --global grep.heading true && git config --global diff.mnemonicPrefix true",
          )
        ).exitCode,
        0,
      );
      const tools = new StructuredReviewTools(
        async () => session,
        async () => vm,
        new ReviewToolCache(),
      );
      const args = { pattern: "needle", paths: ["many.ts"], context: 0 };
      let result = await tools.search(args);
      assert.equal(result.status, "ok");
      assert.equal(result.records.length, 100);
      const rows = [...result.records];
      let hit = false;
      await tools.search(args, undefined, {
        output() {},
        metadata(value) {
          hit ||= value.cacheHit === true;
        },
      });
      assert.ok(hit);
      while (result.continuation) {
        result = await tools.search({ ...args, continuation: result.continuation });
        rows.push(...result.records);
      }
      assert.equal(rows.length, 205);
      assert.equal((await tools.search({ pattern: "not-here" })).status, "no_match");
      assert.equal((await tools.search({ pattern: "[", mode: "regex" })).status, "error");
      const quoted = await tools.search({
        pattern: "needle",
        paths: ["strange:' file.ts"],
        context: 0,
      });
      assert.equal(quoted.records[0]?.text, "needle quoted");
      const reads = await tools.read({
        ranges: [
          { path: "source.ts", start: 2, end: 3 },
          { path: "source.ts", start: 3, end: 4 },
          { path: "missing" },
        ],
      });
      assert.equal(reads.files.length, 2);
      assert.ok(reads.files.some((file) => file.error));
      assert.deepEqual(
        reads.files.find((file) => file.path === "source.ts")?.lines.map((row) => row.row),
        [2, 3, 4],
      );
      const readArgs = { ranges: [{ path: "long.ts", end: 1 }] };
      let long = await tools.read(readArgs);
      let text = long.files[0]!.lines.map((row) => row.text).join("");
      while (long.continuation) {
        long = await tools.read({ ...readArgs, continuation: long.continuation });
        text += long.files[0]!.lines.map((row) => row.text).join("");
      }
      assert.equal(text, "é🦀".repeat(5000));
      assert.equal(
        (await tools.read({ ranges: [{ path: "link" }] })).files[0]?.lines[0]?.text,
        "/etc/passwd",
      );
      await assert.rejects(
        tools.read({ ranges: [{ path: "/tmp/marker" }] }),
        /repository-relative/,
      );
      const diff = await tools.diff({ paths: ["source.ts"], context: 1 });
      assert.equal(diff.status, "ok");
      assert.equal(diff.lines.find((line) => line.text === "+added a.b")?.newLine, 3);
      assert.equal(diff.lines.find((line) => line.text === " last")?.oldLine, 3);
      const renames = await tools.diff({ paths: ["old name.ts", "new name.ts"] });
      assert.ok(renames.lines.some((line) => line.text === "rename from old name.ts"));
      let diffPage = await tools.diff({ paths: ["many.ts"], context: 0 });
      const lineNumbers = diffPage.lines
        .filter((line) => line.newLine !== null)
        .map((line) => line.newLine);
      while (diffPage.continuation) {
        diffPage = await tools.diff({
          paths: ["many.ts"],
          context: 0,
          continuation: diffPage.continuation,
        });
        lineNumbers.push(
          ...diffPage.lines.filter((line) => line.newLine !== null).map((line) => line.newLine),
        );
      }
      assert.deepEqual(
        lineNumbers,
        Array.from({ length: 205 }, (_, i) => i + 1),
      );
      await t.test(
        "unfiltered and directory search skip control-character paths before field framing",
        async () => {
          for (const paths of [undefined, ["search-fixture"]]) {
            const args = { pattern: "boundaryneedle", context: 0, paths };
            const result = await tools.search(args);
            assert.equal(result.status, "ok");
            assert.equal(result.continuation, null);
            assert.equal(result.records.length, 1);
            const row = result.records[0]!;
            assert.equal(row.kind, "line");
            assert.equal("path" in row && row.path, "search-fixture/normal.ts");
            assert.equal("line" in row && row.line, 1);
            assert.equal(row.text, "boundaryneedle normal\u0001content");
            assert.deepEqual(
              await tools.search(args),
              result,
              "cache retains only authentic parsed records",
            );
            const skipped = await tools.search({
              pattern: "boundaryneedle real content",
              context: 0,
              paths,
            });
            assert.equal(skipped.status, "no_match");
            assert.deepEqual(skipped.records, []);
          }
        },
      );
      await t.test(
        "invalid UTF-8 is an explicit per-file error, never a stationary continuation",
        async () => {
          const invalid = await tools.read({ ranges: [{ path: "invalid.txt" }] });
          assert.match(invalid.files[0]?.error ?? "", /UTF-8|encoding/i);
          assert.deepEqual(invalid.files[0]?.lines, []);
          assert.equal(invalid.continuation, null);
        },
      );
      await t.test("NUL blobs never fabricate LF line numbers", async () => {
        const binary = await tools.read({
          ranges: [{ path: "binary.txt" }, { path: "source.ts", end: 1 }],
        });
        assert.match(binary.files[0]?.error ?? "", /binary|NUL/i);
        assert.deepEqual(binary.files[0]?.lines, []);
        assert.equal(binary.files[1]?.lines[0]?.text, "first");
      });
      await t.test(
        "diff source lines cannot become headers; space and quoted filenames are exact",
        async () => {
          const patch = await tools.diff({ paths: ["space name.ts", 'quote"é.ts'], context: 0 });
          assert.equal(patch.lines.find((line) => line.text === "+++ pretend.ts")?.path, undefined);
          const headers = patch.lines
            .filter((line) => line.path !== undefined)
            .map((line) => line.path);
          assert.deepEqual(headers, ['quote"é.ts', 'quote"é.ts', "space name.ts", "space name.ts"]);
        },
      );
      await t.test("one deadline covers the entire batch, not each VM command", async () => {
        const signals: AbortSignal[] = [];
        const slow = {
          ...vm,
          execStructured: async (...args: Parameters<typeof vm.execStructured>) => {
            if (args[1]?.signal) signals.push(args[1].signal);
            await delay(180, undefined, { signal: args[1]?.signal });
            return vm.execStructured(...args);
          },
        };
        const timed = new StructuredReviewTools(
          async () => session,
          async () => slow,
          new ReviewToolCache(),
          300,
        );
        const started = performance.now();
        await assert.rejects(
          timed.read({ ranges: [{ path: "source.ts" }, { path: "many.ts" }] }),
          /abort|timeout/i,
        );
        assert.ok(performance.now() - started < 1000);
        assert.ok(signals.length >= 2);
        assert.ok(signals.every((signal) => signal === signals[0] && signal.aborted));
      });
      await t.test(
        "legacy numbered reads retain absolute checkout and scratch access without caching",
        async () => {
          assert.equal(
            await vm.readLines(path.join(session.worktreePath, "source.ts"), 1, 1),
            "1: first\n",
          );
          const scratch = (
            await vm.exec('printf temporary > "$HOME/legacy.txt"; printf "%s/legacy.txt" "$HOME"')
          ).stdout;
          assert.equal(await vm.readLines(scratch, 1, 1), "1: temporary\n");
          await vm.exec('printf updated > "$HOME/legacy.txt"');
          assert.equal(await vm.readLines(scratch, 1, 1), "1: updated\n");
        },
      );
      await t.test(
        "writable login profiles cannot poison immutable results or shared caches",
        async () => {
          await vm.exec(`printf '%s\\n' 'git() { printf "FORGED SOURCE\\n"; }' > "$HOME/.profile"`);
          const uncached = new StructuredReviewTools(
            async () => session,
            async () => vm,
          );
          const args = { ranges: [{ path: "source.ts", start: 1, end: 1 }] };
          assert.equal((await uncached.read(args)).files[0]?.lines[0]?.text, "first");
          assert.equal(
            (await uncached.search({ pattern: "added a.b", context: 0, paths: ["source.ts"] }))
              .records[0]?.text,
            "added a.b",
          );
          assert.equal((await uncached.diff({ paths: ["source.ts"] })).status, "ok");
          assert.equal((await vm.execStructured('printf "%s" "$PATH"')).stdout, "/usr/bin:/bin");
          await vm.endSubmission();
          ended = true;
          const other = await createReviewMicrosandbox(session, `${owner}-other`, owner);
          await other.beginSubmission();
          try {
            const next = new StructuredReviewTools(
              async () => session,
              async () => other,
            );
            let hit = false;
            assert.equal(
              (
                await next.read(args, undefined, {
                  output() {},
                  metadata(value) {
                    hit ||= value.cacheHit === true;
                  },
                })
              ).files[0]?.lines[0]?.text,
              "first",
            );
            assert.ok(
              hit,
              "only authentic immutable output survives scratch cleanup in the shared cache",
            );
          } finally {
            await other.endSubmission();
          }
        },
      );
    } finally {
      if (!ended) await vm.endSubmission();
    }
  },
);
