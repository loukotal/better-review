import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import lockfile from "proper-lockfile";

import {
  DEFAULT_GITHUB_QUEUE_TIMEOUT_MS,
  isGithubOutboxCommand,
  isGithubRemoteResult,
  type GithubOutboxCommand,
  type GithubOutboxOperation,
} from "@better-review/shared";

export class OutboxDatabase {
  private constructor(
    readonly db: DatabaseSync,
    private release: () => Promise<void>,
    private owner: string,
  ) {}
  private lost = false;
  get compromised(): boolean {
    if (!this.lost) {
      const row = this.db.prepare("SELECT token FROM owner WHERE singleton=1").get();
      this.lost = row?.token !== this.owner;
    }
    return this.lost;
  }
  static async open(path: string): Promise<OutboxDatabase> {
    await mkdir(dirname(path), { recursive: true });
    // Separate lock namespace: never lock the store directory used by Pi.
    let store: OutboxDatabase | undefined;
    const release = await lockfile.lock(dirname(path), {
      lockfilePath: `${path}.owner-lock`,
      realpath: false,
      retries: 0,
      stale: 60_000,
      update: 5_000,
      onCompromised: () => {
        if (store) store.lost = true;
      },
    });
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path);
      db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
      const version = (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version;
      if (version > 4) throw new Error("Unsupported future GitHub outbox schema");
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      if (version === 0) {
        db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE scopes (scope TEXT PRIMARY KEY, revision INTEGER NOT NULL, sequence INTEGER NOT NULL);
          CREATE TABLE operations (id TEXT PRIMARY KEY, scope TEXT NOT NULL REFERENCES scopes(scope), sequence INTEGER NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(scope,sequence));
          CREATE TABLE dependencies (operation_id TEXT NOT NULL REFERENCES operations(id), dependency_id TEXT NOT NULL REFERENCES operations(id), PRIMARY KEY(operation_id,dependency_id));
          CREATE TABLE controls (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL);
          CREATE TABLE leases (client TEXT PRIMARY KEY, scope TEXT NOT NULL, expires INTEGER NOT NULL);
          CREATE TABLE audit (id INTEGER PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id), at TEXT NOT NULL, event TEXT NOT NULL);
          CREATE TABLE owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), token TEXT NOT NULL);
          PRAGMA user_version=1;
          COMMIT;`);
      }
      // Early v1 stores predate owner fencing; a partially upgraded v2 can also
      // have schedules but no owner. Repair both only while holding owner-lock.
      // Operation JSON, fingerprints, attempts, audit and controls stay untouched.
      if (version < 3)
        db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), token TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS schedules (operation_id TEXT PRIMARY KEY REFERENCES operations(id), identity_failures INTEGER NOT NULL DEFAULT 0, reconcile_attempts INTEGER NOT NULL DEFAULT 0);
        PRAGMA user_version=3;
        COMMIT;`);
      if (version < 4) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const columns = db.prepare("PRAGMA table_info(operations)").all();
          for (const column of ["content_key", "synced_at"])
            if (!columns.some((row) => row.name === column))
              db.exec(`ALTER TABLE operations ADD COLUMN ${column} TEXT`);
          db.exec(`CREATE INDEX IF NOT EXISTS operations_content ON operations(scope,content_key);
            CREATE TABLE IF NOT EXISTS aliases (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id), fingerprint TEXT NOT NULL);
            PRAGMA user_version=4; COMMIT;`);
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
      const owner = randomUUID();
      db.exec(
        "CREATE TABLE IF NOT EXISTS admission_cycles (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL)",
      );
      db.prepare(
        "INSERT INTO owner(singleton,token) VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET token=excluded.token",
      ).run(owner);
      store = new OutboxDatabase(db, release, owner);
      store.transaction(() => {
        for (const row of db!.prepare("SELECT scope FROM scopes").all())
          store!.refreshContent(row.scope as string);
      });
      return store;
    } catch (error) {
      db?.close();
      await release();
      throw error;
    }
  }
  transaction<T>(fn: () => T): T {
    if (this.compromised) throw new Error("GitHub outbox ownership lost");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.compromised) throw new Error("GitHub outbox ownership lost");
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  get(id: string): GithubOutboxOperation | undefined {
    id = this.originalId(id);
    const row = this.db.prepare("SELECT data FROM operations WHERE id=?").get(id) as
      | { data: string }
      | undefined;
    return row ? this.decode(row.data) : undefined;
  }
  originalId(id: string): string {
    return (
      (this.db.prepare("SELECT operation_id FROM aliases WHERE id=?").get(id)?.operation_id as
        | string
        | undefined) ?? id
    );
  }
  /** Resolve admitted aliases without changing the original UUID replay fingerprint. */
  normalize(command: GithubOutboxCommand): GithubOutboxCommand {
    const copy = structuredClone(command);
    copy.dependencies = [...new Set(copy.dependencies.map((id) => this.originalId(id)))];
    if ("target" in copy.action && copy.action.target.source === "local")
      copy.action.target.operationId = this.originalId(copy.action.target.operationId);
    return copy;
  }
  semantic(command: GithubOutboxCommand): { key: string; target?: string } {
    const copy = this.normalize(command);
    const action = copy.action;
    let targetParent: string | undefined;
    if ("target" in action && action.target.source === "local") {
      targetParent = action.target.operationId;
      const parent = this.get(targetParent);
      const result =
        parent?.status === "synced" &&
        parent.command.scope.url === copy.scope.url &&
        parent.command.expectedActor.id === copy.expectedActor.id &&
        isGithubRemoteResult(parent.result)
          ? parent.result
          : undefined;
      if (action.target.kind === "thread" && result?.kind === "review-comment" && result.threadId)
        action.target = { source: "remote", kind: "thread", nodeId: result.threadId };
      else if (
        action.target.kind !== "thread" &&
        result?.kind === action.target.kind &&
        "id" in result
      )
        action.target = {
          source: "remote",
          kind: result.kind,
          id:
            action.kind === "reply" && result.kind === "review-comment"
              ? (result.inReplyToId ?? result.id)
              : result.id,
        };
    }
    if (action.kind === "reply" && action.target.source === "remote") {
      const id = action.target.id;
      const parent = this.list(copy.scope.url).find(
        (op) =>
          op.status === "synced" &&
          isGithubRemoteResult(op.result) &&
          op.command.expectedActor.id === copy.expectedActor.id &&
          (op.command.action.kind === "inline-comment" || op.command.action.kind === "reply") &&
          op.result?.kind === "review-comment" &&
          op.result.id === id,
      );
      if (parent?.result?.kind === "review-comment" && parent.result.inReplyToId)
        action.target.id = parent.result.inReplyToId;
    }
    // A resolved target already carries its creation dependency. Other explicit
    // dependencies remain semantic ordering constraints, even after syncing.
    const dependencies = copy.dependencies
      .filter(
        (id) => !(id === targetParent && "target" in action && action.target.source === "remote"),
      )
      .sort();
    const targetRef =
      "target" in action
        ? action.target.source === "local"
          ? { source: "local", kind: action.target.kind, operationId: action.target.operationId }
          : action.target.kind === "thread"
            ? { source: "remote", kind: "thread", nodeId: action.target.nodeId }
            : { source: "remote", kind: action.target.kind, id: action.target.id }
        : undefined;
    const semanticAction = {
      kind: action.kind,
      ...("body" in action ? { body: action.body } : {}),
      ...("expectedBody" in action ? { expectedBody: action.expectedBody } : {}),
      ...("expectedHeadSha" in action ? { expectedHeadSha: action.expectedHeadSha } : {}),
      ...(action.kind === "inline-comment"
        ? {
            anchor: {
              path: action.anchor.path,
              side: action.anchor.side,
              line: action.anchor.line,
              startLine: action.anchor.startLine,
              startSide: action.anchor.startSide,
            },
          }
        : {}),
      ...(targetRef ? { target: targetRef } : {}),
    };
    const target = targetRef ? canonical(targetRef) : undefined;
    const key = createHash("sha256")
      .update(
        canonical({
          scope: {
            host: copy.scope.host,
            owner: copy.scope.owner,
            repo: copy.scope.repo,
            number: copy.scope.number,
          },
          actorId: copy.expectedActor.id,
          action: semanticAction,
          dependencies,
        }),
      )
      .digest("hex");
    return { key, target };
  }
  refreshContent(scope: string): void {
    for (const op of this.list(scope)) {
      // Incomplete historical records remain replayable but are not dedup evidence.
      const key = isGithubOutboxCommand(op.command) ? this.semantic(op.command).key : null;
      this.db
        .prepare("UPDATE operations SET content_key=? WHERE id=?")
        .run(key, op.command.operationId);
    }
  }
  contentDuplicate(
    command: GithubOutboxCommand,
    now: number,
  ): { operation: GithubOutboxOperation; retryAt?: string } | undefined {
    const semantic = this.semantic(command);
    const rows = this.db
      .prepare(
        "SELECT data,synced_at FROM operations WHERE scope=? AND content_key=? ORDER BY sequence DESC",
      )
      .all(command.scope.url, semantic.key);
    for (const row of rows) {
      const op = this.decode(row.data as string);
      if (op.status === "cancelled") continue;
      // Old synced rows have no trustworthy first-synced timestamp. Do not infer
      // one from updatedAt, which may reflect much later metadata enrichment.
      if (
        op.status === "synced" &&
        (!row.synced_at ||
          !Number.isFinite(Date.parse(row.synced_at as string)) ||
          now - Date.parse(row.synced_at as string) >= 60_000)
      )
        continue;
      // Creations have an entity identity separate from their action target
      // (issue/inline comments have no target at all). A subsequent edit/delete
      // consumes that original effect; repeating its text is a new creation.
      const creationTargets = new Set<string>();
      const kind = op.command.action.kind;
      if (
        (kind === "approve" || kind === "request-changes" || kind === "review-comment") &&
        this.list(command.scope.url).some(
          (later) =>
            later.sequence > op.sequence &&
            later.status !== "cancelled" &&
            later.command.expectedActor.id === command.expectedActor.id &&
            (later.command.action.kind === "approve" ||
              later.command.action.kind === "request-changes" ||
              later.command.action.kind === "review-comment") &&
            this.semantic(later.command).key !== semantic.key,
        )
      )
        continue;
      if (kind === "issue-comment" || kind === "inline-comment" || kind === "reply") {
        const commentKind = kind === "issue-comment" ? "issue-comment" : "review-comment";
        creationTargets.add(
          canonical({ source: "local", kind: commentKind, operationId: op.command.operationId }),
        );
        if (
          op.status === "synced" &&
          isGithubRemoteResult(op.result) &&
          op.result.kind === commentKind
        )
          creationTargets.add(canonical({ source: "remote", kind: commentKind, id: op.result.id }));
      }
      if (
        (semantic.target || creationTargets.size) &&
        this.list(command.scope.url).some((later) => {
          if (
            later.sequence <= op.sequence ||
            later.status === "cancelled" ||
            !isGithubOutboxCommand(later.command)
          )
            return false;
          const next = this.semantic(later.command);
          return (
            (semantic.target !== undefined &&
              next.target === semantic.target &&
              next.key !== semantic.key) ||
            ((later.command.action.kind === "edit-comment" ||
              later.command.action.kind === "delete-comment") &&
              next.target !== undefined &&
              creationTargets.has(next.target))
          );
        })
      )
        continue;
      return {
        operation: op,
        retryAt:
          op.status === "synced"
            ? new Date(Date.parse(row.synced_at as string) + 60_000).toISOString()
            : undefined,
      };
    }
  }
  private decode(data: string): GithubOutboxOperation {
    const operation: GithubOutboxOperation = JSON.parse(data);
    operation.queueDeadlineAt ??=
      operation.command.queueDeadlineAt ??
      new Date(
        (Number.isFinite(Date.parse(operation.createdAt)) ? Date.parse(operation.createdAt) : 0) +
          (operation.command.queueTimeoutMs ?? DEFAULT_GITHUB_QUEUE_TIMEOUT_MS),
      ).toISOString();
    // Pre-contract JSON may lack retryMode. Project a safe default without
    // rewriting history/fingerprints just because the store was migrated.
    if (!operation.retryMode) {
      const manual = this.db
        .prepare(
          "SELECT 1 FROM audit WHERE operation_id=? AND json_valid(event) AND json_extract(event,'$.resolution.kind')='confirm-not-applied' LIMIT 1",
        )
        .get(operation.command.operationId);
      operation.retryMode = manual
        ? "manual"
        : operation.status === "queued" ||
            (operation.status === "retry-failed" &&
              operation.error?.retryable &&
              operation.nextAttemptAt)
          ? "automatic"
          : "blocked";
    }
    return operation;
  }
  list(scope?: string): GithubOutboxOperation[] {
    const rows =
      scope === undefined
        ? this.db.prepare("SELECT data FROM operations ORDER BY scope,sequence").all()
        : this.db.prepare("SELECT data FROM operations WHERE scope=? ORDER BY sequence").all(scope);
    return rows.map((row) => this.decode(row.data as string));
  }
  save(operation: GithubOutboxOperation): void {
    this.db
      .prepare(
        "UPDATE operations SET data=?,content_key=?,synced_at=CASE WHEN ?='synced' AND json_extract(data,'$.status')!='synced' THEN COALESCE(synced_at,?) ELSE synced_at END WHERE id=?",
      )
      .run(
        JSON.stringify(operation),
        isGithubOutboxCommand(operation.command) ? this.semantic(operation.command).key : null,
        operation.status,
        operation.updatedAt,
        operation.command.operationId,
      );
    // Creation results can resolve existing local targets (or reveal a reply's
    // root/thread later). Reindex those semantics at the same durable boundary,
    // rather than scanning/rebuilding all content keys on every admission.
    if (
      operation.status === "synced" &&
      ["issue-comment", "inline-comment", "reply"].includes(operation.command.action.kind)
    )
      this.refreshContent(operation.command.scope.url);
    this.db
      .prepare("UPDATE scopes SET revision=revision+1 WHERE scope=?")
      .run(operation.command.scope.url);
  }
  async close(): Promise<void> {
    const lost = this.compromised;
    this.lost = true;
    this.db.close();
    // A fenced former owner must not unlink a successor's owner-lock directory.
    if (!lost) await this.release();
  }
}

/** JSON object member order is not part of admission identity; array order is. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
