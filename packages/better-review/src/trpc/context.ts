import type { Effect } from "effect";

import type { GhService } from "../gh/gh";
import type { OpencodeService } from "../opencode";
import type { DiffCacheService, PrContextService } from "../state";

// Re-export the shared runtime for use in tRPC procedures
export { runtime } from "../runtime";

// Type representing all services provided by the runtime
export type RuntimeContext = GhService | OpencodeService | DiffCacheService | PrContextService;

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
