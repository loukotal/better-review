import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { createAppUpdateChecker } from "./app-update";

const exec = promisify(execFile);

test("app updates compare the running main checkout to the remote without fetching or changing it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const root = await mkdtemp(join(tmpdir(), "better-review-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git");
  const app = join(root, "app");
  const publisher = join(root, "publisher");
  const git = async (cwd: string, ...args: string[]) =>
    (await exec("git", args, { cwd })).stdout.trim();
  const commit = async (cwd: string, content: string) => {
    await writeFile(join(cwd, "file.txt"), content);
    await git(cwd, "add", ".");
    await git(
      cwd,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      content,
    );
    return git(cwd, "rev-parse", "HEAD");
  };
  await git(root, "init", "--bare", "-b", "main", remote);
  await mkdir(app);
  await git(app, "init", "-b", "main");
  const initial = await commit(app, "initial");
  await git(app, "remote", "add", "origin", remote);
  await git(app, "push", "origin", "main");
  await git(root, "clone", remote, publisher);

  const check = createAppUpdateChecker(app, 0);
  assert.deepEqual(await check(), {
    updateAvailable: false,
    currentRevision: initial,
    latestRevision: initial,
  });
  const cachedCheck = createAppUpdateChecker(app);
  assert.equal((await cachedCheck()).updateAvailable, false);
  const latest = await commit(publisher, "new revision");
  await git(publisher, "push", "origin", "main");
  const beforeRefs = await git(app, "show-ref");
  const [first, concurrent] = await Promise.all([check(), check()]);
  assert.deepEqual(first, {
    updateAvailable: true,
    currentRevision: initial,
    latestRevision: latest,
  });
  assert.deepEqual(concurrent, first);
  assert.equal(await git(app, "show-ref"), beforeRefs);
  assert.equal(await git(app, "rev-parse", "HEAD"), initial);
  assert.equal((await cachedCheck()).updateAvailable, false);

  // A day passing does not schedule work; the next request refreshes the cached status.
  t.mock.timers.tick(23 * 60 * 60_000);
  assert.equal((await cachedCheck()).updateAvailable, false);
  t.mock.timers.tick(60 * 60_000 + 1);
  assert.equal((await cachedCheck()).updateAvailable, true);

  await git(app, "checkout", "-b", "feature");
  assert.equal((await check()).updateAvailable, false);
  const featureCheck = createAppUpdateChecker(app, 0);
  assert.equal((await featureCheck()).updateAvailable, false);
  await git(app, "checkout", "main");
  assert.equal((await featureCheck()).updateAvailable, false);
  await git(app, "checkout", "--detach");
  assert.equal((await check()).updateAvailable, false);
  await git(app, "checkout", "main");

  // Pulling changes on disk still requires restarting the old process.
  await git(app, "pull", "--ff-only", "origin", "main");
  assert.equal((await check()).updateAvailable, true);
  assert.equal((await createAppUpdateChecker(app, 0)()).updateAvailable, false);
  await commit(app, "local-only commit");
  assert.equal((await createAppUpdateChecker(app, 0)()).updateAvailable, false);

  await git(app, "remote", "set-url", "origin", join(root, "missing.git"));
  assert.equal((await check()).updateAvailable, false);
  const nested = join(app, "installed-package");
  await mkdir(nested);
  assert.equal((await createAppUpdateChecker(nested, 0)()).updateAvailable, false);
  assert.equal((await createAppUpdateChecker(root, 0)()).updateAvailable, false);
});
