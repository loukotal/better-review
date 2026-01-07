import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { Effect } from "effect";
import type { TRPCContext, RuntimeContext } from "./context";
import { runtime } from "./context";
import { getErrorMessage } from "../response";

// Initialize tRPC with superjson transformer for proper serialization
const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        // Include the original error message for debugging
        effectError: error.cause instanceof Error ? error.cause.message : null,
      },
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;

/**
 * Helper to run Effect in tRPC procedures.
 * Converts Effect errors to TRPCError with appropriate codes.
 * Accepts effects that require RuntimeContext (the services provided by our layers).
 */
export async function runEffect<A>(
  effect: Effect.Effect<A, unknown, RuntimeContext>,
): Promise<A> {
  return runtime.runPromise(
    effect.pipe(
      Effect.catchAll((error) =>
        Effect.fail(
          new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: getErrorMessage(error),
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
        ),
      ),
    ),
  );
}

/**
 * Map specific error patterns to tRPC error codes
 */
export function effectToTRPCError(error: unknown): TRPCError {
  const message = getErrorMessage(error);

  // Map common error patterns to appropriate codes
  if (message.includes("not found") || message.includes("404")) {
    return new TRPCError({ code: "NOT_FOUND", message });
  }
  if (message.includes("Invalid") || message.includes("Missing")) {
    return new TRPCError({ code: "BAD_REQUEST", message });
  }
  if (message.includes("unauthorized") || message.includes("401")) {
    return new TRPCError({ code: "UNAUTHORIZED", message });
  }
  if (message.includes("forbidden") || message.includes("403")) {
    return new TRPCError({ code: "FORBIDDEN", message });
  }

  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
}
