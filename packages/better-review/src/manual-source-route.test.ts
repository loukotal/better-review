import assert from "node:assert/strict";
import test from "node:test";

import type { ManualSourceInput } from "./manual-source-resolution";
import { manualSourceResponse } from "./manual-source-route";
import { getErrorMessage } from "./response";

function fixture() {
  const calls: unknown[][] = [];
  let session: ManualSourceInput["session"] | null = { payload: { kind: "message", content: "" } };
  const deps = {
    session: async (id: string) => {
      calls.push(["session", id]);
      return session;
    },
    prUrl: async (id: string) => {
      calls.push(["prUrl", id]);
      return "https://github.com/owner/repo/pull/1";
    },
    sessionScope: async (id: string) => {
      calls.push(["scope", id]);
      return { mode: "full", commitSha: null };
    },
    git: async (args: string[]) => {
      calls.push(["git", ...args]);
      return { stdout: "", exitCode: 1 };
    },
    readFile: async (absolute: string) => {
      calls.push(["file", absolute]);
      return "";
    },
    prRefs: async (url: string): Promise<readonly [string, string]> => {
      calls.push(["refs", url]);
      return ["base", "head"];
    },
    prInfo: async (url: string) => {
      calls.push(["info", url]);
      return { owner: "owner", repo: "repo" };
    },
    remoteContent: async (input: { owner: string; repo: string; path: string; ref: string }) => {
      calls.push(["content", input]);
      return input.path;
    },
  };
  return {
    deps,
    calls,
    setSession(value: typeof session) {
      session = value;
    },
    request(query: string) {
      const request = new Request(`http://offline/api/sessions/manual/file-content${query}`);
      return manualSourceResponse(new URL(request.url).searchParams, "manual", deps);
    },
  };
}

for (const query of ["", "?path=", "?path=&path=valid.ts"]) {
  test(`actual URLSearchParams missing/empty first path returns existing 400: ${query}`, async () => {
    const f = fixture(),
      response = await f.request(query);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Missing path" });
    assert.deepEqual(f.calls, []);
  });
}

test("missing session returns existing 404 before context or readers", async () => {
  const f = fixture();
  f.setSession(null);
  const response = await f.request("?path=file.ts");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Session not found" });
  assert.deepEqual(f.calls, [["session", "manual"]]);
});

test("unresolved context returns existing 404 text after session, PR and scope lookup in order", async () => {
  const f = fixture();
  f.deps.prRefs = async () => ["", ""];
  const response = await f.request("?path=file.ts");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: "Unable to resolve file contents for this session",
  });
  assert.deepEqual(f.calls, [
    ["session", "manual"],
    ["prUrl", "manual"],
    ["scope", "manual"],
  ]);
});

test("request decoding preserves absent versus empty previous path and first-value URL decoding", async () => {
  for (const query of [
    "?path=new+file.ts",
    "?path=new+file.ts&prevPath=",
    "?path=new+file.ts&prevPath=old%2Fname.ts&prevPath=ignored",
  ]) {
    const f = fixture(),
      response = await f.request(query);
    assert.equal(response.status, 200);
    const oldPath = query.includes("prevPath=old")
      ? "old/name.ts"
      : query.includes("prevPath=")
        ? ""
        : "new file.ts";
    assert.deepEqual(await response.json(), {
      oldContent: oldPath,
      newContent: "new file.ts",
      source: "github",
    });
    assert.deepEqual(f.calls.slice(0, 3), [
      ["session", "manual"],
      ["prUrl", "manual"],
      ["scope", "manual"],
    ]);
    assert.deepEqual(
      f.calls.slice(-2).map((call) => call[1]),
      [
        { owner: "owner", repo: "repo", path: oldPath, ref: "base" },
        { owner: "owner", repo: "repo", path: "new file.ts", ref: "head" },
      ],
    );
  }
});

test("empty variantId selects an explicitly matching empty ID; absent variant does not", async () => {
  for (const query of ["?path=file.ts&variantId=", "?path=file.ts"]) {
    const f = fixture();
    f.setSession({
      repoRoot: "/repo",
      payload: {
        kind: "diff",
        rawPatch: "",
        variants: [
          {
            id: "",
            label: "empty ID",
            rawPatch: "",
            contentSource: { kind: "git-refs", baseSha: "explicit-base", headSha: "explicit-head" },
          },
        ],
      },
    });
    f.deps.git = async (args) => {
      f.calls.push(["git", ...args]);
      return { stdout: args.at(-1)!, exitCode: 0 };
    };
    const response = await f.request(query);
    assert.equal(response.status, 200);
    assert.deepEqual(
      await response.json(),
      query.includes("variantId=")
        ? {
            oldContent: "explicit-base:file.ts",
            newContent: "explicit-head:file.ts",
            source: "local-git",
          }
        : { oldContent: "base:file.ts", newContent: "head:file.ts", source: "local" },
    );
    assert.equal(
      f.calls.some((call) => call[0] === "refs"),
      !query.includes("variantId="),
    );
  }
});

test("transport preserves propagated failure messages/status while remote content failure remains a 200 null pair", async () => {
  for (const port of ["session", "prUrl", "sessionScope", "prRefs", "prInfo"] as const) {
    const f = fixture(),
      error = new Error("outer", { cause: new Error(`${port} unavailable`) });
    f.deps[port] = async () => {
      throw error;
    };
    const response = await f.request("?path=file.ts");
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: getErrorMessage(error) });
  }
  const f = fixture();
  f.deps.remoteContent = async (input) => {
    f.calls.push(["content", input]);
    throw new Error("content missing");
  };
  const response = await f.request("?path=file.ts");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { oldContent: null, newContent: null, source: "github" });
  assert.equal(f.calls.filter((call) => call[0] === "content").length, 2);
});

test("local read exceptions keep the route's 500 contract rather than falling through to GitHub", async () => {
  for (const port of ["git", "readFile"] as const) {
    const f = fixture();
    f.setSession({
      repoRoot: "/repo",
      payload: {
        kind: "diff",
        rawPatch: "",
        variants: [
          {
            id: "working",
            label: "working",
            rawPatch: "",
            contentSource: { kind: "working-tree", baseSha: "base" },
          },
        ],
      },
    });
    f.deps[port] = async () => {
      throw Object.assign(new Error(`${port} denied`), { code: "EACCES" });
    };
    const response = await f.request("?path=file.ts&variantId=working");
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: `${port} denied` });
    assert.equal(
      f.calls.some((call) => call[0] === "refs" || call[0] === "content"),
      false,
    );
  }
});
