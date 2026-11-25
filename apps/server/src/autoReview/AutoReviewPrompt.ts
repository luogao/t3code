import type { RunId, ThreadId } from "@t3tools/contracts";
import type * as Schema from "effect/Schema";

export const AUTO_REVIEW_REWORK_MESSAGE_PREFIX = "message:auto-review-rework:";
export const AUTO_REVIEW_TITLE_PREFIX = "[Auto-Review] ";

export interface ParsedAutoReviewVerdict {
  readonly verdict: "approved" | "rework" | "needs_human";
  readonly summary: string;
  readonly reworkPrompt: string | null;
  readonly humanQuestion: string | null;
}

export const AUTO_REVIEW_OUTPUT_SCHEMA: Readonly<Record<string, Schema.Json>> = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary"],
  properties: {
    verdict: {
      type: "string",
      enum: ["approved", "rework", "needs_human"],
      description:
        "approved: complete & verified; rework: clear objective defect that the worker agent can fix autonomously; needs_human: subjective product/design decision, high-risk external action, missing credentials/info, or unresolvable blocker.",
    },
    summary: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description: "1-2 concise sentences summarizing the review outcome (same language as user).",
    },
    reworkPrompt: {
      type: "string",
      maxLength: 4000,
      description:
        "Concrete, actionable rework instructions to send back to the worker thread when verdict is 'rework'.",
    },
    humanQuestion: {
      type: "string",
      maxLength: 1000,
      description:
        "Concise summary of the decision, risk, or question for the user when verdict is 'needs_human'.",
    },
  },
};

export function buildAutoReviewPrompt(input: {
  readonly targetThreadId: ThreadId;
  readonly targetThreadTitle: string;
  readonly targetRunId: RunId;
  readonly reworkCount: number;
  readonly maxReworkRounds: number;
  readonly customInstructions: string;
}): string {
  const remainingReworkRounds = Math.max(0, input.maxReworkRounds - input.reworkCount);
  const lines = [
    "You are an independent, strictly READ-ONLY Reviewer Agent evaluating a completed T3 Code thread before it reaches the user.",
    "",
    `Target threadId: ${input.targetThreadId}`,
    `Target thread title: ${input.targetThreadTitle}`,
    `Target runId: ${input.targetRunId}`,
    `Auto-rework rounds already used: ${input.reworkCount}/${input.maxReworkRounds} (${remainingReworkRounds} remaining).`,
    "",
    "## Steps",
    `1. Call \`t3_thread_read({ threadId: "${input.targetThreadId}", view: "messages" })\` to read the user's request and the worker's response. Use \`view: "activity"\` if you need tool outputs, test results, or errors.`,
    "2. If code or files were changed, you may run strictly read-only inspection (e.g., reading files, `git status`, `git diff`) to verify claims match reality.",
    "3. Decide one verdict:",
    '   - `"approved"`: The user request is genuinely satisfied, claims match verified evidence, and no glaring bugs, placeholders, or missing required checks remain.',
    '   - `"rework"`: There is a clear, objective, fixable gap (e.g., failing test/lint/typecheck, missed requirement, placeholder/mock left behind, broken edge case) that the worker can fix autonomously. Provide concrete, concise instructions in `reworkPrompt`.',
    '   - `"needs_human"`: The thread requires a subjective product/architecture decision, user credentials/confirmation, a high-risk external action (merging PR, pushing shared branch, deploying, sending external messages, deleting data), or cannot be resolved autonomously. Summarize clearly in `humanQuestion`.',
    "",
    "## Hard Safety Rules",
    "- Do NOT edit files, commit, push, merge PRs, deploy, or send external messages.",
    "- Do NOT call `t3_thread_send`, `t3_thread_organize`, or `t3_pending_request` on the target thread; the server executes approved follow-ups deterministically from your structured verdict.",
    "- Write `summary`, `reworkPrompt`, and `humanQuestion` in the same language the user used in the target thread.",
    "- If the worker simply answered a pure question or completed a small read-only task accurately, approve it rather than nitpicking.",
  ];
  const trimmedCustom = input.customInstructions.trim();
  if (trimmedCustom.length > 0) {
    lines.push("", "## Additional User Review Guidelines", trimmedCustom);
  }
  lines.push(
    "",
    "Submit your final verdict via `t3_submit_output` matching the declared JSON Schema.",
  );
  return lines.join("\n");
}

export function buildAutoReviewReworkMessage(input: {
  readonly round: number;
  readonly maxReworkRounds: number;
  readonly summary: string;
  readonly reworkPrompt: string;
}): string {
  return [
    `[Auto-Review · Round ${input.round}/${input.maxReworkRounds}]`,
    `Review summary: ${input.summary}`,
    "",
    "Please address the following review findings and verify your changes:",
    input.reworkPrompt,
  ].join("\n");
}

function normalizeOptionalString(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen - 1)}…` : trimmed;
}

function parseVerdictObject(candidate: unknown): ParsedAutoReviewVerdict | null {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const record = candidate as Record<string, unknown>;
  const verdict = record.verdict;
  if (verdict !== "approved" && verdict !== "rework" && verdict !== "needs_human") {
    return null;
  }
  const summary = normalizeOptionalString(record.summary, 500);
  if (summary === null) return null;
  const reworkPrompt = normalizeOptionalString(record.reworkPrompt, 4000);
  const humanQuestion = normalizeOptionalString(record.humanQuestion, 1000);
  return { verdict, summary, reworkPrompt, humanQuestion };
}

function extractJsonFromText(text: string): unknown {
  const fencedMatches = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let index = fencedMatches.length - 1; index >= 0; index -= 1) {
    const snippet = fencedMatches[index]?.[1]?.trim();
    if (!snippet) continue;
    try {
      return JSON.parse(snippet);
    } catch {
      // Try next block.
    }
  }
  const trimmed = text.trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/** Parses validated `run.output.value` first, falling back to JSON in the final assistant reply. */
export function parseAutoReviewVerdict(
  structuredOutput: unknown,
  fallbackAssistantText: string | null,
): ParsedAutoReviewVerdict | null {
  const fromStructured = parseVerdictObject(structuredOutput);
  if (fromStructured !== null) return fromStructured;
  if (fallbackAssistantText === null || fallbackAssistantText.trim().length === 0) {
    return null;
  }
  return parseVerdictObject(extractJsonFromText(fallbackAssistantText));
}
