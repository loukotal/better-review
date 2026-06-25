import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { registerProvider } from "@flue/runtime";

const PI_AUTH_PATH =
  process.env.BETTER_REVIEW_PI_AUTH_PATH ?? path.join(homedir(), ".pi", "agent", "auth.json");

type StoredCredential =
  | { type: "api_key"; key?: unknown }
  | { type: "oauth"; access?: unknown; expires?: unknown };

function readPiAuth(): Record<string, StoredCredential> {
  if (!existsSync(PI_AUTH_PATH)) return {};

  try {
    const parsed = JSON.parse(readFileSync(PI_AUTH_PATH, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, StoredCredential>;
  } catch (error) {
    console.warn(`[Flue] Failed to read Pi auth file at ${PI_AUTH_PATH}:`, error);
    return {};
  }
}

export function getPiAuthApiKey(provider: string): string | undefined {
  const credential = readPiAuth()[provider];
  if (!credential) return undefined;

  if (credential.type === "api_key" && typeof credential.key === "string") {
    return credential.key;
  }

  if (credential.type === "oauth" && typeof credential.access === "string") {
    if (typeof credential.expires === "number" && credential.expires <= Date.now()) {
      console.warn(
        `[Flue] Pi OAuth token for ${provider} is expired; re-run Pi login for that provider.`,
      );
      return undefined;
    }
    return credential.access;
  }

  return undefined;
}

export function configureFlueOAuthProvidersFromPiAuth() {
  const anthropicToken = getPiAuthApiKey("anthropic");
  if (anthropicToken && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_OAUTH_TOKEN) {
    registerProvider("anthropic", { apiKey: anthropicToken });
  }

  const openAiCodexToken = getPiAuthApiKey("openai-codex");
  if (openAiCodexToken) {
    registerProvider("openai-codex", { apiKey: openAiCodexToken });
  }
}

export function hasPiOAuthProvider(provider: string): boolean {
  return Boolean(getPiAuthApiKey(provider));
}
