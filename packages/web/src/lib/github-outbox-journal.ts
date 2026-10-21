import { openDB, type DBSchema, type IDBPDatabase } from "idb";

import {
  DEFAULT_GITHUB_QUEUE_TIMEOUT_MS,
  isGithubPrScope,
  isGithubOutboxCommand,
  type GithubOutboxCommand,
  type GithubOutboxBatchControl,
  type GithubOutboxControl,
  type GithubOutboxJournal,
  type GithubOutboxOperation,
  type GithubPrScope,
} from "@better-review/shared";

export interface GithubAdmission {
  command: GithubOutboxCommand;
  localOrder: number;
  /** True only after an accepted/duplicate durable backend receipt. */
  backendOwned: boolean;
  operation?: GithubOutboxOperation;
  draftKey?: string;
  admissionError?: string;
  /** Earliest retry time. Cooldowns remain manual unless admissionRetryable is true. */
  admissionRetryAt?: string;
  /** Admission-only identity initialization can recover without another user decision. */
  admissionRetryable?: boolean;
  admittedAt?: string;
  admissionDeadlineAt?: string;
  admissionTimedOut?: boolean;
  admissionRetryRequestId?: string;
  admissionRetryTimeoutMs?: number;
}

/** Older clients persisted this exact server-owned startup diagnostic as permanent.
 * Replay admission only, with its original UUID/account. Never infer retry safety
 * from arbitrary messages, cooldown deadlines, or a backend operation's error.
 */
export function isGithubAdmissionRetryable(
  entry: Pick<GithubAdmission, "admissionRetryable" | "admissionError">,
) {
  return (
    entry.admissionRetryable === true ||
    (entry.admissionRetryable === undefined &&
      entry.admissionError === "A known GitHub identity is required before admission.")
  );
}

export interface GithubDraft {
  key: string;
  scope: GithubPrScope;
  body: string;
  /** Submitted drafts remain linked, never restored as a second unsent editor. */
  submittedOperationId?: string;
  editorSlot?: string;
  initialized?: boolean;
  context?: Record<string, string>;
}

export interface GithubEditorJournal {
  openEditor(
    slot: string,
    scope: GithubPrScope,
    initial?: { body: string; context?: Record<string, string> },
  ): Promise<GithubDraft>;
  saveEditor(draftKey: string, body: string): Promise<void>;
  editorDrafts(scope: GithubPrScope): Promise<GithubDraft[]>;
}

/** Kept separately from expiring query caches. No automatic record eviction. */
export interface BrowserGithubJournal extends GithubOutboxJournal {
  admit(command: GithubOutboxCommand, draftKey?: string): Promise<void>;
  entries(scope: GithubPrScope): Promise<GithubAdmission[]>;
  acknowledge(operation: GithubOutboxOperation, submittedOperationId?: string): Promise<void>;
  admissionFailed(
    operationId: string,
    message: string,
    retryAt?: string,
    retryable?: boolean,
    timedOut?: boolean,
  ): Promise<void>;
  restartAdmissionCycle?(
    operationId: string,
    deadlineAt: string,
    requestId: string,
    timeoutMs: number,
  ): Promise<void>;
  putBatch?(control: GithubOutboxBatchControl): Promise<void>;
  batches?(): Promise<GithubOutboxBatchControl[]>;
  removeBatch?(requestId: string): Promise<void>;
  /** Atomic cross-tab snapshot, serialized with putBatch/acknowledge. The
   * callback is synchronous: return a holder, not an awaited network promise. */
  guardAdmission?<T>(
    scope: GithubPrScope,
    start: (entries: GithubAdmission[], batches: GithubOutboxBatchControl[]) => T,
  ): Promise<T>;
  saveDraft(draft: GithubDraft): Promise<void>;
  draft(key: string): Promise<GithubDraft | undefined>;
  /** Local-only discovery of unsubmitted editor scopes; never admits their text. */
  draftScopes?(): Promise<GithubPrScope[]>;
  putControl(control: GithubOutboxControl, scope: GithubPrScope): Promise<void>;
  controls(scope: GithubPrScope): Promise<GithubOutboxControl[]>;
  removeControl(requestId: string): Promise<void>;
}

export function githubScopeKey(scope: GithubPrScope): string {
  return normalizeGithubPrScope(scope).url;
}

function admissionMetadata(entry: GithubAdmission): GithubAdmission {
  return {
    ...entry,
    admissionDeadlineAt:
      entry.admissionDeadlineAt ??
      entry.command.queueDeadlineAt ??
      new Date(
        entry.admittedAt && Number.isFinite(Date.parse(entry.admittedAt))
          ? Date.parse(entry.admittedAt) +
              (entry.command.queueTimeoutMs ?? DEFAULT_GITHUB_QUEUE_TIMEOUT_MS)
          : 0,
      ).toISOString(),
  };
}

/** Normalize before command creation; never change an already journaled command. */
export function normalizeGithubPrScope(scope: GithubPrScope): GithubPrScope {
  if (scope.url !== `https://github.com/${scope.owner}/${scope.repo}/pull/${scope.number}`) {
    throw new Error("GitHub pull request URL does not match its scope");
  }
  const normalized = { ...scope, owner: scope.owner.toLowerCase(), repo: scope.repo.toLowerCase() };
  normalized.url = `https://github.com/${normalized.owner}/${normalized.repo}/pull/${normalized.number}`;
  if (!isGithubPrScope(normalized)) throw new Error("Invalid GitHub pull request scope");
  return normalized;
}

/** JSON key ordering must not turn an identical admission into a conflict. */
export function githubCommandFingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}

interface JournalSchema extends DBSchema {
  batches: { key: string; value: GithubOutboxBatchControl };
  editors: { key: string; value: { slot: string; draftKey: string; scope: string } };
  admissions: { key: string; value: GithubAdmission; indexes: { scope: string } };
  drafts: { key: string; value: GithubDraft };
  controls: {
    key: string;
    value: { control: GithubOutboxControl; scope: string };
    indexes: { scope: string };
  };
}

export function createIndexedDbGithubJournal(
  name = "better-review-github-outbox-v1",
): BrowserGithubJournal & GithubEditorJournal {
  let database: Promise<IDBPDatabase<JournalSchema>> | undefined;
  const db = () =>
    (database ??= openDB<JournalSchema>(name, 3, {
      upgrade(database, oldVersion) {
        if (oldVersion < 3) database.createObjectStore("batches", { keyPath: "requestId" });
        if (oldVersion < 2) database.createObjectStore("editors", { keyPath: "slot" });
        if (oldVersion >= 1) return;
        // Index nested scope.url directly: no denormalized command field on the wire.
        database
          .createObjectStore("admissions", { keyPath: "command.operationId" })
          .createIndex("scope", "command.scope.url");
        database.createObjectStore("drafts", { keyPath: "key" });
        database
          .createObjectStore("controls", { keyPath: "control.requestId" })
          .createIndex("scope", "scope");
      },
    }));

  async function admit(command: GithubOutboxCommand, draftKey?: string) {
    command = structuredClone(command);
    if (!isGithubOutboxCommand(command)) throw new Error("Invalid GitHub outbox command");
    if (
      githubCommandFingerprint(normalizeGithubPrScope(command.scope)) !==
      githubCommandFingerprint(command.scope)
    ) {
      throw new Error("Normalize GitHub scope before constructing a command");
    }
    const database = await db();
    const tx = database.transaction(["admissions", "drafts", "editors"], "readwrite");
    const store = tx.objectStore("admissions");
    const existing = await store.get(command.operationId);
    if (
      existing &&
      (githubCommandFingerprint(existing.command) !== githubCommandFingerprint(command) ||
        (draftKey !== undefined &&
          existing.draftKey !== undefined &&
          existing.draftKey !== draftKey))
    ) {
      tx.abort();
      await tx.done.catch(() => {});
      throw new Error("Operation ID already belongs to another command");
    }
    let draft: GithubDraft | undefined;
    if (draftKey !== undefined) {
      draft = await tx.objectStore("drafts").get(draftKey);
      if (
        draft &&
        (draft.scope.url !== command.scope.url ||
          (draft.submittedOperationId && draft.submittedOperationId !== command.operationId))
      ) {
        tx.abort();
        await tx.done.catch(() => {});
        throw new Error("Draft already submitted or belongs to another pull request");
      }
    }
    if (!existing) {
      const all = await store.getAll();
      const localOrder = all.reduce((max, entry) => Math.max(max, entry.localOrder), 0) + 1;
      await store.put({
        command,
        localOrder,
        backendOwned: false,
        draftKey,
        admittedAt: new Date().toISOString(),
        admissionDeadlineAt:
          command.queueDeadlineAt ??
          new Date(
            Date.now() + (command.queueTimeoutMs ?? DEFAULT_GITHUB_QUEUE_TIMEOUT_MS),
          ).toISOString(),
      });
    } else if (draftKey !== undefined && existing.draftKey === undefined) {
      await store.put({ ...existing, draftKey });
    }
    if (draftKey !== undefined) {
      await tx.objectStore("drafts").put({
        ...draft,
        key: draftKey,
        scope: command.scope,
        body: draft?.body ?? ("body" in command.action ? command.action.body : ""),
        submittedOperationId: command.operationId,
      });
      if (draft?.editorSlot) {
        const pointer = await tx.objectStore("editors").get(draft.editorSlot);
        if (pointer?.draftKey === draftKey) {
          const nextKey = `intent:${crypto.randomUUID()}`;
          await tx.objectStore("drafts").put({
            key: nextKey,
            scope: command.scope,
            editorSlot: draft.editorSlot,
            body: "",
            initialized: false,
          });
          await tx.objectStore("editors").put({ ...pointer, draftKey: nextKey });
        }
      }
    }
    await tx.done;
  }

  return {
    async openEditor(slot, scope, initial) {
      scope = normalizeGithubPrScope(scope);
      const tx = (await db()).transaction(["drafts", "editors"], "readwrite");
      const pointer = await tx.objectStore("editors").get(slot);
      if (pointer && pointer.scope !== scope.url) {
        tx.abort();
        await tx.done.catch(() => {});
        throw new Error("Editor belongs to another PR");
      }
      let draft = pointer ? await tx.objectStore("drafts").get(pointer.draftKey) : undefined;
      if (!draft || draft.submittedOperationId) {
        draft = {
          key: `intent:${crypto.randomUUID()}`,
          scope,
          editorSlot: slot,
          body: "",
          initialized: false,
        };
      }
      if (initial && !draft.initialized)
        draft = { ...draft, body: initial.body, context: initial.context, initialized: true };
      await tx.objectStore("drafts").put(draft);
      await tx.objectStore("editors").put({ slot, draftKey: draft.key, scope: scope.url });
      await tx.done;
      return structuredClone(draft);
    },
    async saveEditor(draftKey, body) {
      const tx = (await db()).transaction("drafts", "readwrite");
      const draft = await tx.store.get(draftKey);
      if (!draft || draft.submittedOperationId) {
        tx.abort();
        await tx.done.catch(() => {});
        throw new Error("Editor intent already submitted or unavailable");
      }
      await tx.store.put({ ...draft, body, initialized: true });
      await tx.done;
    },
    async editorDrafts(scope) {
      return (await (await db()).getAll("drafts")).filter(
        (draft) =>
          draft.scope.url === normalizeGithubPrScope(scope).url &&
          !!draft.editorSlot &&
          !!draft.body &&
          !draft.submittedOperationId,
      );
    },
    async draftScopes() {
      const scopes = new Map<string, GithubPrScope>();
      const tx = (await db()).transaction("drafts", "readonly");
      let cursor = await tx.store.openCursor();
      while (cursor) {
        const draft = cursor.value;
        if (
          draft.editorSlot &&
          draft.body.trim() &&
          !draft.submittedOperationId &&
          isGithubPrScope(draft.scope)
        )
          scopes.set(draft.scope.url, structuredClone(draft.scope));
        cursor = await cursor.continue();
      }
      await tx.done;
      return [...scopes.values()];
    },
    admit,
    put: (command) => admit(command),
    async list(scope) {
      const database = await db();
      const entries = scope
        ? await database.getAllFromIndex("admissions", "scope", githubScopeKey(scope))
        : await database.getAll("admissions");
      return entries.map((entry) => entry.command);
    },
    async entries(scope) {
      return (await (await db()).getAllFromIndex("admissions", "scope", githubScopeKey(scope)))
        .map(admissionMetadata)
        .sort((a, b) => a.localOrder - b.localOrder);
    },
    async guardAdmission(scope, start) {
      // A readwrite transaction is the cross-connection/tab fence, not an HTTP
      // lock. Clear persistence and ownership acknowledgement cannot interleave
      // between this snapshot and the synchronous transport kickoff.
      const tx = (await db()).transaction(["admissions", "batches"], "readwrite");
      try {
        const [entries, batches] = await Promise.all([
          tx.objectStore("admissions").index("scope").getAll(githubScopeKey(scope)),
          tx.objectStore("batches").getAll(),
        ]);
        const result = start(
          entries.map(admissionMetadata).sort((a, b) => a.localOrder - b.localOrder),
          batches,
        );
        await tx.done;
        return result;
      } catch (error) {
        try {
          tx.abort();
        } catch {
          /* Transaction may already have completed. */
        }
        await tx.done.catch(() => {});
        throw error;
      }
    },
    async acknowledge(operation, submittedOperationId = operation.command.operationId) {
      const tx = (await db()).transaction(["admissions", "drafts", "controls"], "readwrite");
      const store = tx.objectStore("admissions");
      const entry = await store.get(submittedOperationId);
      if (entry && (!entry.operation || entry.operation.revision <= operation.revision)) {
        // Backend may have revised the command. Preserve original admission fingerprint.
        await store.put({
          ...entry,
          backendOwned: true,
          operation,
          admissionError: undefined,
          admissionRetryAt: undefined,
          admissionRetryable: undefined,
          admissionTimedOut: undefined,
          admissionRetryRequestId: undefined,
          admissionRetryTimeoutMs: undefined,
        });
        if (entry.draftKey) {
          const draft = await tx.objectStore("drafts").get(entry.draftKey);
          if (draft)
            await tx
              .objectStore("drafts")
              .put({ ...draft, submittedOperationId: operation.command.operationId });
        }
      }
      // Refresh every receipt alias too, so reload cannot resurrect stale state.
      for (const alias of await store.getAll()) {
        if (
          alias.operation?.command.operationId === operation.command.operationId &&
          alias.operation.revision <= operation.revision
        )
          await store.put({ ...alias, operation });
      }
      await tx.done;
    },
    async admissionFailed(operationId, message, retryAt, retryable, timedOut) {
      const tx = (await db()).transaction("admissions", "readwrite");
      const entry = await tx.store.get(operationId);
      if (entry && !entry.backendOwned)
        await tx.store.put({
          ...entry,
          admissionError: message,
          admissionRetryAt: retryAt,
          admissionRetryable: retryable,
          admissionTimedOut: timedOut,
        });
      await tx.done;
    },
    async restartAdmissionCycle(operationId, deadlineAt, requestId, timeoutMs) {
      const tx = (await db()).transaction("admissions", "readwrite");
      const entry = await tx.store.get(operationId);
      if (!entry || entry.backendOwned) {
        tx.abort();
        await tx.done.catch(() => {});
        throw new Error("Admission no longer belongs to the local queue");
      }
      await tx.store.put({
        ...entry,
        admissionError: undefined,
        admissionRetryAt: undefined,
        admissionRetryable: undefined,
        admissionTimedOut: undefined,
        admissionDeadlineAt: deadlineAt,
        admissionRetryRequestId: requestId,
        admissionRetryTimeoutMs: timeoutMs,
      });
      await tx.done;
    },
    async putBatch(control) {
      const tx = (await db()).transaction("batches", "readwrite");
      const prior = await tx.store.get(control.requestId);
      if (prior && githubCommandFingerprint(prior) !== githubCommandFingerprint(control)) {
        tx.abort();
        await tx.done.catch(() => {});
        throw new Error("Batch request ID already used");
      }
      await tx.store.put(structuredClone(control));
      await tx.done;
    },
    async batches() {
      return (await db()).getAll("batches");
    },
    async removeBatch(requestId) {
      await (await db()).delete("batches", requestId);
    },
    async remove(operationId) {
      const tx = (await db()).transaction("admissions", "readwrite");
      const entry = await tx.store.get(operationId);
      if (entry && !entry.backendOwned) {
        tx.abort();
        await tx.done.catch(() => {});
        throw new Error("Cannot discard an unacknowledged GitHub command");
      }
      await tx.store.delete(operationId);
      await tx.done;
    },
    async saveDraft(draft) {
      draft = { ...draft, scope: normalizeGithubPrScope(draft.scope) };
      const tx = (await db()).transaction("drafts", "readwrite");
      const existing = await tx.store.get(draft.key);
      if (existing?.submittedOperationId) {
        tx.abort();
        await tx.done.catch(() => {});
        throw new Error("Use a new draft key after submission");
      }
      await tx.store.put(draft);
      await tx.done;
    },
    async draft(key) {
      return (await db()).get("drafts", key);
    },
    async putControl(control, scope) {
      control = structuredClone(control);
      scope = normalizeGithubPrScope(scope);
      const tx = (await db()).transaction("controls", "readwrite");
      const old = await tx.store.get(control.requestId);
      if (
        old &&
        githubCommandFingerprint(old) !==
          githubCommandFingerprint({ control, scope: githubScopeKey(scope) })
      ) {
        tx.abort();
        await tx.done.catch(() => {});
        throw new Error("Control request ID conflict");
      }
      await tx.store.put({ control, scope: githubScopeKey(scope) });
      await tx.done;
    },
    async controls(scope) {
      return (await (await db()).getAllFromIndex("controls", "scope", githubScopeKey(scope))).map(
        (entry) => entry.control,
      );
    },
    async removeControl(requestId) {
      await (await db()).delete("controls", requestId);
    },
    async close() {
      if (database) (await database).close();
      database = undefined;
    },
  };
}
