import assert from "node:assert/strict";
import test from "node:test";

import { TRPCError } from "@trpc/server";
import { Data, Effect } from "effect";

import { getErrorMessage } from "./response";
import { effectToTRPCError } from "./trpc/index";

class DemoGhError extends Data.TaggedError("DemoGhError")<{
  readonly command: string;
  readonly cause: unknown;
}> {}

test("extracts messages from Effect FiberFailure errors", async () => {
  const ghScopeMessage =
    "error: your authentication token is missing required scopes [read:project]";

  await assert.rejects(
    Effect.runPromise(
      Effect.fail(
        new DemoGhError({
          command: "listProjects",
          cause: new Error(ghScopeMessage),
        }),
      ),
    ),
    (error) => {
      assert.equal(getErrorMessage(error), ghScopeMessage);

      const trpcError = effectToTRPCError(error);
      assert.ok(trpcError instanceof TRPCError);
      assert.equal(trpcError.code, "FORBIDDEN");
      assert.equal(trpcError.message, ghScopeMessage);

      return true;
    },
  );
});
