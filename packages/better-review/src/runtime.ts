// =============================================================================
// Shared Runtime - Single source of truth for all Effect services
// =============================================================================

import { Layer, ManagedRuntime } from "effect";

import { EventBroadcaster } from "./event-broadcaster";
import { GhServiceLive } from "./gh/gh";
import { OpencodeService } from "./opencode";
import { DiffCacheService, PrContextService } from "./state";

// Single shared layer with all services
export const layers = Layer.mergeAll(
  GhServiceLive,
  OpencodeService.Default,
  DiffCacheService.Default,
  PrContextService.Default,
  EventBroadcaster.Default,
);

// Single shared runtime - used by main app, tRPC handlers, and REST endpoints
// This ensures all code paths share the same service instances (including Refs)
export const runtime = ManagedRuntime.make(layers);
