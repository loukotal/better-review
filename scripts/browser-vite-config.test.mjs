import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

import config from "./browser-vite.config.mjs";

test("browser fixtures never overwrite the running development server's Vite cache", () => {
  assert.ok(config.cacheDir, "Browser fixtures must choose an explicit, isolated cache");
  assert.notEqual(resolve(config.cacheDir), resolve(config.root, "node_modules/.vite"));
  assert.notEqual(resolve(config.cacheDir), resolve(config.root, "node_modules/.vite-dev"));
});

test("concurrent browser test processes have different dependency caches", () => {
  const childCache = () =>
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import config from ${JSON.stringify(new URL("./browser-vite.config.mjs", import.meta.url).href)}; console.log(JSON.stringify(config.cacheDir ?? null));`,
      ],
      { encoding: "utf8" },
    ).trim();
  const first = JSON.parse(childCache());
  const second = JSON.parse(childCache());
  assert.ok(first, "Each test process needs its own cache");
  assert.notEqual(first, second);
  assert.notEqual(first, config.cacheDir);
});
