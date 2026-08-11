import { mkdirSync } from "node:fs";
import path from "node:path";

import { sqlite, start, type Flue } from "@flue/runtime/node";
import { createAgentRouter } from "@flue/runtime/routing";
import { Hono } from "hono";

import { STORE_BASE_DIR } from "../store";
import { cleanupOrphanedMicrosandboxes, shutdownMicrosandboxes } from "./microsandbox";
import { getFlueProviders } from "./oauth-auth";
import { PrReviewer } from "./pr-reviewer";

export const FLUE_V2_DATABASE_PATH =
  process.env.BETTER_REVIEW_FLUE_V2_DB_PATH ?? path.join(STORE_BASE_DIR, "flue-v2.sqlite");

let runtime: Flue | null = null;
let starting: Promise<Flue> | null = null;

export async function startFlueReviewRuntime(): Promise<void> {
  if (runtime) return;
  if (!starting) {
    starting = (async () => {
      mkdirSync(path.dirname(FLUE_V2_DATABASE_PATH), { recursive: true });
      await cleanupOrphanedMicrosandboxes();
      return start({
        agents: [{ agent: PrReviewer, name: "pr-reviewer" }],
        db: sqlite(FLUE_V2_DATABASE_PATH),
        env: process.env,
        providers: getFlueProviders(),
      });
    })();
  }

  try {
    runtime = await starting;
  } finally {
    starting = null;
  }
}

export async function stopFlueReviewRuntime(): Promise<void> {
  const active = runtime;
  runtime = null;
  await Promise.allSettled([active?.stop(), shutdownMicrosandboxes()]);
}

export function createFlueReviewApp(): Hono {
  const app = new Hono();
  app.route("/agents/pr-reviewer", createAgentRouter(PrReviewer));
  return app;
}

export async function readFlueConversationHistory(instanceId: string): Promise<unknown | null> {
  const response = await createFlueReviewApp().request(
    `http://localhost/agents/pr-reviewer/${encodeURIComponent(instanceId)}`,
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to read Flue conversation history: HTTP ${response.status}`);
  }

  return response.json();
}
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
