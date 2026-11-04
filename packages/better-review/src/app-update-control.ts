import { timingSafeEqual } from "node:crypto";

import type { AppUpdateControl, AppUpdateJob, AppUpdateStatus } from "@better-review/shared";

export function createAppUpdateControl(options: {
  instanceId: string;
  apiToken?: string | null;
  authDisabled?: boolean;
  supervisorUrl?: string;
  supervisorToken?: string;
  checkStatus: (options?: { refresh?: boolean }) => Promise<AppUpdateStatus>;
  fetch?: typeof fetch;
}) {
  const supported =
    !!options.apiToken &&
    !options.authDisabled &&
    !!options.supervisorUrl &&
    !!options.supervisorToken;
  const requestSupervisor = async (path: string, body?: unknown) => {
    const response = await (options.fetch ?? fetch)(`${options.supervisorUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${options.supervisorToken}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new Error(
        "The restart supervisor is unavailable. Restart Better Review from its terminal.",
      );
    return (await response.json()) as { job?: AppUpdateJob };
  };
  return {
    supported,
    async status(): Promise<AppUpdateControl> {
      return {
        supported,
        instanceId: options.instanceId,
        ...(supported ? await requestSupervisor("/status") : {}),
      };
    },
    async start(request: Request): Promise<Response> {
      const supplied = Buffer.from(
        request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
      );
      const expected = Buffer.from(options.apiToken ?? "");
      // Cookie-only requests cannot restart the host. Require the explicit token header.
      if (
        !expected.length ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        return Response.json(
          { error: "An authenticated token header is required to restart Better Review." },
          { status: 403 },
        );
      if (!supported)
        return Response.json(
          {
            error:
              "Start Better Review with pnpm dev or pnpm start:production once to enable one-click updates.",
          },
          { status: 409 },
        );
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        return Response.json({ error: "Expected JSON" }, { status: 415 });
      try {
        const input = (await request.json()) as {
          checkoutRevision?: unknown;
          targetRevision?: unknown;
          requestId?: unknown;
        };
        if (
          !input ||
          typeof input.requestId !== "string" ||
          !/^[a-f0-9-]{36}$/.test(input.requestId)
        )
          return Response.json({ error: "Invalid update request ID" }, { status: 400 });
        const existing = await requestSupervisor("/status");
        if (
          existing.job &&
          (existing.job.id === input.requestId || !["ready", "failed"].includes(existing.job.phase))
        )
          return Response.json(
            {
              supported: true,
              instanceId: existing.job.previousInstanceId ?? options.instanceId,
              ...existing,
            },
            { status: 202 },
          );
        const status = await options.checkStatus({ refresh: true });
        if (
          !status.updateAvailable ||
          status.updateAction === "diverged" ||
          input.checkoutRevision !== status.checkoutRevision ||
          input.targetRevision !== status.latestRevision
        )
          return Response.json(
            {
              error:
                "Update information changed or the checkout has diverged. Check for updates again.",
            },
            { status: 409 },
          );
        const result = await requestSupervisor("/update", {
          requestId: input.requestId,
          checkoutRevision: status.checkoutRevision,
          targetRevision: status.latestRevision,
          instanceId: options.instanceId,
        });
        return Response.json(
          { supported: true, instanceId: options.instanceId, ...result },
          { status: 202 },
        );
      } catch (error) {
        return Response.json(
          {
            error:
              error instanceof SyntaxError
                ? "Invalid update request"
                : "Could not contact the restart supervisor. Check the Better Review terminal.",
          },
          { status: error instanceof SyntaxError ? 400 : 503 },
        );
      }
    },
  };
}
