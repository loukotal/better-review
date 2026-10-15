import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { reviewCredentials } from "./credentials";

test("native OAuth refresh serializes rotated tokens and preserves unrelated credentials", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-auth-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = { pi: path.join(dir, "pi.json"), opencode: path.join(dir, "opencode.json") };
  await writeFile(
    paths.opencode,
    JSON.stringify({
      openai: {
        type: "oauth",
        access: "old",
        refresh: "refresh-1",
        expires: 1,
        accountId: "account",
      },
      other: { type: "api", key: "keep" },
    }),
  );
  const first = reviewCredentials(paths);
  const second = reviewCredentials(paths);
  let refreshed = 0;
  const refresh: Parameters<typeof first.modify>[1] = async (credential) => {
    if (credential?.type !== "oauth" || credential.expires !== 1) return credential;
    refreshed++;
    return { ...credential, access: "new", refresh: "refresh-2", expires: 100 };
  };
  await Promise.all([
    first.modify("openai-codex", refresh),
    second.modify("openai-codex", refresh),
  ]);
  assert.equal(refreshed, 1);
  const saved = JSON.parse(await readFile(paths.opencode, "utf8"));
  assert.equal(saved.openai.access, "new");
  assert.equal(saved.openai.accountId, "account");
  assert.deepEqual(saved.other, { type: "api", key: "keep" });
  assert.deepEqual(await first.read("other"), { type: "api_key", key: "keep" });
});
