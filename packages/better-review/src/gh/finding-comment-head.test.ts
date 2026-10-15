import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Effect } from "effect";

import { GhService, GhServiceLive } from "./gh";

test("real gh comment call refuses a changed head before POST and pins matching comment coordinates", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "finding-comment-head-"));
  const log = join(dir, "post.json");
  const oldPath = process.env.PATH;
  await writeFile(
    join(dir, "gh"),
    `#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args.includes('POST')){fs.writeFileSync(${JSON.stringify(log)},JSON.stringify(args));console.error('intercepted comment POST');process.exit(1);}console.log('${"b".repeat(40)}');\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${dir}:${oldPath}`;
  t.after(async () => {
    process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  });
  const submit = (expectedHeadSha: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const gh = yield* GhService;
        return yield* gh.addComment({
          prUrl: "https://github.com/o/r/pull/1",
          filePath: "src/user-rent.ts",
          line: 457,
          side: "RIGHT",
          body: "draft only",
          expectedHeadSha,
        });
      }).pipe(Effect.provide(GhServiceLive)),
    );
  await assert.rejects(submit("a".repeat(40)), /PR head changed/);
  await assert.rejects(readFile(log), /ENOENT/);
  await assert.rejects(submit("b".repeat(40)), /intercepted comment POST/);
  const args = JSON.parse(await readFile(log, "utf8"));
  assert.ok(args.includes(`commit_id=${"b".repeat(40)}`));
  assert.ok(args.includes("path=src/user-rent.ts"));
  assert.ok(args.includes("line=457"));
  assert.ok(args.includes("side=RIGHT"));
});
