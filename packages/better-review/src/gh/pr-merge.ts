import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import type { PrMergeAttempt, PrMergeInput } from "@better-review/shared";

import { createPrDetailClient } from "./pr-detail";
import {
  credential,
  createPrDetailHttp,
  parsePrDetailUrl,
  PrDetailHttpError,
  type PrDetailHttpOptions,
} from "./pr-detail-http";

const method = z.enum(["merge", "squash", "rebase"]);
export const prMergeInput = z.object({
  url: z.string(),
  requestId: z.uuid(),
  expectedActor: z.object({ id: z.string().min(1), login: z.string().min(1) }),
  expectedHeadSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("merge"), method }),
    z.object({ kind: z.literal("enqueue") }),
    z.object({ kind: z.literal("admin-merge"), method }),
  ]),
});
const observationSchema = z.object({
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  headSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  queued: z.boolean().nullable(),
});
const attemptSchema = prMergeInput
  .pick({ requestId: true, url: true, expectedHeadSha: true, action: true })
  .extend({
    status: z.enum(["rejected", "uncertain", "succeeded"]),
    message: z.string(),
    dispatched: z.boolean(),
    updatedAt: z.iso.datetime(),
    observed: observationSchema.optional(),
  });
function decodeAttempt(value: unknown): PrMergeAttempt {
  if (typeof value !== "string") throw new Error("Invalid merge journal record.");
  try {
    const attempt = attemptSchema.parse(JSON.parse(value));
    if (
      parsePrDetailUrl(attempt.url).url !== attempt.url ||
      (attempt.status === "succeeded" && !attempt.dispatched)
    )
      throw new Error("invalid");
    return attempt;
  } catch {
    throw new Error("Invalid merge journal record. No dispatch is allowed.");
  }
}
export interface PrMergeOptions extends PrDetailHttpOptions {
  databasePath: string;
  /** Test seam. Production uses bounded execFile with an argument array. */
  admin?: (args: string[], env: NodeJS.ProcessEnv, timeout: number) => Promise<void>;
}
function admin(args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile("gh", args, { env, timeout, killSignal: "SIGKILL", maxBuffer: 65536 }, (error) =>
      error ? reject(new Error("Admin merge outcome is uncertain.")) : resolve(),
    ),
  );
}
/** Passive journal, not an outbox: no workers, schedules, retries, or startup dispatch. */
export function createPrMergeService(options: PrMergeOptions) {
  let db: DatabaseSync | undefined;
  const flights = new Map<string, Promise<PrMergeAttempt>>();
  function database() {
    if (db) return db;
    mkdirSync(dirname(options.databasePath), { recursive: true });
    const opened = new DatabaseSync(options.databasePath);
    try {
      const version = Number(opened.prepare("PRAGMA user_version").get()!.user_version);
      if (version > 1) throw new Error("Unsupported future merge journal schema.");
      opened.exec(
        "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS merge_attempts(request_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,data TEXT NOT NULL); PRAGMA user_version=1; COMMIT;",
      );
    } catch (error) {
      opened.close();
      throw error;
    }
    db = opened;
    return db;
  }
  function save(attempt: PrMergeAttempt) {
    return update(attempt.requestId, (current) => ({
      ...attempt,
      observed: current.observed ?? attempt.observed,
    }));
  }
  /** No await inside transaction. Reconciliation can only patch observations on the latest lifecycle. */
  function update(id: string, change: (current: PrMergeAttempt) => PrMergeAttempt) {
    const store = database();
    store.exec("BEGIN IMMEDIATE");
    try {
      const current = decodeAttempt(
        store.prepare("SELECT data FROM merge_attempts WHERE request_id=?").get(id)?.data,
      );
      if (current.requestId !== id) throw new Error("Merge journal record identity mismatch.");
      const next = attemptSchema.parse({ ...change(current), updatedAt: new Date().toISOString() });
      store
        .prepare("UPDATE merge_attempts SET data=? WHERE request_id=?")
        .run(JSON.stringify(next), id);
      store.exec("COMMIT");
      return next;
    } catch (error) {
      store.exec("ROLLBACK");
      throw error;
    }
  }
  async function execute(input: PrMergeInput): Promise<PrMergeAttempt> {
    const attempt: PrMergeAttempt = {
      requestId: input.requestId,
      url: input.url,
      expectedHeadSha: input.expectedHeadSha,
      action: input.action,
      status: "uncertain",
      message: "Attempt admitted. No automatic retry is allowed.",
      dispatched: false,
      updatedAt: new Date().toISOString(),
    };
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          input.url,
          input.expectedActor.id,
          input.expectedActor.login,
          input.expectedHeadSha,
          input.action.kind,
          "method" in input.action ? input.action.method : null,
        ]),
      )
      .digest("hex");
    let store: DatabaseSync;
    try {
      store = database();
    } catch {
      return {
        ...attempt,
        status: "rejected",
        message: "Merge journal unavailable. No request was dispatched.",
      };
    }
    store
      .prepare("INSERT OR IGNORE INTO merge_attempts VALUES(?,?,?)")
      .run(input.requestId, fingerprint, JSON.stringify(attempt));
    const row = store
      .prepare("SELECT fingerprint,data FROM merge_attempts WHERE request_id=?")
      .get(input.requestId)!;
    if (row.fingerprint !== fingerprint)
      throw new Error("Request UUID conflicts with a different merge intent.");
    const previous = decodeAttempt(row.data);
    if (
      previous.requestId !== input.requestId ||
      previous.url !== input.url ||
      previous.expectedHeadSha !== input.expectedHeadSha ||
      JSON.stringify(previous.action) !== JSON.stringify(input.action)
    )
      throw new Error("Merge journal intent mismatch. No dispatch is allowed.");
    // SQLite is the cross-process claim. Only the inserting connection may send.
    // changes() is read immediately after INSERT, before any other write.
    const inserted = Number(store.prepare("SELECT changes() AS n").get()!.n) === 1;
    if (!inserted) return previous;
    let token: string;
    try {
      token = await credential(options);
      const detail = await createPrDetailClient(options).get(input.url, token);
      if (detail.metadata.status === "available") {
        attempt.observed = {
          state: detail.metadata.data.state,
          headSha: detail.metadata.data.head.sha,
          queued:
            detail.mergeCapabilities.status === "available"
              ? !!detail.mergeCapabilities.data.queueEntry
              : null,
        };
      }
      if (
        detail.actor.status !== "available" ||
        detail.actor.data.id !== input.expectedActor.id ||
        detail.actor.data.login !== input.expectedActor.login
      )
        throw new Error("GitHub actor changed or could not be verified.");
      if (
        detail.metadata.status !== "available" ||
        detail.metadata.data.head.sha !== input.expectedHeadSha
      )
        throw new Error("Pull request head changed or could not be verified.");
      if (
        detail.mergeCapabilities.status !== "available" ||
        !detail.mergeCapabilities.data.actions.some(
          (c) =>
            c.enabled &&
            c.action.kind === input.action.kind &&
            (!("method" in c.action) ||
              ("method" in input.action && c.action.method === input.action.method)),
        )
      )
        throw new Error("Fresh GitHub evidence does not permit this action.");
      const id = detail.metadata.data.id;
      // Persist uncertainty BEFORE crossing the external side-effect boundary.
      attempt.dispatched = true;
      attempt.message = "Request dispatched. Outcome may require read-only reconciliation.";
      save(attempt);
      if (input.action.kind === "admin-merge") {
        // gh's --admin is the explicit bypass path. Never emulate bypass with REST merge.
        await (options.admin ?? admin)(
          [
            "pr",
            "merge",
            input.url,
            "--admin",
            "--match-head-commit",
            input.expectedHeadSha,
            `--${input.action.method}`,
          ],
          {
            ...(options.env ?? process.env),
            GH_TOKEN: token,
            GITHUB_TOKEN: token,
            GH_HOST: "github.com",
            GH_PROMPT_DISABLED: "1",
          },
          options.timeoutMs ?? 15000,
        );
        const after = await createPrDetailClient(options).get(input.url, token);
        if (after.metadata.status === "available")
          attempt.observed = {
            state: after.metadata.data.state,
            headSha: after.metadata.data.head.sha,
            queued:
              after.mergeCapabilities.status === "available"
                ? !!after.mergeCapabilities.data.queueEntry
                : null,
          };
        attempt.status = "uncertain";
        attempt.message =
          "Admin command exited successfully. CLI exit status does not prove a merge of the expected head or attribute any observed state to this request. No resend is allowed.";
        return update(attempt.requestId, () => attempt);
      } else {
        const http = createPrDetailHttp(options, token);
        if (input.action.kind === "merge") {
          const scope = parsePrDetailUrl(input.url);
          const result = z.object({ merged: z.boolean() }).parse(
            await http(`/repos/${scope.owner}/${scope.repo}/pulls/${scope.number}/merge`, "PUT", {
              sha: input.expectedHeadSha,
              merge_method: input.action.method,
            }),
          );
          if (!result.merged) throw new Error("GitHub did not confirm the merge.");
        } else {
          const result = z
            .object({
              data: z.object({
                enqueuePullRequest: z.object({ mergeQueueEntry: z.object({ id: z.string() }) }),
              }),
              errors: z.array(z.unknown()).optional(),
            })
            .parse(
              await http("/graphql", "POST", {
                query:
                  "mutation($input:EnqueuePullRequestInput!){enqueuePullRequest(input:$input){mergeQueueEntry{id}}}",
                variables: {
                  input: {
                    pullRequestId: id,
                    expectedHeadOid: input.expectedHeadSha,
                    clientMutationId: input.requestId,
                  },
                },
              }),
            );
          if (result.errors?.length) throw new Error("GitHub did not confirm enqueue.");
        }
      }
      attempt.status = "succeeded";
      attempt.message =
        input.action.kind === "enqueue"
          ? "GitHub confirmed enqueue for the expected head."
          : "GitHub confirmed merge for the expected head.";
    } catch (error) {
      const rejected = error instanceof PrDetailHttpError && error.definitiveRejection;
      attempt.status = attempt.dispatched && !rejected ? "uncertain" : "rejected";
      attempt.message = rejected
        ? error.message
        : attempt.dispatched
          ? "Outcome uncertain. Reconcile reads GitHub only; this request will never be resent."
          : error instanceof Error
            ? error.message
            : "Merge preflight failed.";
    }
    return save(attempt);
  }
  function merge(value: PrMergeInput): Promise<PrMergeAttempt> {
    const parsed = prMergeInput.parse(value);
    const scope = parsePrDetailUrl(parsed.url);
    const input = { ...parsed, url: scope.url };
    // Fingerprints are checked even for concurrent same-ID callers with changed input.
    const key = JSON.stringify(input);
    const existing = flights.get(key);
    if (existing) return existing;
    const pending = execute(input).finally(() => flights.delete(key));
    flights.set(key, pending);
    return pending;
  }
  async function reconcileMerge(input: {
    url: string;
    requestId: string;
  }): Promise<PrMergeAttempt> {
    const scope = parsePrDetailUrl(input.url);
    const row = database()
      .prepare("SELECT data FROM merge_attempts WHERE request_id=?")
      .get(input.requestId);
    if (!row) throw new Error("Merge attempt not found.");
    const attempt = decodeAttempt(row.data);
    if (attempt.requestId !== input.requestId)
      throw new Error("Merge journal record identity mismatch.");
    if (attempt.url !== scope.url)
      throw new Error("Merge attempt belongs to another pull request.");
    const detail = await createPrDetailClient(options).get(scope.url);
    if (detail.metadata.status === "available") {
      const observed = {
        state: detail.metadata.data.state,
        headSha: detail.metadata.data.head.sha,
        queued:
          detail.mergeCapabilities.status === "available"
            ? !!detail.mergeCapabilities.data.queueEntry
            : null,
      };
      return update(input.requestId, (current) => ({ ...current, observed }));
    }
    return decodeAttempt(
      database().prepare("SELECT data FROM merge_attempts WHERE request_id=?").get(input.requestId)
        ?.data,
    );
  }
  return {
    merge,
    reconcileMerge,
    close: () => {
      db?.close();
      db = undefined;
    },
  };
}
