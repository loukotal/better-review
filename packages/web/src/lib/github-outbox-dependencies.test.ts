import assert from "node:assert/strict";
import { test } from "node:test";

import type { GithubOutboxCommand } from "@better-review/shared";

import { createGithubDependencyGraph } from "./github-outbox-dependencies";

test("shared-ancestor DAG evaluation is linear per snapshot, with separate explicit-root overrides", () => {
  let reads = 0;
  const commands: GithubOutboxCommand[] = Array.from({ length: 30 }, (_, n) => ({
    operationId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    scope: {
      host: "github.com",
      owner: "o",
      repo: "r",
      number: 1,
      url: "https://github.com/o/r/pull/1",
    },
    expectedActor: { id: 1, login: "fixture" },
    action: { kind: "issue-comment", body: "fixture" },
    dependencies: [],
  }));
  for (let n = 0; n < commands.length; n++)
    commands[n]!.dependencies = commands.slice(Math.max(0, n - 2), n).map((cmd) => cmd.operationId);
  const entries = commands.map((command, n) => ({
    command,
    get backendOwned() {
      reads++;
      return false;
    },
    admissionError: n === 29 ? "Manual attention required" : undefined,
  }));
  const graph = createGithubDependencyGraph(entries, Date.now());
  assert.equal(graph.blocker(commands[29]!.operationId)?.operationId, commands[29]!.operationId);
  for (const command of commands) graph.blocker(command.operationId);
  assert.ok(reads < 500, `shared ancestors re-evaluated ${reads} times`);
  const edges = commands.reduce((count, command) => count + command.dependencies.length, 0);
  assert.ok(graph.stats.evaluatedNodes <= commands.length);
  assert.ok(graph.stats.traversedEdges <= edges);
  const completed = graph.stats;
  for (const command of commands) graph.blocker(command.operationId);
  assert.deepEqual(
    graph.stats,
    completed,
    "completed nodes must not be re-evaluated by later roots",
  );
  assert.equal(graph.blocker(commands[29]!.operationId, true), undefined);
  assert.ok(
    graph.stats.evaluatedNodes <= commands.length + 1,
    "override only re-evaluates its own root",
  );
  assert.equal(
    graph.blocker(commands[29]!.operationId)?.kind,
    "attention",
    "explicit override must not poison normal memo",
  );
  entries[29]!.admissionError = undefined;
  assert.equal(
    graph.blocker(commands[29]!.operationId)?.kind,
    "attention",
    "resolver is a snapshot",
  );
  assert.equal(
    createGithubDependencyGraph(entries, Date.now()).blocker(commands[29]!.operationId),
    undefined,
  );
  entries[29]!.admissionError = "Manual attention required";
  const explicitFirst = createGithubDependencyGraph(entries, Date.now());
  assert.equal(explicitFirst.blocker(commands[29]!.operationId, true), undefined);
  assert.equal(explicitFirst.blocker(commands[29]!.operationId)?.kind, "attention");
});
