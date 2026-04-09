// Re-export the shared runtime for use in tRPC procedures
export { runtime } from "../runtime";
export { opencodeRuntime } from "../runtime";

// Type representing all services provided by the runtime
export type RuntimeContext = unknown;

// Context type for tRPC procedures
export interface TRPCContext {
  gh: unknown;
  opencode: unknown;
  diffCache: unknown;
  prContext: unknown;
}

// Create context is called for each request
export async function createContext(): Promise<TRPCContext> {
  // Services are accessed via the runtime in procedures
  return {} as TRPCContext;
}
