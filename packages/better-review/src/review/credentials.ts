import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";

/** Adapt existing credential files to Pi's native, refresh-capable auth contract. */
export function reviewCredentials(
  paths = {
    pi: process.env.BETTER_REVIEW_PI_AUTH_PATH ?? path.join(homedir(), ".pi", "agent", "auth.json"),
    opencode:
      process.env.BETTER_REVIEW_OPENCODE_AUTH_PATH ??
      path.join(
        process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"),
        "opencode",
        "auth.json",
      ),
  },
): CredentialStore {
  async function load(file: string): Promise<Record<string, Record<string, unknown>>> {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
  const key = (file: string, provider: string) =>
    file === paths.opencode && provider === "openai-codex" ? "openai" : provider;
  async function source(provider: string) {
    for (const file of [paths.pi, paths.opencode])
      if ((await load(file))[key(file, provider)]) return file;
    return undefined;
  }
  function canonical(value: Record<string, unknown> | undefined): Credential | undefined {
    if (!value) return undefined;
    if ((value.type === "api_key" || value.type === "api") && typeof value.key === "string")
      return { type: "api_key", key: value.key };
    if (
      value.type === "oauth" &&
      typeof value.access === "string" &&
      typeof value.refresh === "string" &&
      typeof value.expires === "number"
    )
      return {
        ...value,
        type: "oauth",
        access: value.access,
        refresh: value.refresh,
        expires: value.expires,
      };
    return undefined;
  }
  async function change(
    provider: string,
    transform: (current: Credential | undefined) => Promise<Credential | undefined>,
    remove = false,
  ) {
    const file = await source(provider);
    if (!file || !existsSync(file)) return undefined;
    const unlock = await lockfile.lock(file, {
      realpath: false,
      stale: 10000,
      update: 2000,
      retries: { retries: 30, minTimeout: 100, maxTimeout: 1000 },
    });
    try {
      const values = await load(file);
      const id = key(file, provider);
      const current = canonical(values[id]);
      const updated = await transform(current);
      if (!remove && (!updated || JSON.stringify(updated) === JSON.stringify(current)))
        return current;
      if (remove) delete values[id];
      else
        values[id] = {
          ...values[id],
          ...updated,
          ...(values[id]?.type === "api" && updated?.type === "api_key" ? { type: "api" } : {}),
        };
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(values, null, 2), { mode: 0o600 });
        await rename(temporary, file);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      return updated;
    } finally {
      await unlock();
    }
  }
  return {
    async read(provider) {
      const file = await source(provider);
      return file ? canonical((await load(file))[key(file, provider)]) : undefined;
    },
    async list() {
      const result = new Map<string, { providerId: string; type: "api_key" | "oauth" }>();
      for (const file of [paths.pi, paths.opencode])
        for (const [id, value] of Object.entries(await load(file))) {
          const credential = canonical(value);
          const providerId =
            file === paths.opencode && id === "openai" && credential?.type === "oauth"
              ? "openai-codex"
              : id;
          if (credential && !result.has(providerId))
            result.set(providerId, { providerId, type: credential.type });
        }
      return [...result.values()];
    },
    modify: (provider, transform) => change(provider, transform),
    delete: async (provider) => {
      await change(provider, async () => undefined, true);
    },
  };
}
