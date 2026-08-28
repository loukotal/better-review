import assert from "node:assert/strict";
import test from "node:test";

import { buildCallstackTree } from "./ReadingDiffState";

test("buildCallstackTree renders sibling calls beneath their shared caller", () => {
  const roots = buildCallstackTree([
    {
      id: "entry",
      kind: "entry",
      label: "handleRequest()",
      inferred: false,
    },
    {
      id: "persist",
      parentId: "entry",
      kind: "persistence",
      label: "repository.save()",
      inferred: false,
    },
    {
      id: "notify",
      parentId: "entry",
      kind: "side_effect",
      label: "events.publish()",
      inferred: false,
    },
  ]);

  assert.equal(roots.length, 1);
  assert.equal(roots[0]?.node.id, "entry");
  assert.deepEqual(
    roots[0]?.children.map((child) => child.node.id),
    ["persist", "notify"],
  );
});
