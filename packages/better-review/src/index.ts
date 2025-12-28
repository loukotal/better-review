import { runtime } from "./runtime";
import { GhService } from "./gh/gh";
import { Effect } from "effect";

const server = Bun.serve({
  port: 3001,
  routes: {
    "/api/pr": {
      GET: async (req) => {
        const url = new URL(req.url);
        const prUrl = url.searchParams.get("url");

        if (!prUrl) {
          return Response.json({ error: "Missing url parameter" }, { status: 400 });
        }

        const result = await runtime.runPromise(
          Effect.gen(function* () {
            const gh = yield* GhService;
            const diff = yield* gh.getDiff(prUrl);
            return { diff };
          })
        ).catch((e) => ({ error: String(e) }));

        return Response.json(result);
      },
    },
  },
});

console.log(`API server running at http://localhost:${server.port}`);
