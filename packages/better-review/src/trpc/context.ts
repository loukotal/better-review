import { Effect, Layer, ManagedRuntime } from "effect";
import { GhService, GhServiceLive } from "../gh/gh";
import { OpencodeService } from "../opencode";
import { DiffCacheService, PrContextService } from "../state";

// Layer with all services
const layers = Layer.mergeAll(
  GhServiceLive,
  OpencodeService.Default,
  DiffCacheService.Default,
  PrContextService.Default,
);

// Type representing all services provided by the runtime
export type RuntimeContext =
  | GhService
  | OpencodeService
  | DiffCacheService
  | PrContextService;

// Create a managed runtime that can be reused across requests
export const runtime = ManagedRuntime.make(layers);

// Context type for tRPC procedures
export interface TRPCContext {
  gh: Effect.Effect.Context<typeof GhService>;
  opencode: Effect.Effect.Context<typeof OpencodeService>;
  diffCache: Effect.Effect.Context<typeof DiffCacheService>;
  prContext: Effect.Effect.Context<typeof PrContextService>;
}

// Create context is called for each request
export async function createContext(): Promise<TRPCContext> {
  // Services are accessed via the runtime in procedures
  return {} as TRPCContext;
}
