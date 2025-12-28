import { Layer, ManagedRuntime } from "effect";
import { GhServiceLive } from "./gh/gh";

const layers = Layer.mergeAll(GhServiceLive);

export const runtime = ManagedRuntime.make(layers);
