import type { MiddlewareHandler } from "hono";

const webPort = process.env.WEB_PORT ?? "3000";
const allowedDevOrigins = new Set([`http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`]);

export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin || !allowedDevOrigins.has(origin)) return {};

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, trpc-accept, x-trpc-source",
    "Access-Control-Expose-Headers":
      "Stream-Next-Offset, Stream-Up-To-Date, Stream-Closed, Stream-Cursor, Stream-SSE-Data-Encoding",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

export function withCors(req: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(getCorsHeaders(req))) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export const corsMiddleware: MiddlewareHandler = async (context, next) => {
  const corsHeaders = getCorsHeaders(context.req.raw);

  if (context.req.method === "OPTIONS" && Object.keys(corsHeaders).length > 0) {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  await next();
  context.res = withCors(context.req.raw, context.res);
};
