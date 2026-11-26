import * as Schema from "effect/Schema";

import { AutoReviewStatus } from "./autoReview.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const FridayNodePosition = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
});
export type FridayNodePosition = typeof FridayNodePosition.Type;

export const FridayConfig = Schema.Struct({
  coreThreadId: Schema.NullOr(ThreadId),
  defaultProjectId: Schema.NullOr(ProjectId),
  preferredModel: Schema.NullOr(ModelSelection),
  shiftNumber: NonNegativeInt,
  lastRolloverAt: Schema.NullOr(IsoDateTime),
  nodePositions: Schema.Record(Schema.String, FridayNodePosition),
  pinnedThreadIds: Schema.Array(ThreadId),
});
export type FridayConfig = typeof FridayConfig.Type;

export const DEFAULT_FRIDAY_CONFIG: FridayConfig = {
  coreThreadId: null,
  defaultProjectId: null,
  preferredModel: null,
  shiftNumber: 1,
  lastRolloverAt: null,
  nodePositions: {},
  pinnedThreadIds: [],
};

export const FridayGraphNodeKind = Schema.Literals(["core", "worker", "reviewer"]);

export const FridayGraphNodeStatus = Schema.Literals([
  "core",
  "needs_human",
  "running",
  "reviewing",
  "completed",
  "failed",
]);
export type FridayGraphNodeStatus = typeof FridayGraphNodeStatus.Type;

export const FridayDecisionOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  action: Schema.Literals(["approval_accept", "approval_decline", "acknowledge", "message"]),
  payload: Schema.String,
});
export type FridayDecisionOption = typeof FridayDecisionOption.Type;

export const FridayPendingDecision = Schema.Struct({
  kind: Schema.Literals(["approval", "user_input", "auto_review"]),
  requestId: Schema.NullOr(RuntimeRequestId),
  kicker: Schema.String,
  question: Schema.String,
  options: Schema.Array(FridayDecisionOption),
});
export type FridayPendingDecision = typeof FridayPendingDecision.Type;

export const FridayGraphNode = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  kind: FridayGraphNodeKind,
  parentId: Schema.NullOr(Schema.String),
  projectId: ProjectId,
  projectTitle: Schema.String,
  title: Schema.String,
  branch: Schema.NullOr(Schema.String),
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  status: FridayGraphNodeStatus,
  statusDetail: Schema.String,
  updatedAt: IsoDateTime,
  position: Schema.NullOr(FridayNodePosition),
  pendingDecision: Schema.NullOr(FridayPendingDecision),
  autoReviewStatus: Schema.NullOr(AutoReviewStatus),
  autoReviewSummary: Schema.NullOr(Schema.String),
  latestMessagePreview: Schema.NullOr(Schema.String),
});
export type FridayGraphNode = typeof FridayGraphNode.Type;

export const FridayGraphEdge = Schema.Struct({
  id: Schema.String,
  sourceId: Schema.String,
  targetId: Schema.String,
  kind: Schema.Literals(["delegation", "review"]),
});
export type FridayGraphEdge = typeof FridayGraphEdge.Type;

export const FridayProjectSummary = Schema.Struct({
  id: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
});
export type FridayProjectSummary = typeof FridayProjectSummary.Type;

export const FridaySnapshot = Schema.Struct({
  config: FridayConfig,
  memoryMarkdown: Schema.String,
  coreThreadId: Schema.NullOr(ThreadId),
  coreContextUsagePercent: Schema.NullOr(Schema.Finite),
  nodes: Schema.Array(FridayGraphNode),
  edges: Schema.Array(FridayGraphEdge),
  projects: Schema.Array(FridayProjectSummary),
  updatedAt: IsoDateTime,
});
export type FridaySnapshot = typeof FridaySnapshot.Type;

export const DEFAULT_FRIDAY_SNAPSHOT: FridaySnapshot = {
  config: DEFAULT_FRIDAY_CONFIG,
  memoryMarkdown: "",
  coreThreadId: null,
  coreContextUsagePercent: null,
  nodes: [],
  edges: [],
  projects: [],
  updatedAt: "1970-01-01T00:00:00.000Z" as IsoDateTime,
};

export const FridaySendPromptInput = Schema.Struct({
  text: Schema.String,
  modelSelection: Schema.optional(ModelSelection),
  projectId: Schema.optional(ProjectId),
});
export type FridaySendPromptInput = typeof FridaySendPromptInput.Type;

export const FridayRolloverInput = Schema.Struct({
  note: Schema.optional(Schema.String),
  modelSelection: Schema.optional(ModelSelection),
});
export type FridayRolloverInput = typeof FridayRolloverInput.Type;

export const FridayUpdateMemoryInput = Schema.Struct({
  markdown: Schema.String,
});

export const FridayUpdateLayoutInput = Schema.Struct({
  positions: Schema.Record(Schema.String, Schema.NullOr(FridayNodePosition)),
});

export const FridayUpdateCoreModelInput = Schema.Struct({
  modelSelection: ModelSelection,
});

export const FridayDecideThreadInput = Schema.Struct({
  action: Schema.Literals(["approval_accept", "approval_decline", "acknowledge", "message"]),
  requestId: Schema.optional(RuntimeRequestId),
  payload: Schema.optional(Schema.String),
});
export type FridayDecideThreadInput = typeof FridayDecideThreadInput.Type;
