import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { ReviewSession } from "@better-review/shared";

const exec = promisify(execFile);
const cliPath = fileURLToPath(new URL("../../../index.ts", import.meta.url));

test("CLI defaults to branch plus working-tree changes and respects explicit scopes", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "better-review-scope-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = async (...args: string[]) => await exec("git", args, { cwd });
  const commit = async (message: string) => {
    await git("add", ".");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message);
  };
  await git("init", "-b", "develop");
  await writeFile(join(cwd, "shared.txt"), "base\n");
  await commit("base");
  const baseSha = (await git("rev-parse", "HEAD")).stdout.trim();
  await git("branch", "main");
  await git("checkout", "-b", "feature");
  await writeFile(join(cwd, "committed.txt"), "branch change\n");
  await commit("feature change");
  await git("checkout", "develop");
  await writeFile(join(cwd, "upstream-only.txt"), "not part of feature\n");
  await commit("upstream change");
  await git("checkout", "feature");
  await writeFile(join(cwd, "staged.txt"), "staged change\n");
  await git("add", "staged.txt");
  await writeFile(join(cwd, "shared.txt"), "unstaged change\n");

  let createdSession: ReviewSession | undefined;
  const getCreatedSession = () => createdSession;
  const server = createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/sessions") {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      createdSession = { ...JSON.parse(body), id: "test-session" } as ReviewSession;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(createdSession));
    } else {
      response.end("ok");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address !== "string");
  const apiUrl = `http://127.0.0.1:${address.port}`;

  const review = async (...args: string[]) => {
    createdSession = undefined;
    await exec(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        cliPath,
        "review",
        "--api-url",
        apiUrl,
        "--print-url",
        "--no-open",
        ...args,
      ],
      {
        cwd,
        env: { ...process.env, BETTER_REVIEW_API_TOKEN: "" },
      },
    );
    const session = getCreatedSession();
    assert(session?.payload.kind === "diff");
    return session.payload;
  };

  const all = await review();
  assert.equal(all.selectedVariantId, "all");
  assert.equal(all.label, "Branch + uncommitted vs develop");
  for (const file of ["committed.txt", "staged.txt", "shared.txt"])
    assert(all.rawPatch.includes(file));
  assert(!all.rawPatch.includes("upstream-only.txt"));
  assert.deepEqual(all.variants?.find((variant) => variant.id === "all")?.contentSource, {
    kind: "working-tree",
    baseSha,
  });

  const staged = await review("--scope", "staged");
  assert.equal(staged.selectedVariantId, "staged");
  assert(staged.rawPatch.includes("staged.txt"));
  assert(!staged.rawPatch.includes("committed.txt"));
  assert(!staged.rawPatch.includes("shared.txt"));

  const uncommitted = await review("--scope", "uncommitted");
  assert(uncommitted.rawPatch.includes("staged.txt"));
  assert(uncommitted.rawPatch.includes("shared.txt"));
  assert(!uncommitted.rawPatch.includes("committed.txt"));

  const branch = await review("--scope", "branch", "--base", "main");
  assert.equal(branch.label, "Branch vs main");
  assert(branch.rawPatch.includes("committed.txt"));
  assert(!branch.rawPatch.includes("staged.txt"));
  assert(!branch.rawPatch.includes("shared.txt"));
  await assert.rejects(review("--base", "missing-base"), /Unknown review base/);

  const unborn = await mkdtemp(join(tmpdir(), "better-review-unborn-"));
  t.after(() => rm(unborn, { recursive: true, force: true }));
  await exec("git", ["init", "-b", "feature"], { cwd: unborn });
  await writeFile(join(unborn, "new.txt"), "first staged file\n");
  await exec("git", ["add", "new.txt"], { cwd: unborn });
  const initial = await review("--cwd", unborn);
  assert.equal(initial.selectedVariantId, "all");
  assert.equal(initial.label, "Uncommitted changes");
  assert(initial.rawPatch.includes("new.txt"));
});
