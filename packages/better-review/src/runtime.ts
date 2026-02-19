// =============================================================================
// Shared Runtime - Single source of truth for all Effect services
// =============================================================================

import { Layer, ManagedRuntime } from "effect";

import { EventBroadcasterLive } from "./event-broadcaster";
import { GhServiceLive } from "./gh/gh";
import { OpencodeServiceLive } from "./opencode";
import { DiffCacheServiceLive, PrContextServiceLive, PrListCacheServiceLive } from "./state";

// Single shared layer with all services
export const layers = Layer.mergeAll(
  GhServiceLive,
  OpencodeServiceLive,
  DiffCacheServiceLive,
  PrContextServiceLive,
  PrListCacheServiceLive,
  EventBroadcasterLive,
) as Layer.Layer<unknown, unknown, never>;

// Single shared runtime - used by main app, tRPC handlers, and REST endpoints
// This ensures all code paths share the same service instances (including Refs)
export const runtime = ManagedRuntime.make(layers);
