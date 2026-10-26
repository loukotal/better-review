import {
  resolveManualSource,
  type ManualSourceDependencies,
  type ManualSourceInput,
} from "./manual-source-resolution";
import { getErrorMessage } from "./response";

interface ManualSourceRouteDependencies extends ManualSourceDependencies {
  session(id: string): Promise<ManualSourceInput["session"] | null>;
  prUrl(id: string): Promise<string | null>;
  sessionScope(id: string): Promise<ManualSourceInput["sessionScope"]>;
}

/** The production route uses this seam; tests need neither server startup nor Effect runtime. */
export async function manualSourceResponse(
  params: URLSearchParams,
  sessionId: string,
  deps: ManualSourceRouteDependencies,
): Promise<Response> {
  const filePath = params.get("path");
  const prevPath = params.get("prevPath") ?? undefined;
  const variantId = params.get("variantId") ?? undefined;
  if (!filePath) return Response.json({ error: "Missing path" }, { status: 400 });
  try {
    const session = await deps.session(sessionId);
    if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
    const prUrl = await deps.prUrl(sessionId);
    const sessionScope = await deps.sessionScope(sessionId);
    const result = await resolveManualSource(
      { session, prUrl, sessionScope, filePath, prevPath, variantId },
      deps,
    );
    return result
      ? Response.json(result)
      : Response.json(
          { error: "Unable to resolve file contents for this session" },
          { status: 404 },
        );
  } catch (error) {
    return Response.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
