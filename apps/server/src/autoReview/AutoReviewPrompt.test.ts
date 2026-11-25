import { assert, describe, it } from "@effect/vitest";
import {
  RunId,
  ThreadId,
  shouldAutoReviewThread,
  DEFAULT_AUTO_REVIEW_CONFIG,
} from "@t3tools/contracts";

import {
  AUTO_REVIEW_OUTPUT_SCHEMA,
  buildAutoReviewPrompt,
  buildAutoReviewReworkMessage,
  parseAutoReviewVerdict,
} from "./AutoReviewPrompt.ts";
import { checkOutput } from "../orchestration-v2/runOutput.ts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

describe("AutoReviewPrompt", () => {
  it("resolves trigger scope across global, project, and thread overrides", () => {
    const offConfig = DEFAULT_AUTO_REVIEW_CONFIG;
    assert.isFalse(shouldAutoReviewThread(offConfig, { threadId: "t1", projectId: "p1" }));

    const optOutConfig = {
      ...DEFAULT_AUTO_REVIEW_CONFIG,
      enabled: true,
      defaultProjectMode: "opt_out" as const,
      projectOverrides: { p_excluded: "disabled" as const },
      threadOverrides: { t_force_on: "enabled" as const, t_force_off: "disabled" as const },
    };
    assert.isTrue(shouldAutoReviewThread(optOutConfig, { threadId: "t1", projectId: "p1" }));
    assert.isFalse(
      shouldAutoReviewThread(optOutConfig, { threadId: "t1", projectId: "p_excluded" }),
    );
    assert.isTrue(
      shouldAutoReviewThread(optOutConfig, { threadId: "t_force_on", projectId: "p_excluded" }),
    );
    assert.isFalse(
      shouldAutoReviewThread(optOutConfig, { threadId: "t_force_off", projectId: "p1" }),
    );

    const optInConfig = {
      ...DEFAULT_AUTO_REVIEW_CONFIG,
      enabled: true,
      defaultProjectMode: "opt_in" as const,
      projectOverrides: { p_enabled: "enabled" as const },
    };
    assert.isFalse(shouldAutoReviewThread(optInConfig, { threadId: "t1", projectId: "p1" }));
    assert.isTrue(shouldAutoReviewThread(optInConfig, { threadId: "t1", projectId: "p_enabled" }));
  });

  it.effect("AUTO_REVIEW_OUTPUT_SCHEMA validates cleanly with T3 runOutput.checkOutput", () =>
    Effect.gen(function* () {
      const ok = yield* checkOutput(
        AUTO_REVIEW_OUTPUT_SCHEMA,
        JSON.stringify({
          verdict: "rework",
          summary: "Unit tests were not executed.",
          reworkPrompt: "Run `vp test` and paste the passing summary.",
        }),
      );
      assert.isTrue(Result.isSuccess(ok));

      const bad = yield* checkOutput(
        AUTO_REVIEW_OUTPUT_SCHEMA,
        JSON.stringify({ verdict: "unknown", summary: "bad" }),
      );
      assert.isTrue(Result.isFailure(bad));
    }),
  );

  it("parses structured output and falls back to fenced JSON in assistant text", () => {
    const direct = parseAutoReviewVerdict(
      { verdict: "approved", summary: "All checks verified." },
      null,
    );
    assert.deepEqual(direct, {
      verdict: "approved",
      summary: "All checks verified.",
      reworkPrompt: null,
      humanQuestion: null,
    });

    const fallback = parseAutoReviewVerdict(
      undefined,
      'Review complete:\n```json\n{"verdict":"needs_human","summary":"Needs product choice.","humanQuestion":"Ship A or B?"}\n```',
    );
    assert.deepEqual(fallback, {
      verdict: "needs_human",
      summary: "Needs product choice.",
      reworkPrompt: null,
      humanQuestion: "Ship A or B?",
    });

    assert.isNull(parseAutoReviewVerdict(undefined, "No structured json here"));
  });

  it("builds read-only review prompt and formatted rework prompt", () => {
    const prompt = buildAutoReviewPrompt({
      targetThreadId: ThreadId.make("thread-1"),
      targetThreadTitle: "Fix login bug",
      targetRunId: RunId.make("run-1"),
      reworkCount: 1,
      maxReworkRounds: 2,
      customInstructions: "Ensure typecheck passes.",
    });
    assert.include(prompt, "thread-1");
    assert.include(prompt, "1/2");
    assert.include(prompt, "Ensure typecheck passes.");

    const rework = buildAutoReviewReworkMessage({
      round: 1,
      maxReworkRounds: 2,
      summary: "Missing test.",
      reworkPrompt: "Add regression test for empty email.",
    });
    assert.include(rework, "[Auto-Review · Round 1/2]");
    assert.include(rework, "Add regression test for empty email.");
  });
});
