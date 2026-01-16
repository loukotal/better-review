import type { Event as OpenCodeEvent } from "@opencode-ai/sdk/v2";
import { Effect, Fiber, Option, PubSub, Ref, Schedule, Stream } from "effect";

import { OpencodeService } from "./opencode";
import { transformEvent } from "./stream";

// =============================================================================
// Types
// =============================================================================

export type ConnectionState =
  | { _tag: "Disconnected" }
  | { _tag: "Connecting" }
  | { _tag: "Connected" }
  | { _tag: "Reconnecting"; attempt: number }
  | { _tag: "Error"; error: string };

// =============================================================================
// EventBroadcaster Service
// =============================================================================

export class EventBroadcaster extends Effect.Service<EventBroadcaster>()("EventBroadcaster", {
  scoped: Effect.gen(function* () {
    const eventPubSub = yield* PubSub.unbounded<OpenCodeEvent>();

    // Connection state
    const stateRef = yield* Ref.make<ConnectionState>({
      _tag: "Disconnected",
    });

    // Subscriber count (for connection lifecycle management)
    const subscriberCountRef = yield* Ref.make(0);

    // Connection fiber reference (null when not connected)
    const connectionFiberRef = yield* Ref.make<Fiber.RuntimeFiber<void, Error> | null>(null);

    // Idle timeout fiber (for delayed connection shutdown)
    const idleTimeoutFiberRef = yield* Ref.make<Fiber.RuntimeFiber<void, never> | null>(null);

    // Idle timeout duration (keep connection alive for 5 seconds after last subscriber)
    const IDLE_TIMEOUT_MS = 5000;

    // Get OpenCode service
    const opencode = yield* OpencodeService;

    yield* Effect.log("[EventBroadcaster] Service initialized");

    // ========================================
    // Helpers
    // ========================================

    const setState = (state: ConnectionState) =>
      Effect.gen(function* () {
        yield* Ref.set(stateRef, state);
        yield* Effect.log(`[EventBroadcaster] State: ${state._tag}`);
      });

    const getSubscriberCount = Ref.get(subscriberCountRef);

    const incrementSubscribers = Ref.updateAndGet(subscriberCountRef, (n) => n + 1);

    const decrementSubscribers = Ref.updateAndGet(subscriberCountRef, (n) => Math.max(0, n - 1));

    // ========================================
    // SSE Connection Logic
    // ========================================

    // Create the SSE stream from OpenCode
    const createSSEStream = () =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          yield* Effect.log("[EventBroadcaster] Connecting to OpenCode SSE...");

          const { stream } = yield* Effect.tryPromise({
            try: () => opencode.client.event.subscribe({}),
            catch: (e) => new Error(`SSE connect failed: ${e}`),
          });

          yield* Effect.log("[EventBroadcaster] SSE connection established");

          // Convert async iterable to Effect Stream
          return Stream.fromAsyncIterable(stream as AsyncIterable<OpenCodeEvent>, (e) =>
            e instanceof Error ? e : new Error(`SSE error: ${e}`),
          );
        }),
      );

    // Run the SSE connection, publishing events to PubSub
    const runConnection: Effect.Effect<void, Error> = Effect.gen(function* () {
      yield* setState({ _tag: "Connecting" });

      let isFirstEvent = true;

      yield* createSSEStream().pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            // Mark as connected on first event
            if (isFirstEvent) {
              isFirstEvent = false;
              resetRetryAttempt();
              yield* setState({ _tag: "Connected" });
            }

            // Publish to all subscribers
            yield* PubSub.publish(eventPubSub, event);
          }),
        ),
        Stream.runDrain,
      );
    }).pipe(
      Effect.tapError((error) =>
        Effect.log(`[EventBroadcaster] Connection error: ${error.message}`),
      ),
      Effect.onInterrupt(() =>
        Effect.gen(function* () {
          yield* Effect.log("[EventBroadcaster] Connection interrupted");
          yield* setState({ _tag: "Disconnected" });
        }),
      ),
    );

    // Reconnection schedule: exponential backoff capped at 30s
    // intersect takes the max delay (caps exponential), union takes the min (floor)
    let retryAttempt = 0;
    const resetRetryAttempt = () => {
      retryAttempt = 0;
    };
    const reconnectSchedule = Schedule.exponential("1 second").pipe(
      Schedule.intersect(Schedule.spaced("30 seconds")),
      Schedule.tapInput(() =>
        Effect.gen(function* () {
          retryAttempt++;
          yield* setState({ _tag: "Reconnecting", attempt: retryAttempt });
        }),
      ),
    );

    // Connection with auto-retry
    const connectionWithRetry = runConnection.pipe(
      Effect.retry(reconnectSchedule),
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* setState({ _tag: "Error", error: error.message });
          yield* Effect.log(`[EventBroadcaster] Giving up after retries: ${error.message}`);
        }),
      ),
    );

    // ========================================
    // Connection Lifecycle Management
    // ========================================

    // Start the connection if not already running
    const ensureConnection = Effect.gen(function* () {
      const existingFiber = yield* Ref.get(connectionFiberRef);

      if (existingFiber !== null) {
        return;
      }

      yield* Effect.log("[EventBroadcaster] Starting connection...");

      // Fork the connection - it runs until interrupted
      const fiber = yield* Effect.forkDaemon(connectionWithRetry);
      yield* Ref.set(connectionFiberRef, fiber);
    });

    // Stop the connection
    const stopConnection = Effect.gen(function* () {
      const fiber = yield* Ref.get(connectionFiberRef);

      if (fiber === null) {
        return;
      }

      yield* Effect.log("[EventBroadcaster] Stopping connection...");
      yield* Fiber.interrupt(fiber);
      yield* Ref.set(connectionFiberRef, null);
      yield* setState({ _tag: "Disconnected" });
    });

    // Cancel any pending idle timeout
    const cancelIdleTimeout = Effect.gen(function* () {
      const idleFiber = yield* Ref.get(idleTimeoutFiberRef);
      if (idleFiber !== null) {
        yield* Fiber.interrupt(idleFiber);
        yield* Ref.set(idleTimeoutFiberRef, null);
        yield* Effect.log("[EventBroadcaster] Cancelled idle timeout");
      }
    });

    // Schedule connection stop after idle timeout
    const scheduleIdleStop = Effect.gen(function* () {
      yield* cancelIdleTimeout;

      yield* Effect.log(`[EventBroadcaster] Scheduling connection stop in ${IDLE_TIMEOUT_MS}ms...`);

      const idleFiber = yield* Effect.forkDaemon(
        Effect.gen(function* () {
          yield* Effect.sleep(IDLE_TIMEOUT_MS);

          const count = yield* getSubscriberCount;
          if (count === 0) {
            yield* Effect.log("[EventBroadcaster] Idle timeout reached, stopping connection...");
            yield* stopConnection;
          } else {
            yield* Effect.log(
              "[EventBroadcaster] Idle timeout reached but subscribers exist, keeping connection",
            );
          }

          yield* Ref.set(idleTimeoutFiberRef, null);
        }),
      );

      yield* Ref.set(idleTimeoutFiberRef, idleFiber);
    });

    // Check subscriber count and manage connection lifecycle
    const maybeStartOrStopConnection = Effect.gen(function* () {
      const count = yield* getSubscriberCount;
      const fiber = yield* Ref.get(connectionFiberRef);

      if (count > 0 && fiber === null) {
        yield* cancelIdleTimeout;
        yield* ensureConnection;
      } else if (count > 0 && fiber !== null) {
        yield* cancelIdleTimeout;
      } else if (count === 0 && fiber !== null) {
        yield* scheduleIdleStop;
      }
    });

    // ========================================
    // Subscribe API - Returns Effect Stream
    // ========================================

    /**
     * Subscribe to events for a specific session.
     * Returns an Effect that yields a Stream of transformed StreamEvents.
     * The connection is started automatically on first subscriber.
     */
    const subscribe = (sessionId: string) =>
      Effect.gen(function* () {
        // Setup: increment count and ensure connection
        const count = yield* incrementSubscribers;
        yield* Effect.log(
          `[EventBroadcaster] Subscriber added for session ${sessionId}. Total: ${count}`,
        );
        yield* maybeStartOrStopConnection;

        // Return a Stream that:
        // 1. Subscribes to PubSub (scoped - auto-cleanup)
        // 2. Filters/transforms events for this session
        // 3. Cleans up subscriber count when done
        return Stream.fromPubSub(eventPubSub).pipe(
          Stream.filterMap((event) => Option.fromNullable(transformEvent(event, sessionId))),
          Stream.ensuring(
            Effect.gen(function* () {
              const count = yield* decrementSubscribers;
              yield* Effect.log(
                `[EventBroadcaster] Subscriber removed for session ${sessionId}. Total: ${count}`,
              );
              yield* maybeStartOrStopConnection;
            }),
          ),
        );
      });

    // ========================================
    // Cleanup on service shutdown
    // ========================================

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Effect.log("[EventBroadcaster] Shutting down...");
        yield* cancelIdleTimeout;
        yield* stopConnection;
        yield* PubSub.shutdown(eventPubSub);
      }),
    );

    // ========================================
    // Public API
    // ========================================

    return {
      /**
       * Subscribe to events for a session.
       * Returns an Effect that yields a Stream<StreamEvent>.
       */
      subscribe,

      /**
       * Get current connection state
       */
      getState: () => Ref.get(stateRef),

      /**
       * Get current subscriber count
       */
      getSubscriberCount: () => getSubscriberCount,
    };
  }),
  dependencies: [OpencodeService.Default],
}) {}
