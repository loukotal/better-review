import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { getModelType, isModelType, type AnyModel, type Provider } from "@earendil-works/pi-ai";
import {
  builtinProviders,
  getBuiltinModelDataGeneratedAt,
} from "@earendil-works/pi-ai/providers/all";

const PI_MODELS_STORE_PATH =
  process.env.BETTER_REVIEW_PI_MODELS_STORE_PATH ??
  path.join(homedir(), ".pi", "agent", "models-store.json");

type StoredCatalog = { models?: unknown; lastModified?: unknown };

/** Models pi fetched from its remote catalog (`pi update --models`), newer than pi-ai's built-in data. */
function readPiCatalog(): ReadonlyMap<string, readonly AnyModel[]> {
  let stored: Record<string, StoredCatalog>;
  try {
    stored = JSON.parse(readFileSync(PI_MODELS_STORE_PATH, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn(
        `[Models] Ignoring unreadable pi model catalog at ${PI_MODELS_STORE_PATH}:`,
        error,
      );
    return new Map();
  }
  const builtinAt = getBuiltinModelDataGeneratedAt();
  const catalogs = new Map<string, readonly AnyModel[]>();
  for (const [providerId, entry] of Object.entries(stored ?? {})) {
    // Same rule as pi: an overlay no newer than the bundled data would only reintroduce stale entries.
    if (typeof entry?.lastModified !== "number" || (builtinAt && entry.lastModified <= builtinAt))
      continue;
    if (!Array.isArray(entry.models)) continue;
    catalogs.set(
      providerId,
      entry.models
        .filter(
          (model): model is AnyModel =>
            !!model && typeof model === "object" && typeof model.id === "string",
        )
        .map((model) => ({ ...model, provider: providerId })),
    );
  }
  return catalogs;
}

function mergeModels<T extends AnyModel>(baseline: readonly T[], overlay: readonly T[]): T[] {
  const merged = new Map<string, T>();
  for (const model of [...baseline, ...overlay])
    merged.set(`${getModelType(model)}\0${model.id}`, model);
  return [...merged.values()];
}

const piCatalog = readPiCatalog();

function withPiCatalog(provider: Provider): Provider {
  const overlay = piCatalog.get(provider.id);
  if (!overlay?.length) return provider;
  return {
    ...provider,
    getModels: () =>
      mergeModels(
        provider.getModels(),
        overlay.filter((model) => isModelType(model, "chat")),
      ) as ReturnType<Provider["getModels"]>,
    getAllModels: () => mergeModels(provider.getAllModels?.() ?? provider.getModels(), overlay),
  };
}

/** pi-ai's built-in providers plus the models in pi's refreshed catalog. Read once at startup. */
export function catalogProviders(): Provider[] {
  return builtinProviders().map(withPiCatalog);
}
