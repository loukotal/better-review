import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import lockfile from "proper-lockfile";

import type { GithubOutboxOperation } from "@better-review/shared";

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
      if (version > 3) throw new Error("Unsupported future GitHub outbox schema");
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
      const owner = randomUUID();
      db.prepare(
        "INSERT INTO owner(singleton,token) VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET token=excluded.token",
      ).run(owner);
      store = new OutboxDatabase(db, release, owner);
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
    const row = this.db.prepare("SELECT data FROM operations WHERE id=?").get(id) as
      | { data: string }
      | undefined;
    return row ? this.decode(row.data) : undefined;
  }
  private decode(data: string): GithubOutboxOperation {
    const operation: GithubOutboxOperation = JSON.parse(data);
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
      .prepare("UPDATE operations SET data=? WHERE id=?")
      .run(JSON.stringify(operation), operation.command.operationId);
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
