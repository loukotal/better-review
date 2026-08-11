export const STRUCTURED_REVIEW_PROMPT =
  "Please analyze this PR and provide a structured review with file order and annotations.";

export const ADVERSARIAL_REVIEW_PROMPT = `Please run an adversarial code review of this PR.

Use the Adversarial Code Reviewer workflow:

1. Gather the PR changes using the app-provided changed-file list and the canonical PR diff from your system instructions.
2. Read full context for every changed file, not just changed lines.
3. Identify the purpose of the change: bug fix, new feature, refactor, config change, or test.
4. Note project conventions from CLAUDE.md, .editorconfig, linting configs, tests, and nearby code patterns.
5. Run all three reviewer personas sequentially. Each persona must produce at least one substantive finding or the most fragile assumption it relies on.

Persona 1: The Saboteur
Mindset: "I am trying to break this code in production."
Focus on unvalidated input, inconsistent state, concurrency issues, swallowed errors, bad assumptions about data format or availability, null/undefined dereferences, off-by-one errors, and resource leaks.

Persona 2: The New Hire
Mindset: "I just joined this team. I need to understand and modify this code in 6 months with zero context from the original author."
Focus on unclear names, logic that requires too much file-hopping, magic strings or numbers, functions doing too much, missing type information, inconsistency with local patterns, weak tests, and comments that explain what instead of why.

Persona 3: The Security Auditor
Mindset: "This code will be attacked. My job is to find the vulnerability before an attacker does."
Focus on injection, broken auth, data exposure, insecure defaults, missing access control, dependency risk, and secrets in code, config, logs, or comments.

Severity classification:
- CRITICAL: Will cause data loss, security breach, or production outage. Blocks merge.
- WARNING: Likely to cause bugs in edge cases, degrade performance, or confuse future maintainers. Should fix before merge.
- NOTE: Style issue, minor improvement opportunity, or documentation gap.
- Promote any finding caught by 2+ personas by one severity level.

Anti-patterns to avoid:
- Do not say "LGTM, no issues found."
- Do not report only cosmetic issues while missing substantive risk.
- Do not restate the diff as a finding.
- Do not review only changed lines.
- New code without meaningful tests is a finding unless the surrounding project clearly does not test comparable behavior.

Output format:
## Adversarial Review: [brief description of what was reviewed]

**Scope:** [files reviewed, lines changed, type of change]
**Verdict:** BLOCK / CONCERNS / CLEAN

### Critical Findings
[If any; these block merge.]

### Warnings
[Should-fix items.]

### Notes
[Nice-to-fix items.]

### Summary
[2-3 sentences: overall risk profile and the single most important thing to fix.]

Use concrete file and line references. Use the app's annotation tokens for actionable findings when appropriate.`;

export const STE100_REVIEW_INSTRUCTION =
  "Language requirement: Use ASD-STE100 Simplified Technical English for all prose in this review, including summaries and annotation messages. Keep code, identifiers, file paths, and source quotations unchanged.";

export function buildReviewPrompt(prompt: string, useSte100: boolean): string {
  return useSte100 ? `${prompt}\n\n${STE100_REVIEW_INSTRUCTION}` : prompt;
}
