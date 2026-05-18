import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const tokenFile = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".better-review-api-token");
const envToken = process.env.BETTER_REVIEW_API_TOKEN?.trim();

if (existsSync(tokenFile)) {
  const existing = readFileSync(tokenFile, "utf8").trim();
  if (!existing) {
    throw new Error(`${tokenFile} exists but is empty`);
  }
  console.log(`[auth] Using existing dev API token at ${tokenFile}`);
  process.exit(0);
}

const token = envToken || randomBytes(32).toString("hex");
writeFileSync(tokenFile, `${token}\n`);
chmodSync(tokenFile, 0o600);

console.log(`[auth] Created dev API token at ${tokenFile}`);
