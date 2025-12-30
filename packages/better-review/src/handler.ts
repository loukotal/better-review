import { Effect } from "effect";
import { runtime, type AppRequirements } from "./runtime";

/**
 * Error response structure
 */
export interface ErrorResponse {
  error: string;
  status?: number;
}

/**
 * Runs an Effect and returns a JSON Response.
 * Handles errors by returning a JSON error response with appropriate status codes.
 */
export const handleEffect = <A>(
  effect: Effect.Effect<A, unknown, AppRequirements>,
): Promise<Response> =>
  runtime.runPromise(
    effect.pipe(
      Effect.map((data) => Response.json(data)),
      Effect.catchAll((error) =>
        Effect.succeed(
          Response.json({ error: String(error) }, { status: 500 }),
        ),
      ),
    ),
  );

/**
 * Runs an Effect that returns a Response directly.
 * Use this for SSE endpoints or custom Response handling.
 */
export const handleEffectResponse = (
  effect: Effect.Effect<Response, unknown, AppRequirements>,
): Promise<Response> =>
  runtime.runPromise(
    effect.pipe(
      Effect.catchAll((error) =>
        Effect.succeed(
          Response.json({ error: String(error) }, { status: 500 }),
        ),
      ),
    ),
  );

/**
 * Creates a validation error response
 */
export const validationError = (message: string): Response =>
  Response.json({ error: message }, { status: 400 });

/**
 * Creates a not found error response  
 */
export const notFoundError = (message: string): Response =>
  Response.json({ error: message }, { status: 404 });

/**
 * Creates a service unavailable error response
 */
export const serviceUnavailableError = (message: string): Response =>
  Response.json({ error: message }, { status: 503 });
