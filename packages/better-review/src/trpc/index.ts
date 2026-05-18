import { initTRPC, TRPCError } from "@trpc/server";
import { Effect } from "effect";
import superjson from "superjson";

import { getErrorMessage } from "../response";
import type { TRPCContext, RuntimeContext } from "./context";
import { opencodeRuntime, runtime } from "./context";

// Initialize tRPC with superjson transformer for proper serialization
const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        // Include the original error message for debugging
        effectError: error.cause ? getErrorMessage(error.cause) : null,
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
export async function runEffect<A>(effect: Effect.Effect<A, unknown, RuntimeContext>): Promise<A> {
  try {
    return await runtime.runPromise(effect);
  } catch (error) {
    throw effectToTRPCError(error);
  }
}

export async function runOpencodeEffect<A>(
  effect: Effect.Effect<A, unknown, RuntimeContext>,
): Promise<A> {
  try {
    return await opencodeRuntime.runPromise(effect);
  } catch (error) {
    throw effectToTRPCError(error);
  }
}

/**
 * Map specific error patterns to tRPC error codes
 */
export function effectToTRPCError(error: unknown): TRPCError {
  const message = getErrorMessage(error);
  const lowerMessage = message.toLowerCase();

  // Map common error patterns to appropriate codes
  if (lowerMessage.includes("not found") || lowerMessage.includes("404")) {
    return new TRPCError({ code: "NOT_FOUND", message, cause: error });
  }
  if (lowerMessage.includes("unauthorized") || lowerMessage.includes("401")) {
    return new TRPCError({ code: "UNAUTHORIZED", message, cause: error });
  }
  if (
    lowerMessage.includes("forbidden") ||
    lowerMessage.includes("403") ||
    lowerMessage.includes("missing required scopes")
  ) {
    return new TRPCError({ code: "FORBIDDEN", message, cause: error });
  }
  if (lowerMessage.includes("invalid") || lowerMessage.includes("missing")) {
    return new TRPCError({ code: "BAD_REQUEST", message, cause: error });
  }

  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message, cause: error });
}
