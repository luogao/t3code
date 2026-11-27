import {
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ThreadId,
  type AutoReviewThreadState,
  type FridayDecideThreadInput,
  type FridayGraphEdge,
  type FridayGraphNode,
  type FridayGraphNodeStatus,
  type FridayNodePosition,
  type FridayPendingDecision,
  type FridayProjectSummary,
  type FridayRolloverInput,
  type FridaySendPromptInput,
  type FridaySnapshot,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type ProjectId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as AutoReviewService from "../autoReview/AutoReviewService.ts";
import * as AutoReviewStore from "../autoReview/AutoReviewStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import {
  FRIDAY_CORE_THREAD_TITLE,
  buildFridayInitialPrompt,
  buildFridayRolloverPrompt,
} from "./FridayPrompt.ts";
import * as FridayStore from "./FridayStore.ts";

const ACTIVE_RUN_STATUSES = new Set<string>([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

const GRAPH_RELEVANT_EVENT_TYPES = new Set<string>([
  "thread.created",
  "thread.updated",
  "thread.deleted",
  "thread.archived",
  "thread.unarchived",
  "thread.model-selection-updated",
  "run.created",
  "run.updated",
  "subagent.updated",
  "runtime-request.updated",
  "message.updated",
]);

const STREAMING_MESSAGE_PUBLISH_MIN_INTERVAL_MS = 350;

const MAX_GRAPH_NODES = 48;
const MAX_GRAPH_DEPTH = 3;

export class FridayActionError extends Schema.TaggedError<FridayActionError>()(
  "FridayActionError",
  {
    reason: Schema.Literals([
      "no_project",
      "no_provider",
      "core_missing",
      "thread_not_found",
      "invalid_request",
      "dispatch_failed",
    ]),
    detail: Schema.String,
  },
) {}

export class FridayService extends Context.Service<
  FridayService,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly getSnapshot: Effect.Effect<FridaySnapshot>;
    readonly streamSnapshot: Stream.Stream<FridaySnapshot>;
    readonly sendPrompt: (
      input: FridaySendPromptInput,
    ) => Effect.Effect<FridaySnapshot, FridayActionError>;
    readonly rollover: (
      input: FridayRolloverInput,
    ) => Effect.Effect<FridaySnapshot, FridayActionError>;
    readonly updateMemory: (markdown: string) => Effect.Effect<FridaySnapshot>;
    readonly updateLayout: (
      positions: Readonly<Record<string, FridayNodePosition | null>>,
    ) => Effect.Effect<FridaySnapshot>;
    readonly updateCoreModel: (
      modelSelection: ModelSelection,
    ) => Effect.Effect<FridaySnapshot, FridayActionError>;
    readonly decideThread: (
      threadId: ThreadId,
      input: FridayDecideThreadInput,
    ) => Effect.Effect<FridaySnapshot, FridayActionError>;
  }
>()("t3/friday/FridayService") {}

const nowIso: Effect.Effect<IsoDateTime> = DateTime.now.pipe(
  Effect.map((now) => IsoDateTime.make(DateTime.formatIso(now))),
);

function pickDefaultModelSelection(
  preferred: ModelSelection | null,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  if (preferred !== null) return preferred;
  const ready = providers.filter(
    (provider) => provider.enabled && provider.installed && provider.status === "ready",
  );
  const candidates = ready.length > 0 ? ready : providers.filter((provider) => provider.enabled);
  for (const provider of candidates) {
    const model =
      provider.models.find((item) => item.isDefault && !item.isLegacy) ??
      provider.models.find((item) => !item.isLegacy) ??
      provider.models[0];
    if (model !== undefined) {
      return {
        instanceId: provider.instanceId,
        model: model.slug,
      };
    }
  }
  return null;
}

function trimPreview(text: string | null | undefined, maxChars = 96): string | null {
  if (text === null || text === undefined) return null;
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars - 1)}...`;
}

function stripFridayPromptWrapper(text: string): string {
  return text
    .replace(/<friday_context\b[^>]*>[\s\S]*?<\/friday_context>\s*/gi, "")
    .replace(/<friday_shift_handoff\b[^>]*>[\s\S]*?<\/friday_shift_handoff>\s*/gi, "")
    .trim();
}

function latestMessageText(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  maxChars = 220,
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate === undefined) continue;
    const cleaned = stripFridayPromptWrapper(candidate.text);
    const preview = trimPreview(cleaned, maxChars);
    if (preview !== null) return preview;
  }
  return null;
}

function estimateContextUsagePercent(
  runs: ReadonlyArray<OrchestrationV2Run>,
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
): number {
  let boundaryRunIndex = 0;
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    if (runs[index]?.freshContext === true) {
      boundaryRunIndex = index;
      break;
    }
  }
  const shiftRuns = runs.slice(boundaryRunIndex);
  const shiftRunIds = new Set(shiftRuns.map((run) => run.id));
  let totalChars = 0;
  for (const message of messages) {
    if (message.runId === null || shiftRunIds.has(message.runId)) {
      totalChars += message.text.length;
    }
  }
  const score = Math.round((totalChars / 90_000) * 100 + shiftRuns.length * 4);
  return Math.max(4, Math.min(98, score));
}

function derivePendingDecision(input: {
  readonly runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  readonly autoReview: AutoReviewThreadState | undefined;
  readonly latestPreview: string | null;
}): FridayPendingDecision | null {
  const pending = input.runtimeRequests.find((request) => request.status === "pending");
  if (pending !== undefined) {
    if (pending.kind === "user_input") {
      return {
        kind: "user_input",
        requestId: pending.id,
        kicker: "Waiting for answer",
        question: input.latestPreview ?? "Agent asked a question and is waiting for your input.",
        options: [],
      };
    }
    return {
      kind: "approval",
      requestId: pending.id,
      kicker: `Approval required · ${pending.kind}`,
      question:
        input.latestPreview ??
        `Approve ${pending.kind} request so this agent can continue executing?`,
      options: [
        {
          id: "accept",
          label: "Approve",
          action: "approval_accept",
          payload: "accept",
        },
        {
          id: "decline",
          label: "Decline",
          action: "approval_decline",
          payload: "decline",
        },
      ],
    };
  }

  if (input.autoReview?.status === "needs_human" || input.autoReview?.status === "failed") {
    const kicker =
      input.autoReview.status === "failed"
        ? "Auto-Review failed"
        : `Auto-Review ${String(input.autoReview.reworkCount)}/${String(input.autoReview.maxReworkRounds)}`;
    return {
      kind: "auto_review",
      requestId: null,
      kicker,
      question:
        trimPreview(input.autoReview.humanQuestion ?? input.autoReview.summary, 110) ??
        "Independent reviewer escalated this task for your decision.",
      options: [
        {
          id: "ack",
          label: "Acknowledge",
          action: "acknowledge",
          payload: "",
        },
      ],
    };
  }

  return null;
}

function deriveWorkerStatus(input: {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly pendingDecision: FridayPendingDecision | null;
  readonly autoReview: AutoReviewThreadState | undefined;
}): FridayGraphNodeStatus {
  if (input.pendingDecision !== null) return "needs_human";
  if (input.autoReview?.status === "reviewing" || input.autoReview?.status === "reworking") {
    return "reviewing";
  }
  const latestRun = input.runs[input.runs.length - 1];
  if (input.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status))) {
    return "running";
  }
  if (latestRun?.status === "failed") {
    return "failed";
  }
  return "completed";
}

function formatWorkerStatusDetail(input: {
  readonly projectTitle: string;
  readonly providerInstanceId: string;
  readonly status: FridayGraphNodeStatus;
  readonly autoReview: AutoReviewThreadState | undefined;
}): string {
  if (input.status === "reviewing") {
    return `${input.projectTitle} · ${input.providerInstanceId} · reviewing`;
  }
  if (input.status === "needs_human") {
    return `${input.projectTitle} · ${input.providerInstanceId} · needs input`;
  }
  if (input.status === "running") {
    return `${input.projectTitle} · ${input.providerInstanceId} · running`;
  }
  if (input.status === "failed") {
    return `${input.projectTitle} · ${input.providerInstanceId} · failed`;
  }
  if (input.autoReview?.status === "approved") {
    return `${input.projectTitle} · reviewed`;
  }
  return `${input.projectTitle} · ${input.providerInstanceId}`;
}

const make = Effect.gen(function* () {
  const store = yield* FridayStore.FridayStore;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const launcher = yield* ThreadLaunchService.ThreadLaunchService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const autoReviewStore = yield* AutoReviewStore.AutoReviewStore;
  const autoReviewService = yield* AutoReviewService.AutoReviewService;

  const coreLock = yield* Semaphore.make(1);
  const pubsub = yield* PubSub.unbounded<FridaySnapshot>();

  const buildSnapshot: Effect.Effect<FridaySnapshot> = Effect.gen(function* () {
    const persisted = yield* store.getState;
    const rawProjects = yield* projectStore.list().pipe(Effect.orElseSucceed(() => []));
    const activeProjects: FridayProjectSummary[] = rawProjects
      .filter((project) => project.deletedAt === null && project.archivedAt === null)
      .map((project) => ({
        id: project.projectId,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
      }));
    const projectTitleById = new Map<ProjectId, string>(
      rawProjects.map((project) => [project.projectId, project.title]),
    );
    const autoReviewSnapshot = yield* autoReviewStore.getSnapshot;
    const now = yield* nowIso;

    const nodes: FridayGraphNode[] = [];
    const edges: FridayGraphEdge[] = [];
    let coreThreadId = persisted.config.coreThreadId;
    let coreContextUsagePercent: number | null = null;

    if (coreThreadId !== null) {
      const coreOpt = yield* projections
        .getThreadRecords(coreThreadId, ["runs", "runtimeRequests", "messages"])
        .pipe(Effect.option);
      if (Option.isNone(coreOpt) || coreOpt.value.thread.deletedAt !== null) {
        coreThreadId = null;
      } else {
        const coreRec = coreOpt.value;
        coreContextUsagePercent = estimateContextUsagePercent(coreRec.runs, coreRec.messages);
        const coreProjectTitle =
          projectTitleById.get(coreRec.thread.projectId) ?? coreRec.thread.projectId;
        const corePreview = latestMessageText(coreRec.messages, 220);
        const coreDecision = derivePendingDecision({
          runtimeRequests: coreRec.runtimeRequests,
          autoReview: undefined,
          latestPreview: corePreview,
        });
        const coreIsRunning = coreRec.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status));
        const coreLatestRun = coreRec.runs[coreRec.runs.length - 1];
        const coreStatus: FridayGraphNodeStatus =
          coreDecision !== null
            ? "needs_human"
            : coreIsRunning
              ? "running"
              : coreLatestRun?.status === "failed"
                ? "failed"
                : "core";
        const coreStatusDetail =
          coreStatus === "running"
            ? `Shift ${String(persisted.config.shiftNumber)} · Thinking...`
            : coreStatus === "failed"
              ? `Shift ${String(persisted.config.shiftNumber)} · Run failed`
              : `Shift ${String(persisted.config.shiftNumber)} · ${coreRec.thread.modelSelection.model}`;
        nodes.push({
          id: coreRec.thread.id,
          threadId: coreRec.thread.id,
          kind: "core",
          parentId: null,
          projectId: coreRec.thread.projectId,
          projectTitle: coreProjectTitle,
          title: coreRec.thread.title,
          branch: coreRec.thread.branch,
          providerInstanceId: coreRec.thread.modelSelection.instanceId,
          model: coreRec.thread.modelSelection.model,
          status: coreStatus,
          statusDetail: coreStatusDetail,
          updatedAt: IsoDateTime.make(DateTime.formatIso(coreRec.thread.updatedAt)),
          position: persisted.config.nodePositions[coreRec.thread.id] ?? null,
          pendingDecision: coreDecision,
          autoReviewStatus: null,
          autoReviewSummary: null,
          latestMessagePreview: corePreview,
        });

        const visited = new Set<string>([coreRec.thread.id]);
        const queue: Array<{
          readonly threadId: ThreadId;
          readonly parentId: string;
          readonly depth: number;
        }> = [];

        const rootChildren = yield* projections
          .listAppOwnedChildThreadIds(coreRec.thread.id)
          .pipe(Effect.orElseSucceed(() => []));
        for (const childId of rootChildren) {
          queue.push({ threadId: childId, parentId: coreRec.thread.id, depth: 1 });
        }
        for (const pinnedId of persisted.config.pinnedThreadIds) {
          if (!visited.has(pinnedId)) {
            queue.push({ threadId: pinnedId, parentId: coreRec.thread.id, depth: 1 });
          }
        }

        while (queue.length > 0 && nodes.length < MAX_GRAPH_NODES) {
          const next = queue.shift();
          if (next === undefined || visited.has(next.threadId)) continue;
          visited.add(next.threadId);

          const recOpt = yield* projections
            .getThreadRecords(next.threadId, ["runs", "runtimeRequests", "messages"])
            .pipe(Effect.option);
          if (Option.isNone(recOpt)) continue;
          const rec = recOpt.value;
          if (rec.thread.deletedAt !== null) continue;

          const autoReview = autoReviewSnapshot.threads[rec.thread.id];
          const preview = latestMessageText(rec.messages);
          const pendingDecision = derivePendingDecision({
            runtimeRequests: rec.runtimeRequests,
            autoReview,
            latestPreview: preview,
          });
          const status = deriveWorkerStatus({
            runs: rec.runs,
            pendingDecision,
            autoReview,
          });
          if (rec.thread.archivedAt !== null && status !== "needs_human" && status !== "running") {
            continue;
          }

          const projectTitle = projectTitleById.get(rec.thread.projectId) ?? rec.thread.projectId;
          nodes.push({
            id: rec.thread.id,
            threadId: rec.thread.id,
            kind: "worker",
            parentId: next.parentId,
            projectId: rec.thread.projectId,
            projectTitle,
            title: rec.thread.title,
            branch: rec.thread.branch,
            providerInstanceId: rec.thread.modelSelection.instanceId,
            model: rec.thread.modelSelection.model,
            status,
            statusDetail: formatWorkerStatusDetail({
              projectTitle,
              providerInstanceId: rec.thread.modelSelection.instanceId,
              status,
              autoReview,
            }),
            updatedAt: IsoDateTime.make(DateTime.formatIso(rec.thread.updatedAt)),
            position: persisted.config.nodePositions[rec.thread.id] ?? null,
            pendingDecision,
            autoReviewStatus: autoReview?.status ?? null,
            autoReviewSummary: autoReview?.summary ?? null,
            latestMessagePreview: preview,
          });
          edges.push({
            id: `edge:${next.parentId}->${rec.thread.id}`,
            sourceId: next.parentId,
            targetId: rec.thread.id,
            kind: "delegation",
          });

          if (autoReview?.reviewerThreadId !== null && autoReview?.reviewerThreadId !== undefined) {
            const reviewerThreadId = autoReview.reviewerThreadId;
            const reviewerOpt = yield* projections
              .getThreadRecords(reviewerThreadId, ["runs"])
              .pipe(Effect.option);
            if (Option.isSome(reviewerOpt) && reviewerOpt.value.thread.deletedAt === null) {
              const reviewer = reviewerOpt.value.thread;
              const reviewerNodeId = `reviewer:${rec.thread.id}`;
              const reviewerStatus: FridayGraphNodeStatus =
                autoReview.status === "needs_human" || autoReview.status === "failed"
                  ? "needs_human"
                  : autoReview.status === "approved"
                    ? "completed"
                    : "reviewing";
              nodes.push({
                id: reviewerNodeId,
                threadId: reviewerThreadId,
                kind: "reviewer",
                parentId: rec.thread.id,
                projectId: reviewer.projectId,
                projectTitle,
                title: `${reviewer.modelSelection.instanceId} QA`,
                branch: reviewer.branch,
                providerInstanceId: reviewer.modelSelection.instanceId,
                model: reviewer.modelSelection.model,
                status: reviewerStatus,
                statusDetail: `${String(autoReview.reworkCount)}/${String(autoReview.maxReworkRounds)} · ${autoReview.status}`,
                updatedAt: autoReview.updatedAt,
                position: persisted.config.nodePositions[reviewerNodeId] ?? null,
                pendingDecision: null,
                autoReviewStatus: autoReview.status,
                autoReviewSummary: autoReview.summary,
                latestMessagePreview: autoReview.summary,
              });
              edges.push({
                id: `edge:${rec.thread.id}->${reviewerNodeId}`,
                sourceId: rec.thread.id,
                targetId: reviewerNodeId,
                kind: "review",
              });
            }
          }

          if (next.depth < MAX_GRAPH_DEPTH) {
            const grandChildren = yield* projections
              .listAppOwnedChildThreadIds(rec.thread.id)
              .pipe(Effect.orElseSucceed(() => []));
            for (const grandChildId of grandChildren) {
              if (!visited.has(grandChildId)) {
                queue.push({
                  threadId: grandChildId,
                  parentId: rec.thread.id,
                  depth: next.depth + 1,
                });
              }
            }
          }
        }
      }
    }

    return {
      config: persisted.config,
      memoryMarkdown: persisted.memoryMarkdown,
      coreThreadId,
      coreContextUsagePercent,
      nodes,
      edges,
      projects: activeProjects,
      updatedAt: now,
    };
  });

  const publishSnapshot: Effect.Effect<FridaySnapshot> = buildSnapshot.pipe(
    Effect.tap((snapshot) => PubSub.publish(pubsub, snapshot)),
  );

  const ensureCoreThread = Effect.fn("FridayService.ensureCoreThread")(function* (input: {
    readonly projectId?: ProjectId | undefined;
    readonly modelSelection?: ModelSelection | undefined;
    readonly initialPromptText: string;
  }) {
    const persisted = yield* store.getState;
    const existingCoreId = persisted.config.coreThreadId;
    if (existingCoreId !== null) {
      const existing = yield* projections.getThreadRecords(existingCoreId, []).pipe(Effect.option);
      if (Option.isSome(existing) && existing.value.thread.deletedAt === null) {
        return { threadId: existingCoreId, created: false as const };
      }
    }

    const projects = yield* projectStore.list().pipe(Effect.orElseSucceed(() => []));
    const activeProjects = projects.filter(
      (project) => project.deletedAt === null && project.archivedAt === null,
    );
    const targetProject =
      (input.projectId !== undefined
        ? activeProjects.find((project) => project.projectId === input.projectId)
        : undefined) ??
      (persisted.config.defaultProjectId !== null
        ? activeProjects.find((project) => project.projectId === persisted.config.defaultProjectId)
        : undefined) ??
      activeProjects[0];

    if (targetProject === undefined) {
      return yield* new FridayActionError({
        reason: "no_project",
        detail: "Add at least one project in T3 Code before starting Friday.",
      });
    }

    const providers = yield* providerRegistry.getProviders;
    const modelSelection =
      input.modelSelection ?? pickDefaultModelSelection(persisted.config.preferredModel, providers);
    if (modelSelection === null) {
      return yield* new FridayActionError({
        reason: "no_provider",
        detail: "No enabled provider model is available to launch Friday.",
      });
    }

    const coreThreadId = ThreadId.make(`thread:friday-core:${yield* randomUuidV4}`);
    const launchNonce = yield* randomUuidV4;
    const initialPrompt = buildFridayInitialPrompt({
      userText: input.initialPromptText,
      memoryMarkdown: persisted.memoryMarkdown,
      projects: activeProjects.map((project) => ({
        id: project.projectId,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
      })),
      shiftNumber: persisted.config.shiftNumber,
    });

    const launchResult = yield* launcher
      .launch({
        commandId: CommandId.make(`server:friday-launch:${launchNonce}`),
        threadId: coreThreadId,
        projectId: targetProject.projectId,
        title: FRIDAY_CORE_THREAD_TITLE,
        generateTitle: false,
        titleRenamed: true,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make(`message:friday-init:${launchNonce}`),
          text: initialPrompt,
          attachments: [],
        },
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(Effect.result);

    if (launchResult._tag === "Failure") {
      return yield* new FridayActionError({
        reason: "dispatch_failed",
        detail: `Failed to start Friday hub thread: ${String(launchResult.failure.message)}`,
      });
    }

    yield* store.mutateConfig((current) => ({
      ...current,
      coreThreadId,
      defaultProjectId: targetProject.projectId,
      preferredModel: modelSelection,
    }));

    return { threadId: coreThreadId, created: true as const };
  });

  const sendPrompt: FridayService["Service"]["sendPrompt"] = Effect.fn("FridayService.sendPrompt")(
    function* (input) {
      const trimmed = input.text.trim();
      if (trimmed.length === 0) {
        return yield* new FridayActionError({
          reason: "invalid_request",
          detail: "Prompt text cannot be empty.",
        });
      }
      return yield* coreLock.withPermit(
        Effect.gen(function* () {
          const core = yield* ensureCoreThread({
            projectId: input.projectId,
            modelSelection: input.modelSelection,
            initialPromptText: trimmed,
          });
          if (!core.created) {
            const nonce = yield* randomUuidV4;
            const dispatchResult = yield* engine
              .dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`server:friday-prompt:${nonce}`),
                threadId: core.threadId,
                messageId: MessageId.make(`message:friday-prompt:${nonce}`),
                text: trimmed,
                attachments: [],
                ...(input.modelSelection === undefined
                  ? {}
                  : { modelSelection: input.modelSelection }),
                dispatchMode: { type: "queue_after_active" },
                createdBy: "user",
                creationSource: "server",
              })
              .pipe(Effect.result);
            if (dispatchResult._tag === "Failure") {
              return yield* new FridayActionError({
                reason: "dispatch_failed",
                detail: `Failed to send prompt to Friday: ${String(dispatchResult.failure)}`,
              });
            }
          }
          return yield* publishSnapshot;
        }),
      );
    },
  );

  const rollover: FridayService["Service"]["rollover"] = Effect.fn("FridayService.rollover")(
    function* (input) {
      return yield* coreLock.withPermit(
        Effect.gen(function* () {
          const snapshotBefore = yield* buildSnapshot;
          const coreThreadId = snapshotBefore.coreThreadId;
          if (coreThreadId === null) {
            return yield* new FridayActionError({
              reason: "core_missing",
              detail: "Send a first prompt to initialize Friday before rolling over context.",
            });
          }

          const nextShift = NonNegativeInt.make(snapshotBefore.config.shiftNumber + 1);
          const handoffText = buildFridayRolloverPrompt({
            shiftNumber: nextShift,
            memoryMarkdown: snapshotBefore.memoryMarkdown,
            projects: snapshotBefore.projects,
            nodes: snapshotBefore.nodes,
            note: input.note,
          });
          const nonce = yield* randomUuidV4;
          const dispatchResult = yield* engine
            .dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`server:friday-rollover:${String(nextShift)}:${nonce}`),
              threadId: coreThreadId,
              messageId: MessageId.make(`message:friday-rollover:${String(nextShift)}:${nonce}`),
              text: handoffText,
              attachments: [],
              freshContext: true,
              ...(input.modelSelection === undefined
                ? {}
                : { modelSelection: input.modelSelection }),
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "server",
            })
            .pipe(Effect.result);

          if (dispatchResult._tag === "Failure") {
            return yield* new FridayActionError({
              reason: "dispatch_failed",
              detail: `Failed to roll over Friday context: ${String(dispatchResult.failure)}`,
            });
          }

          const now = yield* nowIso;
          yield* store.mutateConfig((current) => ({
            ...current,
            shiftNumber: nextShift,
            lastRolloverAt: now,
            ...(input.modelSelection === undefined ? {} : { preferredModel: input.modelSelection }),
          }));

          return yield* publishSnapshot;
        }),
      );
    },
  );

  const updateMemory: FridayService["Service"]["updateMemory"] = Effect.fn(
    "FridayService.updateMemory",
  )(function* (markdown) {
    yield* store.updateMemory(markdown);
    return yield* publishSnapshot;
  });

  const updateLayout: FridayService["Service"]["updateLayout"] = Effect.fn(
    "FridayService.updateLayout",
  )(function* (positions) {
    yield* store.updateLayout(positions);
    return yield* publishSnapshot;
  });

  const updateCoreModel: FridayService["Service"]["updateCoreModel"] = Effect.fn(
    "FridayService.updateCoreModel",
  )(function* (modelSelection) {
    return yield* coreLock.withPermit(
      Effect.gen(function* () {
        const persisted = yield* store.mutateConfig((current) => ({
          ...current,
          preferredModel: modelSelection,
        }));
        const coreThreadId = persisted.config.coreThreadId;
        if (coreThreadId !== null) {
          const coreOpt = yield* projections.getThreadRecords(coreThreadId, []).pipe(Effect.option);
          if (Option.isSome(coreOpt) && coreOpt.value.thread.deletedAt === null) {
            const nonce = yield* randomUuidV4;
            const switchResult = yield* engine
              .dispatch({
                type: "provider.switch",
                commandId: CommandId.make(`server:friday-model:${nonce}`),
                threadId: coreThreadId,
                modelSelection,
              })
              .pipe(Effect.result);
            if (switchResult._tag === "Failure") {
              yield* Effect.logWarning("friday.update-core-model-switch-failed", {
                coreThreadId,
                error: switchResult.failure,
              });
            }
          }
        }
        return yield* publishSnapshot;
      }),
    );
  });

  const decideThread: FridayService["Service"]["decideThread"] = Effect.fn(
    "FridayService.decideThread",
  )(function* (threadId, input) {
    const recOpt = yield* projections.getThreadRecords(threadId, []).pipe(Effect.option);
    if (Option.isNone(recOpt) || recOpt.value.thread.deletedAt !== null) {
      return yield* new FridayActionError({
        reason: "thread_not_found",
        detail: `Thread ${threadId} not found.`,
      });
    }

    const nonce = yield* randomUuidV4;
    if (input.action === "approval_accept" || input.action === "approval_decline") {
      if (input.requestId === undefined) {
        return yield* new FridayActionError({
          reason: "invalid_request",
          detail: "requestId is required for approval responses.",
        });
      }
      const responseResult = yield* engine
        .dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make(`server:friday-approval:${nonce}`),
          threadId,
          requestId: input.requestId,
          decision: input.action === "approval_accept" ? "accept" : "decline",
        })
        .pipe(Effect.result);
      if (responseResult._tag === "Failure") {
        return yield* new FridayActionError({
          reason: "dispatch_failed",
          detail: `Failed to respond to approval request: ${String(responseResult.failure)}`,
        });
      }
      return yield* publishSnapshot;
    }

    if (input.action === "acknowledge") {
      yield* autoReviewService.acknowledgeThread(threadId);
      return yield* publishSnapshot;
    }

    const messageText = input.payload?.trim() ?? "";
    if (messageText.length === 0) {
      return yield* new FridayActionError({
        reason: "invalid_request",
        detail: "Message payload cannot be empty.",
      });
    }
    const dispatchResult = yield* engine
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:friday-decide-msg:${nonce}`),
        threadId,
        messageId: MessageId.make(`message:friday-decide:${nonce}`),
        text: messageText,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(Effect.result);
    if (dispatchResult._tag === "Failure") {
      return yield* new FridayActionError({
        reason: "dispatch_failed",
        detail: `Failed to send decision message: ${String(dispatchResult.failure)}`,
      });
    }
    return yield* publishSnapshot;
  });

  let lastStreamingPublishMs = 0;

  const handleDomainEvent = Effect.fn("FridayService.handleDomainEvent")(function* (
    event: OrchestrationV2DomainEvent,
  ) {
    if (!GRAPH_RELEVANT_EVENT_TYPES.has(event.type)) return;
    if (event.type === "message.updated" && event.payload.streaming) {
      const nowMs = yield* Clock.currentTimeMillis;
      if (nowMs - lastStreamingPublishMs < STREAMING_MESSAGE_PUBLISH_MIN_INTERVAL_MS) {
        return;
      }
      lastStreamingPublishMs = nowMs;
    }
    yield* publishSnapshot.pipe(
      Effect.catchCause((cause) => Effect.logWarning("friday.refresh-failed", { cause })),
    );
  });

  const start: FridayService["Service"]["start"] = Effect.fn("FridayService.start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(engine.streamDomainEvents, (event) => handleDomainEvent(event)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("friday.domain-event-stream-failed", { cause }),
        ),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(autoReviewStore.streamChanges, () =>
        publishSnapshot.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("friday.autoreview-sync-failed", { cause }),
          ),
        ),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("friday.autoreview-stream-failed", { cause }),
        ),
      ),
    );
  });

  const streamSnapshot: Stream.Stream<FridaySnapshot> = Stream.unwrap(
    Effect.gen(function* () {
      const live = Stream.fromPubSub(pubsub);
      const initial = yield* buildSnapshot;
      return Stream.concat(Stream.make(initial), live);
    }),
  );

  return {
    start,
    getSnapshot: buildSnapshot,
    streamSnapshot,
    sendPrompt,
    rollover,
    updateMemory,
    updateLayout,
    updateCoreModel,
    decideThread,
  } satisfies FridayService["Service"];
});

export const layer = Layer.effect(FridayService, make);
