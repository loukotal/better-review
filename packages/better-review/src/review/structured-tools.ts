import { createHash } from "node:crypto";

import { reviewBaseRef } from "../pr-checkout";
import type { PrReviewSession } from "../pr-review-sessions";
import type { SubmissionSandbox } from "./microsandbox";
import type { ToolObservation } from "./tool-observability";

const VERSION = 3;
const MAX_BYTES = 12000;
const MAX_RECORDS = 100;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Bash can edit submission-global Git config in scratch. Never let that mutable
// configuration (or replacement objects) affect a revision-keyed structured result.
const git =
  "GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1 GIT_ATTR_NOSYSTEM=1 git --no-pager --no-lazy-fetch -c safe.directory='*' -c core.quotePath=true -c core.attributesFile=/dev/null";
// Default (non-`glob`) Git pathspec wildcards match slashes too. Apply this
// exclusion even with no positive paths, and to directory-filtered searches:
// discovered filenames are not subject to repositoryPath's input validation.
// NUL is forbidden by Git itself; exclude every other ASCII control byte.
const supportedSearchPaths = quote(
  `:(exclude)*[${String.fromCharCode(1)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]*`,
);

export interface Cursor {
  row: number;
  byte: number;
  range?: number;
}
export interface Fragment {
  row: number;
  byte: number;
  totalBytes: number;
  text: string;
}
interface Page {
  records: Fragment[];
  next: Cursor | null;
  bytes: number;
  exitCode: number;
  error?: string;
}
export interface FileRange {
  path: string;
  start?: number;
  end?: number;
}
export interface SearchArgs {
  pattern: string;
  mode?: "literal" | "regex";
  paths?: string[];
  context?: number;
  continuation?: string;
}
export interface DiffArgs {
  paths?: string[];
  context?: number;
  continuation?: string;
}
export interface ReadArgs {
  ranges: FileRange[];
  continuation?: string;
}

/** Literal repository-relative paths only: no Git pathspec magic, scratch, or traversal. */
export function repositoryPath(value: string): string {
  if (
    !value ||
    value.length > 1024 ||
    value.startsWith("/") ||
    // Control-character paths cannot be represented by the line-oriented guest protocol.
    // oxlint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f]/.test(value) ||
    value.split("/").some((part) => part === ".." || part === ".git")
  )
    throw new Error(`Expected a repository-relative path: ${value.slice(0, 100)}`);
  const normalized = value
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
  if (!normalized) throw new Error("Expected a file or directory path");
  return normalized;
}

function paths(values: string[] = []): string[] {
  if (values.length > 32) throw new Error("At most 32 paths are allowed");
  return [...new Set(values.map(repositoryPath))].sort();
}
function pathArgs(values: string[]) {
  return values.map((value) => quote(`:(literal)${value}`)).join(" ");
}
function integer(value: number, min: number, max: number) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error("Invalid numeric limit");
  return value;
}
function contextLines(value = 2) {
  return integer(value, 0, 10);
}
function revision(value: string) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value))
    throw new Error("Review requires an immutable full commit SHA");
  return value;
}

function callSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
}

/** Validate the entire immutable blob bytewise before a line-oriented tool sees it.
 * od/awk retain only a small input block and UTF-8 state, never the blob itself.
 */
async function validateText(vm: SubmissionSandbox, command: string, signal: AbortSignal) {
  const result = await vm.execStructured(
    `d=$(mktemp -d) || exit 1
{ { ${command}; printf '%s' "$?" > "$d/git"; } | od -An -v -tu1; printf '%s' "$?" > "$d/od"; } | awk '
BEGIN { need=0; lo=128; hi=191 }
{ for(i=1;i<=NF;i++) {
  b=$i+0; if(b==0) binary=1;
  if(need) { if(b<lo || b>hi) invalid=1; need--; lo=128; hi=191 }
  else if(b<128) { }
  else if(b>=194 && b<=223) need=1;
  else if(b>=224 && b<=239) { need=2; if(b==224) lo=160; if(b==237) hi=159 }
  else if(b>=240 && b<=244) { need=3; if(b==240) lo=144; if(b==244) hi=143 }
  else invalid=1;
} }
END {
  if(binary) { print "Unsupported binary blob (NUL bytes)"; exit 2 }
  if(invalid || need) { print "Unsupported UTF-8 encoding"; exit 3 }
  print "OK"
}'
validation=$?
g=$(cat "$d/git") || g=125; o=$(cat "$d/od") || o=125
rm -f "$d/git" "$d/od"; rmdir "$d"
if [ "$g" -ne 0 ]; then exit "$g"; fi
if [ "$o" -ne 0 ]; then exit "$o"; fi
exit "$validation"`,
    { signal },
  );
  signal.throwIfAborted();
  if (result.exitCode !== 0)
    return (result.stderr || result.stdout || "Blob validation failed").slice(0, 500).trim();
  if (result.stdout.trim() !== "OK") throw new Error("Incomplete blob validation response");
  return undefined;
}

/** A byte- and entry-bounded process-local LRU. Serialized values cannot be mutated by callers. */
export class ReviewToolCache {
  private entries = new Map<string, string>();
  private bytes = 0;
  constructor(
    private maxBytes = 2 * 1024 * 1024,
    private maxEntries = 128,
  ) {}
  get<T>(key: string): T | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return JSON.parse(value) as T;
  }
  set(key: string, result: unknown) {
    const value = JSON.stringify(result);
    const size = Buffer.byteLength(value);
    if (size > this.maxBytes) return;
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.bytes -= Buffer.byteLength(previous);
      this.entries.delete(key);
    }
    this.entries.set(key, value);
    this.bytes += size;
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      const first = this.entries.keys().next().value!;
      this.bytes -= Buffer.byteLength(this.entries.get(first)!);
      this.entries.delete(first);
    }
  }
}
const sharedCache = new ReviewToolCache();

function encodeCursor(key: string, cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ key, ...cursor })).toString("base64url");
}
function decodeCursor(token: string | undefined, key: string): Cursor {
  if (!token) return { row: 1, byte: 0, range: 0 };
  if (token.length > 1024) throw new Error("Invalid continuation");
  const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  if (parsed.key !== key) throw new Error("Continuation belongs to a different query or revision");
  return {
    row: integer(parsed.row, 1, 1e9),
    byte: integer(parsed.byte, 0, 1e9),
    range: integer(parsed.range ?? 0, 0, 32),
  };
}

/** Drain command output in the VM, retaining only a bounded page. Never collect a full result. */
async function page(
  vm: SubmissionSandbox,
  command: string,
  cursor: Cursor,
  signal?: AbortSignal,
  budget = MAX_BYTES,
  count = MAX_RECORDS,
  end = 1e9,
): Promise<Page> {
  // A separate status file preserves Git's failure status across the streaming pipeline.
  // mktemp lives in this submission's disposable TMPDIR; scratch contents are never cached.
  const script = `d=$(mktemp -d) || exit 1
{ ${command}; printf '%s' "$?" > "$d/status"; } | LC_ALL=C awk -v start=${cursor.row} -v skip=${cursor.byte} -v budget=${budget} -v count=${count} -v last=${end} '
NR >= start && NR <= last && !done {
  off=(NR==start ? skip : 0); total=length($0); n=total-off;
  if (n>budget) n=budget;
  # Do not split UTF-8 codepoints between pages (LC_ALL=C means byte offsets).
  while (n>0 && substr($0,off+n+1,1) ~ /[\\200-\\277]/) n--;
  if(n<=0 && total>off && budget>=4 && count>0) { invalid=1; done=1; next }
  if (budget<4 || count<=0) { nextrow=NR; nextbyte=off; done=1; next }
  printf "R\\t%d\\t%d\\t%d\\t%s\\n", NR,off,total,substr($0,off+1,n);
  budget-=n; count--;
  if(off+n<total) { nextrow=NR; nextbyte=off+n; done=1 }
}
END { if(invalid) { print "E\\tUnsupported UTF-8 encoding"; print "N\\t0\\t0" } else if(done) printf "N\\t%d\\t%d\\n",nextrow,nextbyte; else print "N\\t0\\t0" }'
pipecode=$?
code=$(cat "$d/status" 2>/dev/null) || code=125
[ "$pipecode" -eq 0 ] || code=125
rm -f "$d/status"; rmdir "$d"
printf 'S\\t%s\\n' "$code"`;
  signal?.throwIfAborted();
  const result = await vm.execStructured(script, { signal });
  signal?.throwIfAborted();
  const records: Fragment[] = [];
  let next: Cursor | null = null;
  let exitCode = 125;
  let complete = false;
  let hasCursor = false;
  let encodingError: string | undefined;
  for (const line of result.stdout.split("\n")) {
    const match = /^R\t(\d+)\t(\d+)\t(\d+)\t(.*)$/s.exec(line);
    if (match)
      records.push({
        row: Number(match[1]),
        byte: Number(match[2]),
        totalBytes: Number(match[3]),
        text: match[4]!,
      });
    else if (line.startsWith("N\t")) {
      hasCursor = true;
      const [, row, byte] = line.split("\t");
      next = Number(row) ? { row: Number(row), byte: Number(byte) } : null;
    } else if (line.startsWith("E\t")) encodingError = line.slice(2);
    else if (/^S\t\d+$/.test(line)) {
      exitCode = Number(line.slice(2));
      complete = true;
    }
  }
  if (!complete || !hasCursor || result.exitCode !== 0)
    throw new Error(result.stderr || "Incomplete sandbox tool response");
  if (encodingError)
    return { records: [], next: null, bytes: 0, exitCode: 126, error: encodingError };
  if (next && next.row === cursor.row && next.byte <= cursor.byte)
    throw new Error("Sandbox continuation did not advance");
  return {
    records,
    next,
    exitCode,
    bytes: records.reduce((n, row) => n + Buffer.byteLength(row.text), 0),
    ...(exitCode > 1 ? { error: result.stderr.slice(0, 500) || `Git failed (${exitCode})` } : {}),
  };
}

export function mergeRanges(input: FileRange[]): Required<FileRange>[] {
  if (!input.length || input.length > 32) throw new Error("Provide 1–32 file ranges");
  const sorted = input
    .map(({ path, start = 1, end = start + 199 }) => ({
      path: repositoryPath(path),
      start: integer(start, 1, 1e9),
      end: integer(end, start, 1e9),
    }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.start - b.start);
  const merged: Required<FileRange>[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous?.path === range.path && range.start <= previous.end + 1)
      previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Git C-quoted paths include octal UTF-8 escapes, unlike JSON strings. */
export function decodeGitPath(value: string): string {
  if (!value.startsWith('"')) return value;
  const bytes: number[] = [];
  const content = value.slice(1, -1);
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== "\\") {
      bytes.push(...Buffer.from(content[i]!));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(content.slice(i + 1));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else {
      const escaped = content[++i]!;
      bytes.push(
        ({ t: 9, n: 10, r: 13, b: 8, f: 12, v: 11 } as Record<string, number>)[escaped] ??
          escaped.charCodeAt(0),
      );
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

export class StructuredReviewTools {
  constructor(
    private getSession: () => Promise<PrReviewSession>,
    private getSandbox: () => Promise<SubmissionSandbox>,
    private cache = sharedCache,
    private timeoutMs = 120000,
  ) {}

  private async scope(tool: string, args: unknown, continuation?: string) {
    const session = await this.getSession();
    revision(session.headSha);
    revision(session.baseSha);
    if (session.commitSha) revision(session.commitSha);
    const key = hash([
      VERSION,
      session.owner,
      session.repo,
      session.worktreePath,
      session.headSha,
      session.baseSha,
      session.reviewMode,
      session.commitSha,
      tool,
      args,
    ]);
    const cursor = decodeCursor(continuation, key);
    return { session, key, cursor, cacheKey: hash([key, cursor]) };
  }

  async search(args: SearchArgs, signal?: AbortSignal, observation?: ToolObservation) {
    signal = callSignal(signal, this.timeoutMs);
    if (args.pattern.length > 2000 || args.pattern.includes("\0") || args.pattern.includes("\n"))
      throw new Error("Search pattern must be a single line of at most 2000 characters");
    if (args.mode !== undefined && args.mode !== "literal" && args.mode !== "regex")
      throw new Error("Invalid search mode");
    const options = {
      pattern: args.pattern,
      mode: args.mode ?? "literal",
      paths: paths(args.paths),
      context: contextLines(args.context),
    };
    const scope = await this.scope("search", options, args.continuation);
    signal?.throwIfAborted();
    const cached = this.cache.get<Awaited<ReturnType<typeof this.searchUncached>>>(scope.cacheKey);
    if (cached) {
      observation?.metadata({ cacheHit: true });
      return cached;
    }
    const result = await this.searchUncached(scope, options, signal);
    if (result.status !== "error") this.cache.set(scope.cacheKey, result);
    return result;
  }
  private async searchUncached(
    scope: Awaited<ReturnType<StructuredReviewTools["scope"]>>,
    options: { pattern: string; mode: string; paths: string[]; context: number },
    signal?: AbortSignal,
  ) {
    // Exclude unsupported discovered paths in Git BEFORE translating any fields
    // or paging. Thus filenames can contain neither LF (record boundary) nor SOH
    // (translated NUL field boundary), while source text may safely contain SOH
    // after the first two separators. Never infer Git field boundaries from
    // unvalidated filenames by replacing NUL alone.
    const command = `${git} grep --no-textconv --color=never --no-heading --no-break --no-column --full-name -n -z -I -${options.mode === "regex" ? "E" : "F"} -C ${options.context} -e ${quote(options.pattern)} ${quote(scope.session.headSha)} -- ${pathArgs(options.paths)} ${supportedSearchPaths}`;
    const result = await page(
      await this.getSandbox(),
      `f=$(mktemp) || exit 1; { ${command}; printf '%s' "$?" > "$f"; } | tr '\\000' '\\001'; pipecode=$?; code=$(cat "$f"); rm -f "$f"; [ "$pipecode" -eq 0 ] || code=125; (exit "$code")`,
      scope.cursor,
      signal,
    );
    const records = result.records.map((record) => {
      const match =
        // Git's NUL separators were deliberately translated to SOH above.
        // oxlint-disable-next-line no-control-regex
        record.byte === 0 ? /^[^:]+:([^\x01]+)\x01(\d+)\x01(.*)$/s.exec(record.text) : null;
      return {
        ...record,
        ...(match ? { path: match[1], line: Number(match[2]), text: match[3] } : {}),
        kind: match
          ? "line"
          : record.byte
            ? "fragment"
            : record.text === "--"
              ? "separator"
              : "unparsed",
      };
    });
    return {
      status: result.exitCode === 0 ? "ok" : result.exitCode === 1 ? "no_match" : "error",
      revision: scope.session.headSha,
      records,
      ...(result.error ? { error: result.error } : {}),
      truncated: result.next !== null,
      continuation: result.next ? encodeCursor(scope.key, result.next) : null,
    };
  }

  async read(args: ReadArgs, signal?: AbortSignal, observation?: ToolObservation) {
    signal = callSignal(signal, this.timeoutMs);
    const ranges = mergeRanges(args.ranges);
    const scope = await this.scope("read", ranges, args.continuation);
    signal?.throwIfAborted();
    const cached = this.cache.get<ReadResult>(scope.cacheKey);
    if (cached) {
      observation?.metadata({ cacheHit: true });
      return cached;
    }
    const files: ReadResult["files"] = [];
    let budget = MAX_BYTES,
      count = MAX_RECORDS;
    let next: Cursor | null = null;
    const vm = await this.getSandbox();
    for (let index = scope.cursor.range ?? 0; index < ranges.length; index++) {
      const range = ranges[index]!;
      const cursor =
        index === scope.cursor.range
          ? { ...scope.cursor, row: Math.max(scope.cursor.row, range.start) }
          : { row: range.start, byte: 0 };
      if (budget < 4 || count <= 0) {
        next = { ...cursor, range: index };
        break;
      }
      const command = `${git} cat-file blob ${quote(`${scope.session.headSha}:${range.path}`)}`;
      const error = await validateText(vm, command, signal);
      if (error) {
        files.push({ ...range, lines: [], error });
        continue;
      }
      const result = await page(vm, command, cursor, signal, budget, count, range.end);
      if (result.exitCode !== 0) {
        files.push({
          ...range,
          lines: [],
          error: result.error ?? `Cannot read blob (${result.exitCode})`,
        });
        continue;
      }
      files.push({ ...range, lines: result.records });
      budget -= result.bytes;
      count -= result.records.length;
      if (result.next) {
        next = { ...result.next, range: index };
        break;
      }
    }
    const result: ReadResult = {
      revision: scope.session.headSha,
      files,
      truncated: next !== null,
      continuation: next ? encodeCursor(scope.key, next) : null,
    };
    // Failures may be transient missing objects; never cache partial failures.
    if (files.every((file) => !file.error)) this.cache.set(scope.cacheKey, result);
    return result;
  }

  async diff(args: DiffArgs, signal?: AbortSignal, observation?: ToolObservation) {
    signal = callSignal(signal, this.timeoutMs);
    const options = { paths: paths(args.paths), context: contextLines(args.context) };
    const scope = await this.scope("diff", options, args.continuation);
    signal?.throwIfAborted();
    const cached = this.cache.get<DiffResult>(scope.cacheKey);
    if (cached) {
      observation?.metadata({ cacheHit: true });
      return cached;
    }
    const vm = await this.getSandbox();
    const { session } = scope;
    // Resolve and check the saved base ref before using immutable SHAs in the actual diff.
    if (session.reviewMode === "full") {
      const base = await vm.execStructured(
        `${git} rev-parse --verify ${quote(`${reviewBaseRef(session)}^{commit}`)}`,
        { signal },
      );
      if (base.exitCode !== 0 || base.stdout.trim() !== session.baseSha)
        throw new Error("Saved review base ref does not match its recorded revision");
    }
    if (session.reviewMode === "commit" && !session.commitSha)
      throw new Error("Commit review has no saved commit");
    const range =
      session.reviewMode === "commit"
        ? `${session.commitSha}^..${session.commitSha}`
        : `${session.baseSha}...${session.headSha}`;
    // Annotate *before* pagination so pages starting in the middle of a hunk retain numbering.
    const command = `${git} diff --no-ext-diff --no-textconv --no-color --src-prefix=a/ --dst-prefix=b/ --no-relative --diff-algorithm=myers --find-renames=50% --unified=${options.context} ${quote(range)} -- ${pathArgs(options.paths)}`;
    // The outer page owns command status; the inner awk preserves it via a separate marker file.
    const annotated = `f=$(mktemp) || exit 1; { ${command}; printf '%s' "$?" > "$f"; } | LC_ALL=C awk '
/^diff --git / { old=0; new=0; hunk=0 }
/^@@ / { split($2,a,","); split($3,b,","); old=-a[1]; new=b[1]+0; hunk=1 }
{ o="-"; n="-"; if(hunk && $0 !~ /^@@ /) { c=substr($0,1,1); if(c==" " || c=="-") o=old++; if(c==" " || c=="+") n=new++ } printf "%s\\t%s\\t%s\\n",o,n,$0 }
'; pipecode=$?; code=$(cat "$f"); rm -f "$f"; [ "$pipecode" -eq 0 ] || code=125; (exit "$code")`;
    const result = await page(vm, annotated, scope.cursor, signal);
    const lines = result.records.map((record) => {
      const match = record.byte === 0 ? /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(record.text) : null;
      const text = match?.[3] ?? record.text;
      // The VM carries hunk state across pages via old/new numbering. A source
      // line beginning '++' becomes '+++ ...', but is never a file header.
      const isHeader =
        match?.[1] === "-" &&
        match?.[2] === "-" &&
        Buffer.byteLength(record.text) === record.totalBytes;
      const path = isHeader
        ? /^(?:---|\+\+\+) (.*)$/.exec(text)?.[1]?.split("\t", 1)[0]
        : undefined;
      return {
        ...record,
        text,
        oldLine: match?.[1] !== "-" && match ? Number(match[1]) : null,
        newLine: match?.[2] !== "-" && match ? Number(match[2]) : null,
        ...(path ? { path: decodeGitPath(path).replace(/^[ab]\//, "") } : {}),
      };
    });
    const output: DiffResult = {
      status: result.exitCode === 0 ? "ok" : "error",
      range,
      lines,
      ...(result.error ? { error: result.error } : {}),
      truncated: result.next !== null,
      continuation: result.next ? encodeCursor(scope.key, result.next) : null,
    };
    if (output.status === "ok") this.cache.set(scope.cacheKey, output);
    return output;
  }
}

interface ReadResult {
  revision: string;
  files: Array<Required<FileRange> & { lines: Fragment[]; error?: string }>;
  truncated: boolean;
  continuation: string | null;
}
interface DiffResult {
  status: string;
  range: string;
  lines: Array<Fragment & { oldLine: number | null; newLine: number | null; path?: string }>;
  error?: string;
  truncated: boolean;
  continuation: string | null;
}
