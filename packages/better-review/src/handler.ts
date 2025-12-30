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
 * Extract a user-friendly error message from an error
 */
const getErrorMessage = (error: unknown): string => {
  let current = error;

  // Unwrap Effect Cause (Fail has .error, Die has .defect)
  if (current && typeof current === "object") {
    const obj = current as Record<string, unknown>;
    if (obj._tag === "Fail" && obj.error) current = obj.error;
    else if (obj._tag === "Die" && obj.defect) current = obj.defect;
  }

  // Unwrap nested .cause (GhError, etc)
  while (current && typeof current === "object" && "cause" in current) {
    const cause = (current as { cause: unknown }).cause;
    if (typeof cause === "string") return cause;
    current = cause;
  }

  // Check stderr first (shell errors)
  if (current && typeof current === "object" && "stderr" in current) {
    const stderr = String((current as { stderr: unknown }).stderr || "").trim();
    if (stderr.includes("HTTP 404")) return "PR not found";
    if (stderr) return stderr;
  }

  // For Error objects, use message
  if (current instanceof Error) return current.message;

  return String(current);
};

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
      Effect.catchAllCause((cause) =>
        Effect.succeed(
          Response.json({ error: getErrorMessage(cause) }, { status: 500 }),
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
      Effect.catchAllCause((cause) =>
        Effect.succeed(
          Response.json({ error: getErrorMessage(cause) }, { status: 500 }),
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
