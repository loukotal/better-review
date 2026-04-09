import type {
  ReviewSession,
  ReviewSessionAnnotation,
  ReviewSessionMode,
  ReviewSessionResult,
} from "../types/session";

function toBlockquote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function normalizeFreeformFeedback(feedback: string): string {
  return feedback.trim();
}

function annotationHeading(
  mode: ReviewSessionMode,
  annotation: ReviewSessionAnnotation,
  index: number,
): string {
  if (mode === "diff") {
    if (annotation.filePath && annotation.startLine && annotation.endLine) {
      const lineLabel =
        annotation.startLine === annotation.endLine
          ? `Line ${annotation.endLine}`
          : `Lines ${annotation.startLine}-${annotation.endLine}`;
      return `### ${lineLabel}${annotation.side ? ` (${annotation.side === "RIGHT" ? "new" : "old"})` : ""}`;
    }

    if (annotation.filePath && annotation.line) {
      return `### Line ${annotation.line}${annotation.side ? ` (${annotation.side === "RIGHT" ? "new" : "old"})` : ""}`;
    }

    return "### File Comment";
  }

  if (annotation.quote.trim()) {
    return `## ${index}. Feedback on: "${annotation.quote.trim()}"`;
  }

  return `## ${index}. Feedback`;
}

export function exportPlanFeedback(result: ReviewSessionResult): string {
  const sections: string[] = ["# Plan Feedback"];
  const annotations = result.annotations;
  const generalFeedback = normalizeFreeformFeedback(result.feedback);

  if (annotations.length === 0 && !generalFeedback) {
    sections.push("", "No changes requested.");
    return sections.join("\n");
  }

  if (annotations.length > 0) {
    sections.push(
      "",
      `I've reviewed this plan and have ${annotations.length + (generalFeedback ? 1 : 0)} piece${annotations.length + (generalFeedback ? 1 : 0) === 1 ? "" : "s"} of feedback:`,
    );
  }

  annotations.forEach((annotation, index) => {
    sections.push("", annotationHeading("plan", annotation, index + 1));
    if (annotation.quote.trim()) {
      sections.push("```", annotation.quote.trim(), "```");
    }
    sections.push(toBlockquote(annotation.comment));
  });

  if (generalFeedback) {
    sections.push(
      "",
      `## ${annotations.length + 1}. General feedback about the plan`,
      toBlockquote(generalFeedback),
    );
  }

  sections.push("", "---");
  return sections.join("\n");
}

export function exportMessageFeedback(result: ReviewSessionResult): string {
  const sections: string[] = ["# Message Feedback"];
  const annotations = result.annotations;
  const generalFeedback = normalizeFreeformFeedback(result.feedback);

  if (annotations.length === 0 && !generalFeedback) {
    sections.push("", "No changes requested.");
    return sections.join("\n");
  }

  if (annotations.length > 0) {
    sections.push(
      "",
      `I've reviewed this message and have ${annotations.length + (generalFeedback ? 1 : 0)} piece${annotations.length + (generalFeedback ? 1 : 0) === 1 ? "" : "s"} of feedback:`,
    );
  }

  annotations.forEach((annotation, index) => {
    sections.push("", annotationHeading("message", annotation, index + 1));
    if (annotation.quote.trim()) {
      sections.push("```", annotation.quote.trim(), "```");
    }
    sections.push(toBlockquote(annotation.comment));
  });

  if (generalFeedback) {
    sections.push(
      "",
      `## ${annotations.length + 1}. General feedback about the message`,
      toBlockquote(generalFeedback),
    );
  }

  sections.push("", "---");
  return sections.join("\n");
}

function sortDiffAnnotations(a: ReviewSessionAnnotation, b: ReviewSessionAnnotation): number {
  const pathCompare = (a.filePath ?? "").localeCompare(b.filePath ?? "");
  if (pathCompare !== 0) return pathCompare;
  return (
    (a.startLine ?? a.line ?? Number.MAX_SAFE_INTEGER) -
    (b.startLine ?? b.line ?? Number.MAX_SAFE_INTEGER)
  );
}

export function exportDiffFeedback(result: ReviewSessionResult): string {
  if (result.approved && result.annotations.length === 0 && !result.feedback.trim()) {
    return "# Code Review\n\nCode review completed - no changes requested.";
  }

  const sections: string[] = ["# Code Review Feedback"];
  const sorted = [...result.annotations].sort(sortDiffAnnotations);
  const grouped = new Map<string, ReviewSessionAnnotation[]>();

  for (const annotation of sorted) {
    const key = annotation.filePath?.trim() || "__general__";
    const existing = grouped.get(key);
    if (existing) existing.push(annotation);
    else grouped.set(key, [annotation]);
  }

  for (const [filePath, annotations] of grouped) {
    sections.push("", filePath === "__general__" ? "## General" : `## ${filePath}`);
    for (const annotation of annotations) {
      sections.push("", annotationHeading("diff", annotation, 0), annotation.comment.trim());
    }
  }

  const generalFeedback = normalizeFreeformFeedback(result.feedback);
  if (generalFeedback) {
    sections.push("", "## General", "### Overall", generalFeedback);
  }

  return sections.join("\n");
}

export function formatPlanFeedbackForAgent(
  session: Pick<ReviewSession, "title">,
  result: ReviewSessionResult,
): string {
  const exported = exportPlanFeedback(result);
  if (result.approved) {
    if (!result.feedback.trim() && result.annotations.length === 0) {
      return "Plan approved!";
    }

    return [
      "Plan approved with notes!",
      "",
      "## Implementation Notes",
      "",
      exported,
      "",
      "Proceed with implementation, incorporating these notes where applicable.",
    ].join("\n");
  }

  const titleRule = session.title.trim()
    ? "- Do NOT change the plan title (first # heading) unless the user explicitly asks you to."
    : "";

  return [
    "YOUR PLAN WAS NOT APPROVED.",
    "",
    "You MUST revise the plan to address ALL of the feedback below before calling submit_plan again.",
    "",
    "Rules:",
    "- Do not resubmit the same plan unchanged.",
    titleRule,
    "",
    exported,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatMessageFeedbackForAgent(result: ReviewSessionResult): string {
  const exported = exportMessageFeedback(result);
  return [exported, "", "Please address the annotation feedback above."].join("\n");
}

export function formatDiffFeedbackForAgent(result: ReviewSessionResult): string {
  const exported = exportDiffFeedback(result);
  if (result.approved && result.annotations.length === 0 && !result.feedback.trim()) {
    return exported;
  }
  return [exported, "", "Please address this feedback."].join("\n");
}

export function exportReviewFeedback(result: ReviewSessionResult): string {
  if (result.mode === "plan") return exportPlanFeedback(result);
  if (result.mode === "message") return exportMessageFeedback(result);
  return exportDiffFeedback(result);
}

export function formatReviewFeedbackForAgent(
  session: Pick<ReviewSession, "mode" | "title">,
  result: ReviewSessionResult,
): string {
  if (session.mode === "plan") return formatPlanFeedbackForAgent(session, result);
  if (session.mode === "message") return formatMessageFeedbackForAgent(result);
  return formatDiffFeedbackForAgent(result);
}
