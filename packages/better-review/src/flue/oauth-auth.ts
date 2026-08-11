import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { Provider } from "@earendil-works/pi-ai";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

const PI_AUTH_PATH =
  process.env.BETTER_REVIEW_PI_AUTH_PATH ?? path.join(homedir(), ".pi", "agent", "auth.json");
const OPENCODE_AUTH_PATH =
  process.env.BETTER_REVIEW_OPENCODE_AUTH_PATH ??
  path.join(
    process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"),
    "opencode",
    "auth.json",
  );

type StoredCredential =
  | { type: "api_key"; key?: unknown }
  | { type: "oauth"; access?: unknown; expires?: unknown };

const PI_OAUTH_PROVIDER_IDS = ["anthropic", "openai-codex", "github-copilot", "opencode"];
const OPENCODE_AUTH_PROVIDER_ALIASES = new Map<string, string>([["openai-codex", "openai"]]);

function readAuthFile(authPath: string, label: string): Record<string, StoredCredential> {
  if (!existsSync(authPath)) return {};

  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, StoredCredential>;
  } catch (error) {
    console.warn(`[Flue] Failed to read ${label} auth file at ${authPath}:`, error);
    return {};
  }
}

function getCredentialApiKey(
  credential: StoredCredential | undefined,
  provider: string,
  label: string,
): string | undefined {
  if (!credential) return undefined;

  if (credential.type === "api_key" && typeof credential.key === "string") {
    return credential.key;
  }

  if (credential.type === "oauth" && typeof credential.access === "string") {
    if (typeof credential.expires === "number" && credential.expires <= Date.now()) {
      console.warn(
        `[Flue] ${label} OAuth token for ${provider} is expired; re-run login for that provider.`,
      );
      return undefined;
    }
    return credential.access;
  }

  return undefined;
}

export function getPiAuthApiKey(provider: string): string | undefined {
  return getCredentialApiKey(readAuthFile(PI_AUTH_PATH, "Pi")[provider], provider, "Pi");
}

function getOpenCodeAuthApiKey(provider: string): string | undefined {
  const authProvider = OPENCODE_AUTH_PROVIDER_ALIASES.get(provider) ?? provider;
  return getCredentialApiKey(
    readAuthFile(OPENCODE_AUTH_PATH, "OpenCode")[authProvider],
    provider,
    "OpenCode",
  );
}

export function getAuthApiKey(provider: string): string | undefined {
  return getPiAuthApiKey(provider) ?? getOpenCodeAuthApiKey(provider);
}

function withStoredCredential(provider: Provider, token: string): Provider {
  return {
    ...provider,
    auth: {
      apiKey: {
        name: `${provider.name} stored credential`,
        resolve: async () => ({
          auth: { apiKey: token },
          source: "Better Review credential store",
        }),
      },
    },
  };
}

export function getFlueProviders(): Provider[] {
  return builtinProviders().map((provider) => {
    const token = PI_OAUTH_PROVIDER_IDS.includes(provider.id)
      ? getAuthApiKey(provider.id)
      : undefined;
    return token && !findEnvKeys(provider.id)?.length
      ? withStoredCredential(provider, token)
      : provider;
  });
}

export function hasPiOAuthProvider(provider: string): boolean {
  return Boolean(getAuthApiKey(provider));
}
