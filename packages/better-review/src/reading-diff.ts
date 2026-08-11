import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import {
  Type,
  contentText,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { getFlueProviders } from "./flue/oauth-auth";
import { STORE_BASE_DIR } from "./store";

const READING_DIFF_PROTOCOL_VERSION = "better-review-reading-diff-v4";
const LEGACY_REPORT_PROTOCOL_VERSION = "better-review-reading-diff-v3";
const READING_DIFF_CACHE_DIR = join(STORE_BASE_DIR, "reading-diffs");
const PR_INTELLIGENCE_SKILL_URL = new URL(
  "../../../.agents/skills/pr-intelligence/SKILL.md",
  import.meta.url,
);
const PR_INTELLIGENCE_SKILL_NAME = "pr-intelligence";
const READING_MODEL = "openai-codex/gpt-5.6-luna";
const READING_THINKING_LEVEL = "xhigh";
const MAX_TOTAL_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_CHUNK_BYTES = 300 * 1024;
const MAX_SUMMARY_LENGTH = 240;
const MAX_REPOSITORY_INSPECTION_ROUNDS = 6;
const MAX_PLAN_ROUNDS = MAX_REPOSITORY_INSPECTION_ROUNDS + 2;
const MAX_REPOSITORY_FILE_BYTES = 96 * 1024;
const MAX_REPOSITORY_TOOL_OUTPUT = 40 * 1024;
const execFile = promisify(execFileCallback);

export interface ReadingDiffRange {
  startLine: number;
  endLine: number;
}

export interface ReadingDiffPlan {
  remove: ReadingDiffRange[];
  fold: ReadingDiffRange[];
  summary: string;
  report: ReadingDiffReport;
}

export type ReadingDiffConfidence = "high" | "medium" | "low";
export type ReadingDiffRisk = "high" | "medium" | "low";

export interface ReadingDiffEvidence {
  file: string;
  line?: number;
}

export interface ReadingDiffFlowStep {
  kind: "entry" | "boundary" | "service" | "persistence" | "side_effect" | "other";
  label: string;
  detail?: string;
  evidence?: ReadingDiffEvidence;
  confidence: ReadingDiffConfidence;
  inferred: boolean;
}

export interface ReadingDiffFlow {
  title: string;
  confidence: ReadingDiffConfidence;
  steps: ReadingDiffFlowStep[];
}

export interface ReadingDiffImpact {
  area: string;
  impact: string;
  risk: ReadingDiffRisk;
  evidence: ReadingDiffEvidence[];
}

export interface ReadingDiffReviewFocus {
  severity: ReadingDiffRisk;
  title: string;
  rationale: string;
  evidence: ReadingDiffEvidence[];
}

export interface ReadingDiffReport {
  overview: string;
  flows: ReadingDiffFlow[];
  blastRadius: ReadingDiffImpact[];
  reviewFocus: ReadingDiffReviewFocus[];
  unknowns: string[];
}

export interface ReadingDiffStats {
  originalChangedLines: number;
  readingChangedLines: number;
  removedChangedLines: number;
  compressionPercent: number;
  originalFiles: number;
  readingFiles: number;
}

export interface ReadingDiffResult {
  smartDiff: string;
  summary: string;
  report: ReadingDiffReport;
  reportMarkdown: string;
  stats: ReadingDiffStats;
  model: string;
  sourceHeadSha: string;
  selectedSkills: string[];
  generatedAt: number;
  cacheKey: string;
  cached: boolean;
}

interface ReadingDiffCacheEntry extends Omit<ReadingDiffResult, "cached"> {
  protocolVersion: string;
}

interface PlanChunkResult {
  smartDiff: string;
  summary: string;
  report: ReadingDiffReport;
}

type PlanGenerator = (
  numberedDiff: string,
  correction?: string,
  repositoryRoot?: string,
) => Promise<ReadingDiffPlan>;

const confidenceSchema = Type.Union([
  Type.Literal("high"),
  Type.Literal("medium"),
  Type.Literal("low"),
]);

const evidenceSchema = Type.Object(
  {
    file: Type.String({ minLength: 1, maxLength: 500 }),
    line: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

const reportSchema = Type.Object(
  {
    overview: Type.String({ minLength: 1, maxLength: 1_200 }),
    flows: Type.Array(
      Type.Object(
        {
          title: Type.String({ minLength: 1, maxLength: 160 }),
          confidence: confidenceSchema,
          steps: Type.Array(
            Type.Object(
              {
                kind: Type.Union([
                  Type.Literal("entry"),
                  Type.Literal("boundary"),
                  Type.Literal("service"),
                  Type.Literal("persistence"),
                  Type.Literal("side_effect"),
                  Type.Literal("other"),
                ]),
                label: Type.String({ minLength: 1, maxLength: 160 }),
                detail: Type.Union([Type.String({ maxLength: 300 }), Type.Null()]),
                evidence: Type.Union([evidenceSchema, Type.Null()]),
                confidence: confidenceSchema,
                inferred: Type.Boolean(),
              },
              { additionalProperties: false },
            ),
            { maxItems: 10 },
          ),
        },
        { additionalProperties: false },
      ),
      { maxItems: 3 },
    ),
    blastRadius: Type.Array(
      Type.Object(
        {
          area: Type.String({ minLength: 1, maxLength: 160 }),
          impact: Type.String({ minLength: 1, maxLength: 500 }),
          risk: confidenceSchema,
          evidence: Type.Array(evidenceSchema, { maxItems: 5 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 12 },
    ),
    reviewFocus: Type.Array(
      Type.Object(
        {
          severity: confidenceSchema,
          title: Type.String({ minLength: 1, maxLength: 200 }),
          rationale: Type.String({ minLength: 1, maxLength: 500 }),
          evidence: Type.Array(evidenceSchema, { maxItems: 5 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 12 },
    ),
    unknowns: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 12 }),
  },
  { additionalProperties: false },
);

const submitReadingReportTool = {
  name: "submit_reading_report",
  description: "Submit the PR intelligence report and a one-line summary.",
  parameters: Type.Object(
    {
      summary: Type.String({
        minLength: 1,
        maxLength: MAX_SUMMARY_LENGTH,
        description: "One-line description of the behavior represented by the diff.",
      }),
      report: reportSchema,
    },
    { additionalProperties: false },
  ),
  constrainedSampling: { type: "json_schema" as const, strict: "prefer" as const },
};

const submitSummaryTool = {
  name: "submit_reading_report_summary",
  description: "Submit one concise sentence summarizing all reading-diff chunks.",
  parameters: Type.Object(
    {
      summary: Type.String({ minLength: 1, maxLength: MAX_SUMMARY_LENGTH }),
    },
    { additionalProperties: false },
  ),
  constrainedSampling: { type: "json_schema" as const, strict: "prefer" as const },
};

const baseSystemPrompt = [
  "You produce a source-derived PR intelligence report for an experienced reviewer.",
  "Explain changed behavior, control flow, data flow, contracts, architecture, security boundaries, compatibility decisions, and meaningful test scenarios.",
  "Do not rewrite or condense the diff. It remains unchanged as the canonical review surface.",
  "Use repository tools to inspect surrounding implementation before claiming program paths, callers, persistence, or side effects.",
  "Call submit_reading_report exactly once with the summary and structured report.",
].join("\n");

function createReadingModels() {
  const models = builtinModels();
  for (const provider of getFlueProviders()) {
    models.setProvider(provider);
  }
  return models;
}

function resolveReadingModel(): {
  models: ReturnType<typeof createReadingModels>;
  model: Model<Api>;
} {
  const selected = READING_MODEL;
  const slash = selected.indexOf("/");
  if (slash === -1) throw new Error(`Invalid selected model: ${selected}`);

  const providerId = selected.slice(0, slash);
  const modelId = selected.slice(slash + 1);
  const models = createReadingModels();
  const model = models.getModel(providerId, modelId);
  if (!model) throw new Error(`Selected model is unavailable: ${selected}`);
  return { models, model };
}

function findToolCall(message: AssistantMessage, name: string): ToolCall | undefined {
  return message.content.find(
    (block): block is ToolCall => block.type === "toolCall" && block.name === name,
  );
}

function ensureText(value: unknown, label: string, maxLength = 500): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be text`);
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function ensureConfidence(value: unknown, label: string): ReadingDiffConfidence {
  if (value !== "high" && value !== "medium" && value !== "low") {
    throw new Error(`${label} must be high, medium, or low`);
  }
  return value;
}

function normalizeEvidence(value: unknown, label: string): ReadingDiffEvidence {
  if (!value || typeof value !== "object") throw new Error(`${label} must be an object`);
  const evidence = value as { file?: unknown; line?: unknown };
  if (
    evidence.line !== null &&
    evidence.line !== undefined &&
    (!Number.isInteger(evidence.line) || Number(evidence.line) < 1)
  ) {
    throw new Error(`${label}.line must be a positive integer`);
  }
  return {
    file: ensureText(evidence.file, `${label}.file`, 500),
    line:
      evidence.line === null || evidence.line === undefined ? undefined : (evidence.line as number),
  };
}

function normalizeReport(value: unknown): ReadingDiffReport {
  if (!value || typeof value !== "object") throw new Error("Reading diff plan needs a report");
  const report = value as Record<string, unknown>;
  if (
    !Array.isArray(report.flows) ||
    !Array.isArray(report.blastRadius) ||
    !Array.isArray(report.reviewFocus) ||
    !Array.isArray(report.unknowns)
  ) {
    throw new Error("Reading diff report arrays are incomplete");
  }

  return {
    overview: ensureText(report.overview, "report.overview", 1_200),
    flows: report.flows.slice(0, 3).map((value, flowIndex) => {
      if (!value || typeof value !== "object")
        throw new Error(`report.flows[${flowIndex}] invalid`);
      const flow = value as Record<string, unknown>;
      if (!Array.isArray(flow.steps)) throw new Error(`report.flows[${flowIndex}].steps invalid`);
      return {
        title: ensureText(flow.title, `report.flows[${flowIndex}].title`, 160),
        confidence: ensureConfidence(flow.confidence, `report.flows[${flowIndex}].confidence`),
        steps: flow.steps.slice(0, 10).map((stepValue, stepIndex) => {
          if (!stepValue || typeof stepValue !== "object") {
            throw new Error(`report.flows[${flowIndex}].steps[${stepIndex}] invalid`);
          }
          const step = stepValue as Record<string, unknown>;
          const allowedKinds = new Set([
            "entry",
            "boundary",
            "service",
            "persistence",
            "side_effect",
            "other",
          ]);
          if (typeof step.kind !== "string" || !allowedKinds.has(step.kind)) {
            throw new Error(`report.flows[${flowIndex}].steps[${stepIndex}].kind invalid`);
          }
          return {
            kind: step.kind as ReadingDiffFlowStep["kind"],
            label: ensureText(
              step.label,
              `report.flows[${flowIndex}].steps[${stepIndex}].label`,
              160,
            ),
            detail:
              typeof step.detail === "string"
                ? ensureText(
                    step.detail,
                    `report.flows[${flowIndex}].steps[${stepIndex}].detail`,
                    300,
                  )
                : undefined,
            evidence: step.evidence
              ? normalizeEvidence(
                  step.evidence,
                  `report.flows[${flowIndex}].steps[${stepIndex}].evidence`,
                )
              : undefined,
            confidence: ensureConfidence(
              step.confidence,
              `report.flows[${flowIndex}].steps[${stepIndex}].confidence`,
            ),
            inferred: step.inferred === true,
          };
        }),
      };
    }),
    blastRadius: report.blastRadius.slice(0, 12).map((value, index) => {
      if (!value || typeof value !== "object")
        throw new Error(`report.blastRadius[${index}] invalid`);
      const impact = value as Record<string, unknown>;
      return {
        area: ensureText(impact.area, `report.blastRadius[${index}].area`, 160),
        impact: ensureText(impact.impact, `report.blastRadius[${index}].impact`, 500),
        risk: ensureConfidence(impact.risk, `report.blastRadius[${index}].risk`),
        evidence: Array.isArray(impact.evidence)
          ? impact.evidence
              .slice(0, 5)
              .map((item, evidenceIndex) =>
                normalizeEvidence(item, `report.blastRadius[${index}].evidence[${evidenceIndex}]`),
              )
          : [],
      };
    }),
    reviewFocus: report.reviewFocus.slice(0, 12).map((value, index) => {
      if (!value || typeof value !== "object")
        throw new Error(`report.reviewFocus[${index}] invalid`);
      const focus = value as Record<string, unknown>;
      return {
        severity: ensureConfidence(focus.severity, `report.reviewFocus[${index}].severity`),
        title: ensureText(focus.title, `report.reviewFocus[${index}].title`, 200),
        rationale: ensureText(focus.rationale, `report.reviewFocus[${index}].rationale`, 500),
        evidence: Array.isArray(focus.evidence)
          ? focus.evidence
              .slice(0, 5)
              .map((item, evidenceIndex) =>
                normalizeEvidence(item, `report.reviewFocus[${index}].evidence[${evidenceIndex}]`),
              )
          : [],
      };
    }),
    unknowns: report.unknowns
      .slice(0, 12)
      .map((unknown, index) => ensureText(unknown, `report.unknowns[${index}]`, 500)),
  };
}

function normalizePlan(value: unknown): ReadingDiffPlan {
  if (!value || typeof value !== "object") throw new Error("Model did not submit a report object");
  const plan = value as { summary?: unknown; report?: unknown };
  if (typeof plan.summary !== "string" || !plan.summary.trim()) {
    throw new Error("Reading report must include a one-line summary");
  }

  return {
    remove: [],
    fold: [],
    summary: normalizeSummary(plan.summary),
    report: normalizeReport(plan.report),
  };
}

function normalizeSummary(summary: string): string {
  return summary.replace(/\s+/g, " ").trim().slice(0, MAX_SUMMARY_LENGTH);
}

function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate.trim()) throw new Error("Model returned neither a tool call nor JSON");
  return JSON.parse(candidate);
}

const readRepositoryFileTool = {
  name: "read_repo_file",
  description: "Read one repository-relative text file from the prepared PR checkout.",
  parameters: Type.Object(
    { path: Type.String({ minLength: 1, maxLength: 500 }) },
    { additionalProperties: false },
  ),
};

const searchRepositoryTool = {
  name: "search_repo",
  description:
    "Search the prepared PR checkout for an exact identifier or short text fragment. Returns repository-relative file and line matches.",
  parameters: Type.Object(
    { query: Type.String({ minLength: 2, maxLength: 160 }) },
    { additionalProperties: false },
  ),
};

const listRepositoryFilesTool = {
  name: "list_repo_files",
  description: "List tracked repository files, optionally filtered by a short text fragment.",
  parameters: Type.Object(
    { filter: Type.Optional(Type.String({ maxLength: 120 })) },
    { additionalProperties: false },
  ),
};

async function resolveRepositoryFile(repositoryRoot: string, filePath: string): Promise<string> {
  if (isAbsolute(filePath) || filePath.includes("\0")) {
    throw new Error("Repository paths must be relative");
  }
  const root = await realpath(repositoryRoot);
  const candidate = resolve(root, filePath);
  const candidateRelative = relative(root, candidate);
  if (!candidateRelative || candidateRelative.startsWith("..") || isAbsolute(candidateRelative)) {
    throw new Error(`File is outside the prepared checkout: ${filePath}`);
  }
  const canonical = await realpath(candidate);
  const canonicalRelative = relative(root, canonical);
  if (!canonicalRelative || canonicalRelative.startsWith("..") || isAbsolute(canonicalRelative)) {
    throw new Error(`File resolves outside the prepared checkout: ${filePath}`);
  }
  return canonical;
}

async function readRepositoryFile(repositoryRoot: string, filePath: string): Promise<string> {
  const canonical = await resolveRepositoryFile(repositoryRoot, filePath);
  const content = await readFile(canonical);
  const truncated = content.byteLength > MAX_REPOSITORY_FILE_BYTES;
  const text = content.subarray(0, MAX_REPOSITORY_FILE_BYTES).toString("utf8");
  return truncated ? `${text}\n\n[truncated after ${MAX_REPOSITORY_FILE_BYTES} bytes]` : text;
}

async function runRepositoryCommand(
  repositoryRoot: string,
  command: string,
  args: string[],
): Promise<string> {
  const root = await realpath(repositoryRoot);
  try {
    const result = await execFile(command, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: MAX_REPOSITORY_TOOL_OUTPUT * 4,
      timeout: 15_000,
    });
    return String(result.stdout).slice(0, MAX_REPOSITORY_TOOL_OUTPUT);
  } catch (error) {
    const output = (error as { stdout?: string }).stdout;
    if (typeof output === "string" && output.trim()) {
      return output.slice(0, MAX_REPOSITORY_TOOL_OUTPUT);
    }
    throw error;
  }
}

async function executeRepositoryTool(repositoryRoot: string, call: ToolCall): Promise<string> {
  const args = call.arguments as { path?: unknown; query?: unknown; filter?: unknown };
  if (call.name === readRepositoryFileTool.name) {
    if (typeof args.path !== "string") throw new Error("read_repo_file requires path");
    return readRepositoryFile(repositoryRoot, args.path);
  }
  if (call.name === searchRepositoryTool.name) {
    if (typeof args.query !== "string" || args.query.includes("\n")) {
      throw new Error("search_repo requires one short query");
    }
    const output = await runRepositoryCommand(repositoryRoot, "rg", [
      "-n",
      "--hidden",
      "--fixed-strings",
      "--glob",
      "!.git/**",
      "--glob",
      "!**/node_modules/**",
      "--glob",
      "!**/dist/**",
      "--glob",
      "!**/build/**",
      "--",
      args.query,
      ".",
    ]);
    return output || "No matches.";
  }
  if (call.name === listRepositoryFilesTool.name) {
    const output = await runRepositoryCommand(repositoryRoot, "git", ["ls-files"]);
    const filter = typeof args.filter === "string" ? args.filter.toLowerCase() : "";
    return output
      .split("\n")
      .filter((file) => !filter || file.toLowerCase().includes(filter))
      .slice(0, 2_000)
      .join("\n");
  }
  throw new Error(`Unsupported repository tool: ${call.name}`);
}

async function requestPlan(
  diff: string,
  correction?: string,
  repositoryRoot?: string,
): Promise<ReadingDiffPlan> {
  const { models, model } = resolveReadingModel();
  const skillInstructions = await readFile(PR_INTELLIGENCE_SKILL_URL, "utf8");
  const correctionText = correction
    ? `\n\nThe previous report was rejected: ${correction}\nSubmit a corrected complete report.`
    : "";
  const repositoryText = repositoryRoot
    ? "A prepared repository checkout is available through the repository tools. Inspect it before submitting."
    : "No prepared repository checkout is available. Limit claims to the diff and put unresolved context in Unknowns.";
  const context: Context = {
    systemPrompt: `${baseSystemPrompt}\n\nSelected skill instructions:\n${skillInstructions}`,
    messages: [
      {
        role: "user",
        content: `Create an overview-first PR intelligence report for this unified diff.${correctionText}\n\n${repositoryText}\n\n${diff}`,
        timestamp: Date.now(),
      },
    ],
    tools: repositoryRoot
      ? [
          readRepositoryFileTool,
          searchRepositoryTool,
          listRepositoryFilesTool,
          submitReadingReportTool,
        ]
      : [submitReadingReportTool],
  };

  for (let round = 0; round < MAX_PLAN_ROUNDS; round += 1) {
    if (repositoryRoot && round === MAX_REPOSITORY_INSPECTION_ROUNDS) {
      context.messages.push({
        role: "user",
        content:
          "Repository inspection is complete. Do not request more files or searches. Submit the complete structured report now, using the evidence already gathered and putting unresolved facts in Unknowns.",
        timestamp: Date.now(),
      });
      context.tools = [submitReadingReportTool];
    }

    const response = await models.completeSimple(model, context, {
      reasoning: READING_THINKING_LEVEL,
      maxTokens: 16_384,
      timeoutMs: 4 * 60_000,
      maxRetryDelayMs: 30_000,
    });
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || `Model stopped with ${response.stopReason}`);
    }

    context.messages.push(response);
    const submit = findToolCall(response, submitReadingReportTool.name);
    if (submit) return normalizePlan(submit.arguments);

    const toolCalls = response.content.filter(
      (block): block is ToolCall => block.type === "toolCall",
    );
    if (toolCalls.length === 0) {
      return normalizePlan(extractJsonObject(contentText(response.content)));
    }

    for (const call of toolCalls) {
      try {
        const result = repositoryRoot
          ? await executeRepositoryTool(repositoryRoot, call)
          : "Repository tools are unavailable for this request.";
        context.messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: result }],
          isError: false,
          timestamp: Date.now(),
        });
      } catch (error) {
        context.messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
          timestamp: Date.now(),
        });
      }
    }
  }

  throw new Error("The model did not submit a report within the bounded analysis run");
}

async function summarizeChunks(summaries: string[]): Promise<string> {
  if (summaries.length === 1) return summaries[0];

  const { models, model } = resolveReadingModel();
  const response = await models.completeSimple(
    model,
    {
      systemPrompt:
        "Combine partial code-change summaries into one concrete sentence. Do not add facts. Call submit_reading_report_summary exactly once.",
      messages: [
        {
          role: "user",
          content: summaries.map((summary, index) => `${index + 1}. ${summary}`).join("\n"),
          timestamp: Date.now(),
        },
      ],
      tools: [submitSummaryTool],
    },
    {
      reasoning: "low",
      maxTokens: 1_024,
      timeoutMs: 2 * 60_000,
      maxRetryDelayMs: 30_000,
    },
  );

  const toolCall = findToolCall(response, submitSummaryTool.name);
  const value = toolCall?.arguments ?? extractJsonObject(contentText(response.content));
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as { summary?: unknown }).summary !== "string"
  ) {
    throw new Error("Model did not submit a combined reading-diff summary");
  }
  return normalizeSummary((value as { summary: string }).summary);
}

function isHunkSourceLine(line: string): boolean {
  if (line.startsWith("+++ ") || line.startsWith("--- ")) return false;
  return line.startsWith("+") || line.startsWith("-") || line.startsWith(" ");
}

function isChangedLine(line: string): boolean {
  return isHunkSourceLine(line) && (line.startsWith("+") || line.startsWith("-"));
}

function hunkIds(lines: string[]): number[] {
  let current = -1;
  let nextHunk = 0;
  return lines.map((line) => {
    if (line.startsWith("diff --git ")) current = -1;
    if (line.startsWith("@@")) current = nextHunk++;
    return isHunkSourceLine(line) && current >= 0 ? current : -1;
  });
}

function sourceIndent(line: string): string {
  return line.slice(1).match(/^\s*/)?.[0] ?? "";
}

function validateRange(range: ReadingDiffRange, lineCount: number, label: string): void {
  if (range.startLine < 1 || range.endLine < range.startLine || range.endLine > lineCount) {
    throw new Error(`${label} ${range.startLine}-${range.endLine} is outside the numbered diff`);
  }
}

function importLineIndexes(lines: string[], ids: number[]): Set<number> {
  const indexes = new Set<number>();
  const singleLine = [
    /^\s*(?:import|export)\s+(?:type\s+)?(?:[\w*{]|["'])/,
    /^\s*(?:const|let|var)\s+[^=]+\s*=\s*require\s*\(/,
    /^\s*(?:from\s+\S+\s+import|import\s+\S+)/,
    /^\s*use\s+(?:crate|self|super|[A-Za-z_])(?:::\S+)?\s*;/,
    /^\s*#\s*include\s*[<"]/,
    /^\s*import\s+[\w.]+(?:\.\*)?\s*;/,
  ];

  const blockStart = [
    /^\s*import\s*\($/,
    /^\s*(?:import|export)\s+(?:type\s+)?\{$/,
    /^\s*from\s+\S+\s+import\s*\($/,
    /^\s*use\s+\S*\{$/,
  ];

  for (let index = 0; index < lines.length; index += 1) {
    if (!isHunkSourceLine(lines[index])) continue;
    const marker = lines[index][0];
    const content = lines[index].slice(1);
    if (singleLine.some((pattern) => pattern.test(content))) indexes.add(index);

    if (!blockStart.some((pattern) => pattern.test(content))) continue;
    indexes.add(index);
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (ids[cursor] !== ids[index] || lines[cursor][0] !== marker) break;
      indexes.add(cursor);
      const row = lines[cursor].slice(1).trim();
      if (row === ")" || row === "};" || /}\s+from\s+["']/.test(row)) {
        index = cursor;
        break;
      }
    }
  }
  return indexes;
}

export function applyReadingDiffPlan(diff: string, plan: ReadingDiffPlan): string {
  const lines = diff.split("\n");
  const ids = hunkIds(lines);
  const removed = importLineIndexes(lines, ids);
  const foldStarts = new Map<number, ReadingDiffRange>();
  const folded = new Set<number>();

  for (const [index, range] of plan.remove.entries()) {
    validateRange(range, lines.length, `remove[${index}]`);
    let removedSourceLine = false;
    let firstMetadataLine: number | undefined;
    for (let lineNumber = range.startLine; lineNumber <= range.endLine; lineNumber += 1) {
      const lineIndex = lineNumber - 1;
      if (!isHunkSourceLine(lines[lineIndex])) {
        firstMetadataLine ??= lineNumber;
        continue;
      }
      removed.add(lineIndex);
      removedSourceLine = true;
    }
    if (!removedSourceLine) {
      throw new Error(
        `remove[${index}] includes diff metadata at line ${firstMetadataLine ?? range.startLine}`,
      );
    }
  }

  for (const [index, range] of plan.fold.entries()) {
    validateRange(range, lines.length, `fold[${index}]`);
    if (range.endLine - range.startLine < 1) {
      throw new Error(`fold[${index}] must contain at least two lines`);
    }

    let segmentStart: number | undefined;
    let segmentEnd: number | undefined;
    let segmentHunk = -1;
    let segmentMarker = "";
    let createdFold = false;

    const finishSegment = () => {
      if (segmentStart === undefined || segmentEnd === undefined) return;
      if (segmentEnd - segmentStart >= 1) {
        const normalizedRange = {
          startLine: segmentStart + 1,
          endLine: segmentEnd + 1,
        };
        foldStarts.set(segmentStart, normalizedRange);
        for (let lineIndex = segmentStart; lineIndex <= segmentEnd; lineIndex += 1) {
          folded.add(lineIndex);
        }
        createdFold = true;
      }
      segmentStart = undefined;
      segmentEnd = undefined;
      segmentHunk = -1;
      segmentMarker = "";
    };

    for (let lineNumber = range.startLine; lineNumber <= range.endLine; lineNumber += 1) {
      const lineIndex = lineNumber - 1;
      const eligible =
        isHunkSourceLine(lines[lineIndex]) &&
        ids[lineIndex] >= 0 &&
        !removed.has(lineIndex) &&
        !folded.has(lineIndex);
      const continuesSegment =
        eligible &&
        segmentStart !== undefined &&
        ids[lineIndex] === segmentHunk &&
        lines[lineIndex][0] === segmentMarker;

      if (!continuesSegment) finishSegment();
      if (!eligible) continue;
      if (segmentStart === undefined) {
        segmentStart = lineIndex;
        segmentHunk = ids[lineIndex];
        segmentMarker = lines[lineIndex][0];
      }
      segmentEnd = lineIndex;
    }
    finishSegment();

    if (!createdFold) {
      throw new Error(`fold[${index}] does not contain two compatible hunk source lines`);
    }
  }

  // If a plan removes every source row from a hunk, retain one fixed placeholder so
  // the diff remains navigable and parseable without inventing source text.
  const sourceByHunk = new Map<number, number[]>();
  for (let index = 0; index < lines.length; index += 1) {
    if (ids[index] < 0) continue;
    const list = sourceByHunk.get(ids[index]) ?? [];
    list.push(index);
    sourceByHunk.set(ids[index], list);
  }
  for (const sourceLines of sourceByHunk.values()) {
    const visible = sourceLines.some(
      (lineIndex) =>
        !removed.has(lineIndex) && (!folded.has(lineIndex) || foldStarts.has(lineIndex)),
    );
    if (visible) continue;
    const anchor =
      sourceLines.find((lineIndex) => isChangedLine(lines[lineIndex])) ?? sourceLines[0];
    removed.delete(anchor);
    foldStarts.set(anchor, { startLine: anchor + 1, endLine: anchor + 1 });
  }

  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const fold = foldStarts.get(index);
    if (fold) {
      output.push(`${lines[index][0]}${sourceIndent(lines[index])}...`);
      index = Math.max(index, fold.endLine - 1);
      continue;
    }
    if (removed.has(index) || folded.has(index)) continue;
    output.push(lines[index]);
  }
  return output.join("\n");
}

export function numberedDiff(diff: string): string {
  return diff
    .split("\n")
    .map((line, index) => `${index + 1}|${line}`)
    .join("\n");
}

function splitDiffIntoChunks(diff: string): string[] {
  if (Buffer.byteLength(diff) <= MAX_CHUNK_BYTES) return [diff];

  const starts = [...diff.matchAll(/^diff --git /gm)].map((match) => match.index ?? 0);
  if (starts.length === 0) throw new Error("Large input is not a supported unified diff");

  const sections: string[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = index === 0 ? 0 : starts[index];
    const end = starts[index + 1] ?? diff.length;
    const section = diff.slice(start, end);
    if (Buffer.byteLength(section) > MAX_CHUNK_BYTES) {
      throw new Error(
        "One changed file is too large to analyze safely in one pass. Review that file directly in the diff.",
      );
    }
    sections.push(section);
  }

  const chunks: string[] = [];
  let current = "";
  for (const section of sections) {
    if (current && Buffer.byteLength(current) + Buffer.byteLength(section) > MAX_CHUNK_BYTES) {
      chunks.push(current);
      current = "";
    }
    current += section;
  }
  if (current) chunks.push(current);
  return chunks;
}

function diffStats(original: string, reading: string): ReadingDiffStats {
  const countChanged = (value: string) => value.split("\n").filter(isChangedLine).length;
  const countFiles = (value: string) =>
    value.split("\n").filter((line) => line.startsWith("diff --git ")).length;
  const originalChangedLines = countChanged(original);
  const readingChangedLines = countChanged(reading);
  const removedChangedLines = Math.max(0, originalChangedLines - readingChangedLines);
  return {
    originalChangedLines,
    readingChangedLines,
    removedChangedLines,
    compressionPercent:
      originalChangedLines === 0
        ? 0
        : Math.round((removedChangedLines / originalChangedLines) * 100),
    originalFiles: countFiles(original),
    readingFiles: countFiles(reading),
  };
}

function readingDiffCacheKeyForProtocol(
  diff: string,
  model: string,
  protocolVersion: string,
): string {
  return createHash("sha256")
    .update(protocolVersion)
    .update("\0")
    .update(model)
    .update("\0")
    .update(diff)
    .digest("hex");
}

export function readingDiffCacheKey(diff: string, model: string): string {
  return readingDiffCacheKeyForProtocol(diff, model, READING_DIFF_PROTOCOL_VERSION);
}

async function readCache(
  key: string,
  protocolVersion = READING_DIFF_PROTOCOL_VERSION,
): Promise<ReadingDiffCacheEntry | null> {
  try {
    const entry = JSON.parse(
      await readFile(join(READING_DIFF_CACHE_DIR, `${key}.json`), "utf8"),
    ) as ReadingDiffCacheEntry;
    return entry.protocolVersion === protocolVersion ? entry : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

async function writeCache(key: string, entry: ReadingDiffCacheEntry): Promise<void> {
  await mkdir(READING_DIFF_CACHE_DIR, { recursive: true });
  const target = join(READING_DIFF_CACHE_DIR, `${key}.json`);
  const temporary = join(READING_DIFF_CACHE_DIR, `.${key}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(entry, null, 2));
  await rename(temporary, target);
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function combineReports(results: PlanChunkResult[], summary: string): ReadingDiffReport {
  if (results.length === 1) return results[0].report;
  return {
    overview: summary,
    flows: uniqueBy(
      results.flatMap((result) => result.report.flows),
      (flow) => flow.title,
    ).slice(0, 3),
    blastRadius: uniqueBy(
      results.flatMap((result) => result.report.blastRadius),
      (impact) => `${impact.area}\0${impact.impact}`,
    ).slice(0, 12),
    reviewFocus: uniqueBy(
      results.flatMap((result) => result.report.reviewFocus),
      (focus) => `${focus.title}\0${focus.rationale}`,
    ).slice(0, 12),
    unknowns: [...new Set(results.flatMap((result) => result.report.unknowns))].slice(0, 12),
  };
}

function markdownEvidence(evidence: ReadingDiffEvidence): string {
  return `\`${evidence.file}${evidence.line ? `:${evidence.line}` : ""}\``;
}

export function renderReadingDiffReportMarkdown(report: ReadingDiffReport): string {
  const lines = ["## Overview", "", report.overview, "", "## Program design", ""];
  if (report.flows.length === 0)
    lines.push("No runtime flow could be established from the available evidence.");
  for (const flow of report.flows) {
    lines.push(`### ${flow.title}`, "");
    lines.push(
      flow.steps
        .map((step) => {
          const evidence = step.evidence ? ` (${markdownEvidence(step.evidence)})` : "";
          return `${step.label}${evidence}${step.inferred ? " [inferred]" : ""}`;
        })
        .join(" → "),
      "",
    );
  }
  lines.push("## Blast radius", "");
  for (const impact of report.blastRadius) {
    const evidence = impact.evidence.map(markdownEvidence).join(", ");
    lines.push(
      `- **${impact.risk}: ${impact.area}**: ${impact.impact}${evidence ? ` (${evidence})` : ""}`,
    );
  }
  lines.push("", "## Review focus", "");
  for (const focus of report.reviewFocus) {
    const evidence = focus.evidence.map(markdownEvidence).join(", ");
    lines.push(
      `- **${focus.severity}: ${focus.title}**: ${focus.rationale}${evidence ? ` (${evidence})` : ""}`,
    );
  }
  lines.push("", "## Unknowns", "");
  lines.push(
    ...(report.unknowns.length > 0
      ? report.unknowns.map((item) => `- ${item}`)
      : ["- None identified."]),
  );
  return lines.join("\n");
}

async function planChunk(
  diff: string,
  generatePlan: PlanGenerator,
  repositoryRoot?: string,
): Promise<PlanChunkResult> {
  let correction: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const plan = await generatePlan(numberedDiff(diff), correction, repositoryRoot);
    try {
      return {
        smartDiff: applyReadingDiffPlan(diff, plan),
        summary: plan.summary,
        report: plan.report,
      };
    } catch (error) {
      correction = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`The model could not produce a valid reading report: ${correction}`);
}

export async function abridgeReadingDiff(
  diff: string,
  generatePlan: PlanGenerator = requestPlan,
  repositoryRoot?: string,
): Promise<{
  smartDiff: string;
  summary: string;
  report: ReadingDiffReport;
  reportMarkdown: string;
  stats: ReadingDiffStats;
}> {
  if (!diff.trim()) throw new Error("Cannot generate a reading diff for an empty diff");
  if (Buffer.byteLength(diff) > MAX_TOTAL_DIFF_BYTES) {
    throw new Error("This diff is over the 2 MB reading-diff limit. Use a narrower commit scope.");
  }

  const chunks = splitDiffIntoChunks(diff);
  const results: PlanChunkResult[] = [];
  for (const chunk of chunks) {
    results.push(await planChunk(chunk, generatePlan, repositoryRoot));
  }

  const smartDiff = results.map((result) => result.smartDiff).join("");
  const summary = await summarizeChunks(results.map((result) => result.summary));
  const report = combineReports(results, summary);
  return {
    smartDiff,
    summary,
    report,
    reportMarkdown: renderReadingDiffReportMarkdown(report),
    stats: diffStats(diff, smartDiff),
  };
}

export async function analyzeReadingDiff(
  diff: string,
  generatePlan: PlanGenerator = requestPlan,
  repositoryRoot?: string,
): Promise<{
  smartDiff: string;
  summary: string;
  report: ReadingDiffReport;
  reportMarkdown: string;
  stats: ReadingDiffStats;
}> {
  if (!diff.trim()) throw new Error("Cannot analyze an empty diff");
  if (Buffer.byteLength(diff) > MAX_TOTAL_DIFF_BYTES) {
    throw new Error("This diff is over the 2 MB analysis limit. Use a narrower commit scope.");
  }

  const results: PlanChunkResult[] = [];
  for (const chunk of splitDiffIntoChunks(diff)) {
    const plan = await generatePlan(chunk, undefined, repositoryRoot);
    results.push({ smartDiff: chunk, summary: plan.summary, report: plan.report });
  }

  const summary = await summarizeChunks(results.map((result) => result.summary));
  const report = combineReports(results, summary);
  return {
    smartDiff: diff,
    summary,
    report,
    reportMarkdown: renderReadingDiffReportMarkdown(report),
    stats: diffStats(diff, diff),
  };
}

const inFlight = new Map<string, Promise<ReadingDiffResult>>();

export async function getOrGenerateReadingDiff(
  diff: string,
  options: {
    force?: boolean;
    sourceHeadSha?: string;
    prepareRepository?: () => Promise<string>;
  } = {},
): Promise<ReadingDiffResult> {
  const model = READING_MODEL;
  const cacheKey = readingDiffCacheKey(diff, model);

  if (!options.force) {
    const cached = await readCache(cacheKey);
    if (cached) return { ...cached, cached: true };

    const legacyCacheKey = readingDiffCacheKeyForProtocol(
      diff,
      model,
      LEGACY_REPORT_PROTOCOL_VERSION,
    );
    const legacy = await readCache(legacyCacheKey, LEGACY_REPORT_PROTOCOL_VERSION);
    if (legacy) {
      const migrated: ReadingDiffCacheEntry = {
        ...legacy,
        smartDiff: diff,
        stats: diffStats(diff, diff),
        cacheKey,
        protocolVersion: READING_DIFF_PROTOCOL_VERSION,
      };
      await writeCache(cacheKey, migrated);
      return { ...migrated, cached: true };
    }

    const pending = inFlight.get(cacheKey);
    if (pending) return pending;
  }

  const generation = (async () => {
    const repositoryRoot = await options.prepareRepository?.();
    const abridged = await analyzeReadingDiff(diff, requestPlan, repositoryRoot);
    const entry: ReadingDiffCacheEntry = {
      ...abridged,
      model,
      sourceHeadSha: options.sourceHeadSha ?? "unknown",
      selectedSkills: [PR_INTELLIGENCE_SKILL_NAME],
      generatedAt: Date.now(),
      cacheKey,
      protocolVersion: READING_DIFF_PROTOCOL_VERSION,
    };
    await writeCache(cacheKey, entry);
    return { ...entry, cached: false };
  })();

  inFlight.set(cacheKey, generation);
  try {
    return await generation;
  } finally {
    if (inFlight.get(cacheKey) === generation) inFlight.delete(cacheKey);
  }
}
