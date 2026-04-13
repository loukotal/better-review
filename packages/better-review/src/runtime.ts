// =============================================================================
// Shared Runtime - Single source of truth for all Effect services
// =============================================================================

import { Layer, ManagedRuntime } from "effect";

import { ReviewSessionServiceLive } from "./agent-sessions";
import { EventBroadcasterLive } from "./event-broadcaster";
import { GhServiceLive } from "./gh/gh";
import { OpencodeServiceLive } from "./opencode";
import { DiffCacheServiceLive, PrContextServiceLive, PrListCacheServiceLive } from "./state";

export const appLayers = Layer.mergeAll(
  GhServiceLive,
  DiffCacheServiceLive,
  PrContextServiceLive,
  PrListCacheServiceLive,
  ReviewSessionServiceLive,
  OpencodeServiceLive,
  EventBroadcasterLive,
) as Layer.Layer<unknown, unknown, never>;

// Single shared runtime for the whole app.
// Keep opencodeRuntime as an alias for compatibility with existing imports.
export const runtime = ManagedRuntime.make(appLayers);
export const opencodeRuntime = runtime;
