import { createHmac, randomBytes } from "node:crypto";

import { measure } from "./metrics";

export interface ToolOutputObservation {
  /** True when any layer clipped the response, including upstream sandbox clipping. */
  truncated?: boolean;
  cacheHit?: boolean;
  /** For tools which return an error result instead of throwing. */
  isError?: boolean;
}

export interface ToolObservation {
  /** Report each output chunk once, after tool-layer clipping. Never retains the text. */
  output(text: string, metadata?: ToolOutputObservation): void;
  /** For cache hits or truncation discovered without an output chunk. Flags are per call. */
  metadata(metadata: ToolOutputObservation): void;
}

/** One tracker per reviewer extension/submission. No global request cache or raw arguments.
 * Repeats mean identical requests within the last 256 distinct observed requests, not cache hits.
 * Replayed executions count again; historical durable tool results do not call this wrapper.
 */
export function createToolObservability() {
  const secret = randomBytes(32);
  const recent = new Set<string>();

  function fingerprint(name: string, args: unknown): string | undefined {
    const hash = createHmac("sha256", secret);
    let remaining = 4096;
    const ancestors = new Set<object>();
    function visit(value: unknown, depth: number): boolean {
      if (--remaining < 0 || depth > 32) return false;
      if (value === null || typeof value !== "object") {
        if (!["string", "number", "boolean", "undefined"].includes(typeof value) && value !== null)
          return false;
        hash.update(`${typeof value}:`);
        const text = value === undefined ? "undefined" : String(value);
        hash.update(`${Buffer.byteLength(text)}:`);
        hash.update(text);
        return true;
      }
      const array = Array.isArray(value);
      const prototype = Object.getPrototypeOf(value);
      // Only JSON-like argument containers have defined structural semantics here.
      // Dates, Maps, Sets, etc. must not all masquerade as the same empty object.
      if (!array && prototype !== Object.prototype && prototype !== null) return false;
      if (ancestors.has(value)) return false;
      ancestors.add(value);
      hash.update(array ? `[${value.length}:` : "{");
      // Refuse oversized structures rather than retaining a large sorted key list.
      const keys: string[] = [];
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (keys.length >= remaining) return false;
        keys.push(key);
      }
      if (!array) keys.sort();
      for (const key of keys) {
        if (!visit(key, depth + 1) || !visit((value as Record<string, unknown>)[key], depth + 1))
          return false;
      }
      hash.update(array ? "]" : "}");
      ancestors.delete(value);
      return true;
    }
    try {
      return visit(name, 0) && visit(args, 0) ? hash.digest("hex") : undefined;
    } catch {
      // Unusual/cyclic arguments must never prevent a tool from running.
      return undefined;
    }
  }

  return {
    /** Clear the repeat window when a revision/submission changes; not a result cache. */
    reset() {
      recent.clear();
    },
    async observe<T>(
      name: string,
      args: unknown,
      execute: (observation: ToolObservation) => T | Promise<T>,
    ): Promise<T> {
      const started = performance.now();
      const key = fingerprint(name, args);
      const repeated = key !== undefined && recent.has(key);
      if (key !== undefined) {
        recent.delete(key);
        recent.add(key);
        if (recent.size > 256) recent.delete(recent.values().next().value!);
      }
      let bytes = 0;
      let truncated = false;
      let cacheHit = false;
      let failed = false;
      let finished = false;
      const metadata = (value: ToolOutputObservation) => {
        if (finished) return;
        truncated ||= value.truncated === true;
        cacheHit ||= value.cacheHit === true;
        failed ||= value.isError === true;
      };
      try {
        return await execute({
          output(text, value = {}) {
            if (finished) return;
            bytes += Buffer.byteLength(text);
            metadata(value);
          },
          metadata,
        });
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        finished = true;
        measure("tool.duration.ms", performance.now() - started);
        measure("tool.output.bytes", bytes);
        measure("tool.truncated", Number(truncated));
        measure("tool.repeated", Number(repeated));
        measure("tool.cache_hit", Number(cacheHit));
        measure("tool.errors", Number(failed));
      }
    },
  };
}
