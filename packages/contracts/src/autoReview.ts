import * as Schema from "effect/Schema";

import { RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const AutoReviewStatus = Schema.Literals([
  "reviewing",
  "reworking",
  "approved",
  "needs_human",
  "failed",
]);
export type AutoReviewStatus = typeof AutoReviewStatus.Type;

export const AutoReviewVerdict = Schema.Literals(["approved", "rework", "needs_human"]);
export type AutoReviewVerdict = typeof AutoReviewVerdict.Type;

export const AutoReviewOverride = Schema.Literals(["enabled", "disabled"]);
export type AutoReviewOverride = typeof AutoReviewOverride.Type;

export const AutoReviewDefaultProjectMode = Schema.Literals(["opt_out", "opt_in"]);
export type AutoReviewDefaultProjectMode = typeof AutoReviewDefaultProjectMode.Type;

export const AutoReviewModelTarget = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});
export type AutoReviewModelTarget = typeof AutoReviewModelTarget.Type;

export const AutoReviewConfig = Schema.Struct({
  enabled: Schema.Boolean,
  defaultProjectMode: AutoReviewDefaultProjectMode,
  projectOverrides: Schema.Record(Schema.String, AutoReviewOverride),
  threadOverrides: Schema.Record(Schema.String, AutoReviewOverride),
  reviewerModel: Schema.NullOr(AutoReviewModelTarget),
  maxReworkRounds: Schema.Number,
  maxConcurrency: Schema.Number,
  customInstructions: Schema.String,
});
export type AutoReviewConfig = typeof AutoReviewConfig.Type;

export const AutoReviewConfigPatch = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  defaultProjectMode: Schema.optional(AutoReviewDefaultProjectMode),
  projectOverrides: Schema.optional(
    Schema.Record(Schema.String, Schema.NullOr(AutoReviewOverride)),
  ),
  threadOverrides: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(AutoReviewOverride))),
  reviewerModel: Schema.optional(Schema.NullOr(AutoReviewModelTarget)),
  maxReworkRounds: Schema.optional(Schema.Number),
  maxConcurrency: Schema.optional(Schema.Number),
  customInstructions: Schema.optional(Schema.String),
});
export type AutoReviewConfigPatch = typeof AutoReviewConfigPatch.Type;

export const AutoReviewThreadState = Schema.Struct({
  threadId: ThreadId,
  status: AutoReviewStatus,
  reworkCount: Schema.Number,
  maxReworkRounds: Schema.Number,
  lastReviewedRunId: Schema.NullOr(RunId),
  activeReviewRunId: Schema.NullOr(RunId),
  reviewerThreadId: Schema.NullOr(ThreadId),
  verdict: Schema.NullOr(AutoReviewVerdict),
  summary: Schema.NullOr(Schema.String),
  reworkPrompt: Schema.NullOr(Schema.String),
  humanQuestion: Schema.NullOr(Schema.String),
  reviewedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type AutoReviewThreadState = typeof AutoReviewThreadState.Type;

export const AutoReviewSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  config: AutoReviewConfig,
  threads: Schema.Record(Schema.String, AutoReviewThreadState),
  reviewerThreadIds: Schema.Array(Schema.String),
});
export type AutoReviewSnapshot = typeof AutoReviewSnapshot.Type;

export const DEFAULT_AUTO_REVIEW_CONFIG: AutoReviewConfig = {
  enabled: false,
  defaultProjectMode: "opt_out",
  projectOverrides: {},
  threadOverrides: {},
  reviewerModel: null,
  maxReworkRounds: 2,
  maxConcurrency: 2,
  customInstructions: "",
};

export const DEFAULT_AUTO_REVIEW_SNAPSHOT: AutoReviewSnapshot = {
  version: 1,
  config: DEFAULT_AUTO_REVIEW_CONFIG,
  threads: {},
  reviewerThreadIds: [],
};

export function clampAutoReviewRounds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_AUTO_REVIEW_CONFIG.maxReworkRounds;
  return Math.max(0, Math.min(5, Math.round(value)));
}

export function clampAutoReviewConcurrency(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_AUTO_REVIEW_CONFIG.maxConcurrency;
  return Math.max(1, Math.min(4, Math.round(value)));
}

/** Whether automatic post-run review should trigger for `threadId` in `projectId`. */
export function shouldAutoReviewThread(
  config: AutoReviewConfig,
  target: { readonly threadId: string; readonly projectId: string },
): boolean {
  if (!config.enabled) return false;
  const threadOverride = config.threadOverrides[target.threadId];
  if (threadOverride === "enabled") return true;
  if (threadOverride === "disabled") return false;
  const projectOverride = config.projectOverrides[target.projectId];
  if (projectOverride === "enabled") return true;
  if (projectOverride === "disabled") return false;
  return config.defaultProjectMode === "opt_out";
}
