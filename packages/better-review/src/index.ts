import { runtime } from "./runtime";
import { GhService, type AddCommentParams, type AddReplyParams } from "./gh/gh";
import { Effect } from "effect";

const server = Bun.serve({
  port: 3001,
  routes: {
    "/api/pr/diff": {
      GET: async (req) => {
        const url = new URL(req.url);
        const prUrl = url.searchParams.get("url");

        if (!prUrl) {
          return Response.json(
            { error: "Missing url parameter" },
            { status: 400 },
          );
        }

        const result = await runtime
          .runPromise(
            Effect.gen(function* () {
              const gh = yield* GhService;
              const diff = yield* gh.getDiff(prUrl);
              return { diff };
            }),
          )
          .catch((e) => ({ error: String(e) }));

        return Response.json(result);
      },
    },
    "/api/pr/comments": {
      GET: async (req) => {
        const url = new URL(req.url);
        const prUrl = url.searchParams.get("url");

        if (!prUrl) {
          return Response.json(
            { error: "Missing url parameter" },
            { status: 400 },
          );
        }

        const result = await runtime
          .runPromise(
            Effect.gen(function* () {
              const gh = yield* GhService;
              const comments = yield* gh.listComments(prUrl);
              return { comments };
            }),
          )
          .catch((e) => ({ error: String(e) }));

        return Response.json(result);
      },
    },
    "/api/pr/comment": {
      POST: async (req) => {
        const body = (await req.json()) as AddCommentParams;

        if (!body.prUrl || !body.filePath || !body.line || !body.body) {
          return Response.json(
            { error: "Missing required fields: prUrl, filePath, line, body" },
            { status: 400 },
          );
        }

        const result = await runtime
          .runPromise(
            Effect.gen(function* () {
              const gh = yield* GhService;
              const comment = yield* gh.addComment(body);
              return { comment };
            }),
          )
          .catch((e) => ({ error: String(e) }));

        return Response.json(result);
      },
    },
    "/api/pr/comment/reply": {
      POST: async (req) => {
        const body = (await req.json()) as AddReplyParams;

        if (!body.prUrl || !body.commentId || !body.body) {
          return Response.json(
            { error: "Missing required fields: prUrl, commentId, body" },
            { status: 400 },
          );
        }

        const result = await runtime
          .runPromise(
            Effect.gen(function* () {
              const gh = yield* GhService;
              const comment = yield* gh.replyToComment(body);
              return { comment };
            }),
          )
          .catch((e) => ({ error: String(e) }));

        return Response.json(result);
      },
    },
  },
});

console.log(`API server running at http://localhost:${server.port}`);
