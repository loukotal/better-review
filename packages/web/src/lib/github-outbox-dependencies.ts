import type { GithubOutboxCommand, GithubOutboxOperation } from "@better-review/shared";

import { isGithubAdmissionRetryable } from "./github-outbox-journal";

interface DependencyEntry {
  command: GithubOutboxCommand;
  backendOwned: boolean;
  operation?: GithubOutboxOperation;
  admissionError?: string;
  admissionRetryable?: boolean;
  admissionRetryAt?: string;
  /** Projected backend FIFO blockers act like prerequisite edges too. */
  blockedByOperationId?: string;
}

interface DependencyBlocker {
  operationId: string;
  kind: "attention" | "waiting" | "cycle";
}

/** One graph for admission scheduling and UI projection. IDs always name the
 * canonical root, not whichever intermediate child happened to be visited first.
 * Missing local nodes may already belong to the server; admission validates them.
 */
export function createGithubDependencyGraph<T extends DependencyEntry>(
  entries: readonly T[],
  now: number,
  extraAliases: ReadonlyMap<string, string> = new Map(),
) {
  const aliases = new Map(extraAliases);
  for (const entry of entries)
    if (entry.operation)
      aliases.set(entry.command.operationId, entry.operation.command.operationId);
  const canonicalIds = new Map<string, string>();
  function canonicalId(id: string): string {
    const path: string[] = [];
    const positions = new Map<string, number>();
    while (aliases.has(id) && aliases.get(id) !== id) {
      const known = canonicalIds.get(id);
      if (known) {
        id = known;
        break;
      }
      const cycle = positions.get(id);
      if (cycle !== undefined) {
        id = path.slice(cycle).sort()[0]!;
        break;
      }
      positions.set(id, path.length);
      path.push(id);
      id = aliases.get(id)!;
    }
    for (const alias of path) canonicalIds.set(alias, id);
    return id;
  }
  const nodes = new Map<string, T>();
  for (const entry of entries) {
    const id = canonicalId(entry.command.operationId);
    const prior = nodes.get(id);
    if (!prior || (entry.operation?.revision ?? -1) >= (prior.operation?.revision ?? -1))
      nodes.set(id, entry);
  }
  const snapshot = new Map<string, DependencyEntry>(
    [...nodes].map(([id, entry]) => [
      id,
      {
        ...entry,
        command: { ...entry.command, dependencies: [...entry.command.dependencies] },
        operation: entry.operation ? structuredClone(entry.operation) : undefined,
      },
    ]),
  );
  const completed = new Map<string, DependencyBlocker | undefined>();
  const explicitCompleted = new Map<string, DependencyBlocker | undefined>();
  const visiting = new Map<string, number>();
  const path: string[] = [];
  let evaluatedNodes = 0;
  let traversedEdges = 0;
  function visit(id: string, ignoreOwn = false): DependencyBlocker | undefined {
    id = canonicalId(id);
    const cycle = visiting.get(id);
    if (cycle !== undefined) return { operationId: path.slice(cycle).sort()[0]!, kind: "cycle" };
    // Overrides apply only to this root. Its ancestors still use normal cached
    // decisions; never reuse or overwrite the root's normal manual-block result.
    const memo = ignoreOwn ? explicitCompleted : completed;
    if (memo.has(id)) return memo.get(id);
    visiting.set(id, path.length);
    path.push(id);
    try {
      const result = evaluate(id, ignoreOwn);
      memo.set(id, result);
      return result;
    } finally {
      path.pop();
      visiting.delete(id);
    }
  }
  function evaluate(id: string, ignoreOwn: boolean): DependencyBlocker | undefined {
    evaluatedNodes++;
    const entry = snapshot.get(id);
    if (!entry) return;
    const op = entry.operation;
    if (entry.backendOwned && op?.status === "synced") return;
    let own: DependencyBlocker | undefined;
    if (!ignoreOwn) {
      if (!entry.backendOwned && entry.admissionError && !isGithubAdmissionRetryable(entry))
        own = { operationId: id, kind: "attention" };
      if (
        entry.backendOwned &&
        (op?.status === "uncertain" ||
          op?.status === "cancelled" ||
          (op?.status === "retry-failed" &&
            !(op.retryMode === "automatic" && op.error?.retryable && op.nextAttemptAt)))
      )
        own = { operationId: id, kind: "attention" };
    }
    let waiting: DependencyBlocker | undefined;
    const dependencies = (op?.command ?? entry.command).dependencies;
    for (const dependency of entry.blockedByOperationId
      ? [...dependencies, entry.blockedByOperationId]
      : dependencies) {
      traversedEdges++;
      const blocker = visit(dependency);
      if (blocker && blocker.kind !== "waiting") return blocker;
      waiting ??= blocker;
    }
    // Secondary errors on children must not hide the original root requiring
    // attention. An own permanent error does outrank a merely waiting ancestor.
    if (own) return own;
    if (waiting) return waiting;
    if (
      !ignoreOwn &&
      ((!entry.backendOwned &&
        entry.admissionRetryAt &&
        Date.parse(entry.admissionRetryAt) > now) ||
        (entry.backendOwned && op?.status === "retry-failed"))
    )
      return { operationId: id, kind: "waiting" };
  }
  return {
    canonicalId,
    entry: (id: string) => nodes.get(canonicalId(id)),
    blocker: (id: string, ignoreOwn = false) => visit(id, ignoreOwn),
    /** Local diagnostics for deterministic complexity regression tests. */
    get stats() {
      return { evaluatedNodes, traversedEdges };
    },
  };
}
