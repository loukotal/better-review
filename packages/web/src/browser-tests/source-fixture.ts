import superjson from "superjson";

import type { createAssertions } from "./assertions";

export interface SourceFixtureRequest {
  sessionId: string;
  path: string;
  ref?: string;
  side?: "LEFT" | "RIGHT";
  line?: number;
  range: { startLine: number; endLine: number };
}

export function sourceRequest(input: RequestInfo | URL): SourceFixtureRequest {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  const value = superjson.deserialize<SourceFixtureRequest>(
    JSON.parse(url.searchParams.get("input")!),
  );
  assertSourceRange(value.range);
  return value;
}

function assertSourceRange(range: SourceFixtureRequest["range"]) {
  if (
    !range ||
    !Number.isSafeInteger(range.startLine) ||
    !Number.isSafeInteger(range.endLine) ||
    range.startLine < 1 ||
    range.endLine < range.startLine ||
    range.endLine - range.startLine >= 200
  )
    throw new Error(
      `Browser source fixture requires a bounded 200-line request: ${JSON.stringify(range)}`,
    );
}

/** Mirrors the ranged RPC's clamped absolute coordinates, never a full-response compatibility mock. */
export function sourceWindow(content: string, range: SourceFixtureRequest["range"]) {
  assertSourceRange(range);
  const totalLines = Math.max(1, content.split(/\r?\n/).length - (content.endsWith("\n") ? 1 : 0));
  const contentStartLine = Math.min(range.startLine, totalLines);
  const contentEndLine = Math.min(range.endLine, totalLines);
  return {
    content:
      content
        .split("\n")
        .slice(contentStartLine - 1, contentEndLine)
        .join("\n") + (contentEndLine < totalLines || content.endsWith("\n") ? "\n" : ""),
    totalLines,
    contentStartLine,
    contentEndLine,
  };
}

export const sourceJson = (value: unknown) => Response.json({ result: { data: { json: value } } });

export async function askSourceRows(
  assertions: Pick<ReturnType<typeof createAssertions>, "wait">,
  host: HTMLElement,
  first: number,
  last = first,
) {
  const startCode = host.querySelector(`[data-source-line="${first}"] code`)!;
  const endCode = host.querySelector(`[data-source-line="${last}"] code`)!;
  const start = startCode.firstChild ?? startCode;
  const end = endCode.firstChild ?? endCode;
  (start.parentElement as HTMLElement).scrollIntoView({ block: "center" });
  await new Promise(requestAnimationFrame);
  const range = document.createRange();
  range.setStart(start, 0);
  range.setEnd(end, end.textContent!.length);
  getSelection()!.removeAllRanges();
  getSelection()!.addRange(range);
  host.querySelector("section")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  await assertions.wait(
    () => !!document.querySelector('[aria-label="Selection actions"] button'),
    "Source selection bubble did not open",
  );
  document.querySelector<HTMLButtonElement>('[aria-label="Selection actions"] button')!.click();
}
