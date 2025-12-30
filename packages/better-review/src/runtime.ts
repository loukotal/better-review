import { Layer, ManagedRuntime } from "effect";
import { GhServiceLive } from "./gh/gh";
import { OpencodeService } from "./opencode";
import { UnknownException } from "effect/Cause";

const layers = Layer.mergeAll(GhServiceLive, OpencodeService.Default);

/** The requirements (services) available in the runtime */
export type AppRequirements = Layer.Layer.Success<typeof layers>;

type AppRuntime = ManagedRuntime.ManagedRuntime<AppRequirements, UnknownException>;
declare global {
  var __runtime: AppRuntime | undefined;
}

export const runtime: AppRuntime =
  globalThis.__runtime ?? ManagedRuntime.make(layers);

globalThis.__runtime = runtime;

// Cleanup on HMR
if (import.meta.hot) {
  import.meta.hot.dispose(async () => {
    console.log("[HMR] Disposing runtime...");
    await runtime.dispose();
    globalThis.__runtime = undefined;
  });
}
