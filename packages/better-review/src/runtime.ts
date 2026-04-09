// =============================================================================
// Shared Runtime - Single source of truth for all Effect services
// =============================================================================

import { Layer, ManagedRuntime } from "effect";

import { ReviewSessionServiceLive } from "./agent-sessions";
import { EventBroadcasterLive } from "./event-broadcaster";
import { GhServiceLive } from "./gh/gh";
import { OpencodeServiceLive } from "./opencode";
import { DiffCacheServiceLive, PrContextServiceLive, PrListCacheServiceLive } from "./state";

// Base runtime for API startup and non-OpenCode routes
export const baseLayers = Layer.mergeAll(
  GhServiceLive,
  DiffCacheServiceLive,
  PrContextServiceLive,
  PrListCacheServiceLive,
  ReviewSessionServiceLive,
) as Layer.Layer<unknown, unknown, never>;

// OpenCode runtime for routes that need agent sessions / streaming
export const opencodeLayers = Layer.mergeAll(
  baseLayers,
  OpencodeServiceLive,
  EventBroadcasterLive,
) as Layer.Layer<unknown, unknown, never>;

// Shared runtime for non-OpenCode app paths
export const runtime = ManagedRuntime.make(baseLayers);

// Separate runtime that initializes OpenCode only on demand
export const opencodeRuntime = ManagedRuntime.make(opencodeLayers);
