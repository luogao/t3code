import {
  CommandId,
  MessageId,
  ThreadId,
  shouldAutoReviewThread,
  type AutoReviewConfig,
  type AutoReviewConfigPatch,
  type AutoReviewSnapshot,
  type AutoReviewThreadState,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type RunId,
  type ServerProvider,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import {
  AUTO_REVIEW_OUTPUT_SCHEMA,
  AUTO_REVIEW_REWORK_MESSAGE_PREFIX,
  AUTO_REVIEW_TITLE_PREFIX,
  buildAutoReviewPrompt,
  buildAutoReviewReworkMessage,
  parseAutoReviewVerdict,
} from "./AutoReviewPrompt.ts";
import * as AutoReviewStore from "./AutoReviewStore.ts";

export class AutoReviewTriggerError extends Schema.TaggedError<AutoReviewTriggerError>()(
  "AutoReviewTriggerError",
  {
    reason: Schema.Literals([
      "thread_not_found",
      "thread_ineligible",
      "thread_running",
      "no_completed_run",
      "already_reviewing",
      "launch_failed",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const ACTIVE_RUN_STATUSES = new Set(["queued", "preparing", "starting", "running", "waiting"]);
const REVIEWABLE_RUN_STATUSES = new Set(["completed", "failed"]);

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => DateTime.formatIso(DateTime.makeUnsafe(millis))),
);

function pickDefaultModelForProvider(provider: ServerProvider): string | null {
  const models = provider.models;
  if (models.length === 0) return null;
  const preferred =
    models.find((model) => model.isDefault === true && model.isLegacy !== true) ??
    models.find((model) => model.isLegacy !== true) ??
    models[0];
  return preferred?.slug ?? null;
}

/**
 * Resolves the model selection for the isolated Reviewer thread:
 * 1. Explicit `config.reviewerModel` if its provider instance is enabled & installed.
 * 2. A ready, enabled provider instance DIFFERENT from the worker's instance (cross-model review).
 * 3. Fallback to the worker thread's own `modelSelection`.
 */
export function resolveReviewerModelSelection(input: {
  readonly config: AutoReviewConfig;
  readonly workerModelSelection: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ModelSelection {
  const { config, workerModelSelection, providers } = input;
  if (config.reviewerModel !== null) {
    const configuredProvider = providers.find(
      (provider) =>
        provider.instanceId === config.reviewerModel?.instanceId &&
        provider.enabled &&
        provider.installed,
    );
    if (configuredProvider !== undefined) {
      return {
        instanceId: config.reviewerModel.instanceId,
        model: config.reviewerModel.model,
      };
    }
  }

  const readyCrossProvider = providers.find(
    (provider) =>
      provider.instanceId !== workerModelSelection.instanceId &&
      provider.enabled &&
      provider.installed &&
      provider.status === "ready" &&
      pickDefaultModelForProvider(provider) !== null,
  );
  if (readyCrossProvider !== undefined) {
    const model = pickDefaultModelForProvider(readyCrossProvider);
    if (model !== null) {
      return {
        instanceId: readyCrossProvider.instanceId,
        model: model as ModelSelection["model"],
      };
    }
  }

  return workerModelSelection;
}

function findWorkerByReviewerThreadId(
  snapshot: AutoReviewSnapshot,
  reviewerThreadId: string,
): AutoReviewThreadState | undefined {
  return Object.values(snapshot.threads).find(
    (entry) => entry.reviewerThreadId === reviewerThreadId && entry.status === "reviewing",
  );
}

function countActiveReviews(snapshot: AutoReviewSnapshot): number {
  let count = 0;
  for (const entry of Object.values(snapshot.threads)) {
    if (entry.status === "reviewing") count += 1;
  }
  return count;
}

export class AutoReviewService extends Context.Service<
  AutoReviewService,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly getSnapshot: Effect.Effect<AutoReviewSnapshot>;
    readonly streamSnapshot: Stream.Stream<AutoReviewSnapshot>;
    readonly updateConfig: (patch: AutoReviewConfigPatch) => Effect.Effect<AutoReviewSnapshot>;
    readonly triggerReview: (
      threadId: ThreadId,
    ) => Effect.Effect<AutoReviewSnapshot, AutoReviewTriggerError>;
    readonly acknowledgeThread: (threadId: ThreadId) => Effect.Effect<AutoReviewSnapshot>;
  }
>()("t3/autoReview/AutoReviewService") {}

interface QueuedReviewItem {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly manual: boolean;
}

const make = Effect.gen(function* () {
  const store = yield* AutoReviewStore.AutoReviewStore;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const launcher = yield* ThreadLaunchService.ThreadLaunchService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const threadLocks = yield* KeyedLock.make<string>();
  const pendingQueue = yield* Ref.make<ReadonlyArray<QueuedReviewItem>>([]);

  const markWorkerUnread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const nonce = yield* randomUuidV4;
    yield* engine
      .dispatch({
        type: "thread.mark-unread",
        commandId: CommandId.make(`server:auto-review-unread:${threadId}:${nonce}`),
        threadId,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("auto-review.mark-unread-failed", { threadId, cause }),
        ),
      );
  });

  const archiveReviewerThread = Effect.fnUntraced(function* (reviewerThreadId: ThreadId) {
    const nonce = yield* randomUuidV4;
    yield* engine
      .dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`server:auto-review-archive:${reviewerThreadId}:${nonce}`),
        threadId: reviewerThreadId,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("auto-review.archive-reviewer-failed", { reviewerThreadId, cause }),
        ),
      );
  });

  const launchReviewForRun = Effect.fn("AutoReviewService.launchReviewForRun")(function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly manual: boolean;
  }) {
    const snapshot = yield* store.getSnapshot;
    const projectionOpt = yield* projections
      .getThreadRecords(input.threadId, ["runs"])
      .pipe(Effect.option);
    if (Option.isNone(projectionOpt)) {
      return yield* new AutoReviewTriggerError({
        reason: "thread_not_found",
        detail: `Thread ${input.threadId} not found.`,
      });
    }
    const projection = projectionOpt.value;
    const thread = projection.thread;

    if (
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      thread.lineage.parentThreadId !== null ||
      snapshot.reviewerThreadIds.includes(input.threadId) ||
      thread.title.startsWith(AUTO_REVIEW_TITLE_PREFIX)
    ) {
      return yield* new AutoReviewTriggerError({
        reason: "thread_ineligible",
        detail: "Subagents, archived threads, and reviewer threads cannot be auto-reviewed.",
      });
    }

    if (projection.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status))) {
      return yield* new AutoReviewTriggerError({
        reason: "thread_running",
        detail: "Wait for the active run to finish before starting a review.",
      });
    }

    const existing = snapshot.threads[input.threadId];
    if (existing?.status === "reviewing") {
      return yield* new AutoReviewTriggerError({
        reason: "already_reviewing",
        detail: "An auto-review is already in progress for this thread.",
      });
    }
    if (!input.manual) {
      if (
        !shouldAutoReviewThread(snapshot.config, {
          threadId: thread.id,
          projectId: thread.projectId,
        })
      ) {
        return snapshot;
      }
      if (existing?.lastReviewedRunId === input.runId) {
        return snapshot;
      }
    }

    const activeCount = countActiveReviews(snapshot);
    if (!input.manual && activeCount >= snapshot.config.maxConcurrency) {
      yield* Ref.update(pendingQueue, (queue) =>
        queue.some((item) => item.threadId === input.threadId && item.runId === input.runId)
          ? queue
          : [...queue, input],
      );
      return snapshot;
    }

    const providers = yield* providerRegistry.getProviders;
    const reviewerModelSelection = resolveReviewerModelSelection({
      config: snapshot.config,
      workerModelSelection: thread.modelSelection,
      providers,
    });

    const reviewerThreadId = ThreadId.make(`thread:auto-review:${yield* randomUuidV4}`);
    const now = yield* nowIso;
    const reworkCount = input.manual ? 0 : (existing?.reworkCount ?? 0);
    const maxReworkRounds = snapshot.config.maxReworkRounds;

    // Pre-register reviewerThreadId BEFORE launching so even a fast failure is recognized as a reviewer thread.
    yield* store.mutate((current) => ({
      ...current,
      reviewerThreadIds: current.reviewerThreadIds.includes(reviewerThreadId)
        ? current.reviewerThreadIds
        : [...current.reviewerThreadIds, reviewerThreadId],
      threads: {
        ...current.threads,
        [input.threadId]: {
          threadId: input.threadId,
          status: "reviewing",
          reworkCount,
          maxReworkRounds,
          lastReviewedRunId: existing?.lastReviewedRunId ?? null,
          activeReviewRunId: input.runId,
          reviewerThreadId,
          verdict: existing?.verdict ?? null,
          summary: existing?.summary ?? null,
          reworkPrompt: existing?.reworkPrompt ?? null,
          humanQuestion: existing?.humanQuestion ?? null,
          reviewedAt: existing?.reviewedAt ?? null,
          updatedAt: now,
        },
      },
    }));

    const workspaceStrategy =
      thread.worktreePath !== null
        ? ({
            type: "existing_worktree",
            worktreePath: thread.worktreePath,
            ...(thread.branch === null ? {} : { branch: thread.branch }),
          } as const)
        : ({
            type: "root",
            ...(thread.branch === null ? {} : { branch: thread.branch }),
          } as const);

    const reviewPrompt = buildAutoReviewPrompt({
      targetThreadId: input.threadId,
      targetThreadTitle: thread.title,
      targetRunId: input.runId,
      reworkCount,
      maxReworkRounds,
      customInstructions: snapshot.config.customInstructions,
    });

    const launchCommandNonce = yield* randomUuidV4;
    const launchResult = yield* launcher
      .launch({
        commandId: CommandId.make(
          `server:auto-review-launch:${input.threadId}:${input.runId}:${launchCommandNonce}`,
        ),
        threadId: reviewerThreadId,
        projectId: thread.projectId,
        title: `${AUTO_REVIEW_TITLE_PREFIX}${thread.title}`,
        generateTitle: false,
        titleRenamed: true,
        modelSelection: reviewerModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy,
        initialMessage: {
          messageId: MessageId.make(`message:auto-review-prompt:${reviewerThreadId}`),
          text: reviewPrompt,
          attachments: [],
          outputSchema: AUTO_REVIEW_OUTPUT_SCHEMA,
        },
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(Effect.result);

    if (launchResult._tag === "Failure") {
      const failNow = yield* nowIso;
      yield* Effect.logWarning("auto-review.launch-failed", {
        threadId: input.threadId,
        reviewerThreadId,
        error: launchResult.failure,
      });
      yield* store.mutate((current) => ({
        ...current,
        threads: {
          ...current.threads,
          [input.threadId]: {
            threadId: input.threadId,
            status: "failed",
            reworkCount,
            maxReworkRounds,
            lastReviewedRunId: input.runId,
            activeReviewRunId: null,
            reviewerThreadId,
            verdict: null,
            summary: `Failed to launch reviewer: ${String(launchResult.failure.message)}`,
            reworkPrompt: null,
            humanQuestion: null,
            reviewedAt: failNow,
            updatedAt: failNow,
          },
        },
      }));
      return yield* new AutoReviewTriggerError({
        reason: "launch_failed",
        detail: `Failed to launch reviewer thread: ${String(launchResult.failure.message)}`,
      });
    }

    return yield* store.getSnapshot;
  });

  const drainPendingQueue = Effect.fn("AutoReviewService.drainPendingQueue")(function* () {
    while (true) {
      const snapshot = yield* store.getSnapshot;
      if (countActiveReviews(snapshot) >= snapshot.config.maxConcurrency) return;
      const nextItem = yield* Ref.modify(pendingQueue, (queue) =>
        queue.length === 0 ? ([undefined, queue] as const) : ([queue[0], queue.slice(1)] as const),
      );
      if (nextItem === undefined) return;
      yield* threadLocks.withLock(
        nextItem.threadId,
        launchReviewForRun(nextItem).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("auto-review.queued-launch-failed", {
              threadId: nextItem.threadId,
              runId: nextItem.runId,
              cause,
            }),
          ),
        ),
      );
    }
  });

  const settleReviewerCompletion = Effect.fn("AutoReviewService.settleReviewerCompletion")(
    function* (reviewerThreadId: ThreadId, reviewerRunStatus: string) {
      const snapshot = yield* store.getSnapshot;
      const workerState = findWorkerByReviewerThreadId(snapshot, reviewerThreadId);
      if (workerState === undefined) return;
      const workerThreadId = workerState.threadId;

      yield* threadLocks.withLock(
        workerThreadId,
        Effect.gen(function* () {
          const latestSnapshot = yield* store.getSnapshot;
          const currentWorker = latestSnapshot.threads[workerThreadId];
          if (
            currentWorker === undefined ||
            currentWorker.status !== "reviewing" ||
            currentWorker.reviewerThreadId !== reviewerThreadId
          ) {
            return;
          }

          const reviewerProjectionOpt = yield* projections
            .getThreadRecords(reviewerThreadId, ["runs", "messages"])
            .pipe(Effect.option);

          const latestReviewerRun = Option.match(reviewerProjectionOpt, {
            onNone: () => undefined,
            onSome: (proj) => proj.runs[proj.runs.length - 1],
          });
          const lastAssistantMessage = Option.match(reviewerProjectionOpt, {
            onNone: () => null,
            onSome: (proj) => {
              for (let idx = proj.messages.length - 1; idx >= 0; idx -= 1) {
                const candidate = proj.messages[idx];
                if (candidate?.role === "assistant" && candidate.text.trim().length > 0) {
                  return candidate.text;
                }
              }
              return null;
            },
          });

          const parsed = parseAutoReviewVerdict(
            latestReviewerRun?.output?.value,
            lastAssistantMessage,
          );
          const reviewedRunId = currentWorker.activeReviewRunId ?? currentWorker.lastReviewedRunId;
          const now = yield* nowIso;

          // Always archive the ephemeral reviewer thread after completion so the sidebar stays clean.
          yield* archiveReviewerThread(reviewerThreadId);

          if (parsed === null || reviewerRunStatus !== "completed") {
            const summary =
              parsed?.summary ??
              (reviewerRunStatus !== "completed"
                ? `Reviewer run ended with status "${reviewerRunStatus}".`
                : "Reviewer finished without submitting a structured verdict.");
            yield* store.mutate((current) => ({
              ...current,
              threads: {
                ...current.threads,
                [workerThreadId]: {
                  ...currentWorker,
                  status: "failed",
                  lastReviewedRunId: reviewedRunId,
                  activeReviewRunId: null,
                  verdict: null,
                  summary,
                  reworkPrompt: null,
                  humanQuestion: summary,
                  reviewedAt: now,
                  updatedAt: now,
                },
              },
            }));
            yield* markWorkerUnread(workerThreadId);
            return;
          }

          if (parsed.verdict === "approved") {
            yield* store.mutate((current) => ({
              ...current,
              threads: {
                ...current.threads,
                [workerThreadId]: {
                  ...currentWorker,
                  status: "approved",
                  lastReviewedRunId: reviewedRunId,
                  activeReviewRunId: null,
                  verdict: "approved",
                  summary: parsed.summary,
                  reworkPrompt: null,
                  humanQuestion: null,
                  reviewedAt: now,
                  updatedAt: now,
                },
              },
            }));
            return;
          }

          if (parsed.verdict === "rework") {
            const maxRounds = latestSnapshot.config.maxReworkRounds;
            if (currentWorker.reworkCount < maxRounds && parsed.reworkPrompt !== null) {
              const nextRound = currentWorker.reworkCount + 1;
              const reworkText = buildAutoReviewReworkMessage({
                round: nextRound,
                maxReworkRounds: maxRounds,
                summary: parsed.summary,
                reworkPrompt: parsed.reworkPrompt,
              });
              const reworkKey = reviewedRunId ?? (yield* randomUuidV4);
              const messageId = MessageId.make(
                `${AUTO_REVIEW_REWORK_MESSAGE_PREFIX}${reworkKey}:${String(nextRound)}`,
              );
              const dispatchResult = yield* engine
                .dispatch({
                  type: "message.dispatch",
                  commandId: CommandId.make(
                    `server:auto-review-rework:${workerThreadId}:${reviewedRunId ?? "manual"}:${String(nextRound)}`,
                  ),
                  threadId: workerThreadId,
                  messageId,
                  text: reworkText,
                  attachments: [],
                  dispatchMode: { type: "queue_after_active" },
                  createdBy: "agent",
                  creationSource: "server",
                })
                .pipe(Effect.result);

              if (dispatchResult._tag === "Success") {
                yield* store.mutate((current) => ({
                  ...current,
                  threads: {
                    ...current.threads,
                    [workerThreadId]: {
                      ...currentWorker,
                      status: "reworking",
                      reworkCount: nextRound,
                      maxReworkRounds: maxRounds,
                      lastReviewedRunId: reviewedRunId,
                      activeReviewRunId: null,
                      verdict: "rework",
                      summary: parsed.summary,
                      reworkPrompt: parsed.reworkPrompt,
                      humanQuestion: null,
                      reviewedAt: now,
                      updatedAt: now,
                    },
                  },
                }));
                return;
              }
              yield* Effect.logWarning("auto-review.rework-dispatch-failed", {
                workerThreadId,
                error: dispatchResult.failure,
              });
            }

            // Circuit breaker reached (or reworkPrompt empty / dispatch failed) -> escalate to human!
            const escalatedQuestion =
              parsed.humanQuestion ??
              parsed.reworkPrompt ??
              `Reached max auto-rework rounds (${String(currentWorker.reworkCount)}/${String(maxRounds)}).`;
            yield* store.mutate((current) => ({
              ...current,
              threads: {
                ...current.threads,
                [workerThreadId]: {
                  ...currentWorker,
                  status: "needs_human",
                  maxReworkRounds: maxRounds,
                  lastReviewedRunId: reviewedRunId,
                  activeReviewRunId: null,
                  verdict: "needs_human",
                  summary: parsed.summary,
                  reworkPrompt: parsed.reworkPrompt,
                  humanQuestion: escalatedQuestion,
                  reviewedAt: now,
                  updatedAt: now,
                },
              },
            }));
            yield* markWorkerUnread(workerThreadId);
            return;
          }

          // verdict === "needs_human"
          yield* store.mutate((current) => ({
            ...current,
            threads: {
              ...current.threads,
              [workerThreadId]: {
                ...currentWorker,
                status: "needs_human",
                lastReviewedRunId: reviewedRunId,
                activeReviewRunId: null,
                verdict: "needs_human",
                summary: parsed.summary,
                reworkPrompt: null,
                humanQuestion: parsed.humanQuestion ?? parsed.summary,
                reviewedAt: now,
                updatedAt: now,
              },
            },
          }));
          yield* markWorkerUnread(workerThreadId);
        }),
      );

      yield* drainPendingQueue();
    },
  );

  const handleFreshUserRunCreated = Effect.fn("AutoReviewService.handleFreshUserRunCreated")(
    function* (threadId: ThreadId, userMessageId: MessageId) {
      if (String(userMessageId).startsWith(AUTO_REVIEW_REWORK_MESSAGE_PREFIX)) return;
      if (yield* store.isReviewerThread(threadId)) return;
      const existing = yield* store.getThreadState(threadId);
      if (existing === undefined) return;
      // Only reset when the message was genuinely created by the human user.
      const projectionOpt = yield* projections
        .getThreadRecords(threadId, ["messages"])
        .pipe(Effect.option);
      const msg = Option.match(projectionOpt, {
        onNone: () => undefined,
        onSome: (proj) => proj.messages.find((candidate) => candidate.id === userMessageId),
      });
      if (msg?.createdBy !== "user") return;
      yield* store.mutate((current) => {
        if (!(threadId in current.threads)) return current;
        const nextThreads = { ...current.threads };
        delete nextThreads[threadId];
        return { ...current, threads: nextThreads };
      });
    },
  );

  const handle: AutoReviewService["Service"]["handle"] = Effect.fnUntraced(function* (event) {
    if (event.type === "run.created") {
      yield* handleFreshUserRunCreated(event.threadId, event.payload.userMessageId);
      return;
    }
    if (event.type !== "run.updated") return;
    const status = event.payload.status;
    if (!TERMINAL_RUN_STATUSES.has(status)) return;

    if (yield* store.isReviewerThread(event.threadId)) {
      yield* settleReviewerCompletion(event.threadId, status);
      return;
    }

    if (!REVIEWABLE_RUN_STATUSES.has(status)) return;
    yield* threadLocks.withLock(
      event.threadId,
      launchReviewForRun({
        threadId: event.threadId,
        runId: event.payload.id,
        manual: false,
      }).pipe(
        Effect.catchTags({ AutoReviewTriggerError: () => Effect.void }),
        Effect.catchCause((cause) =>
          Effect.logWarning("auto-review.handle-worker-completed-failed", {
            threadId: event.threadId,
            runId: event.payload.id,
            cause,
          }),
        ),
      ),
    );
  });

  const reconcileOnStart = Effect.fn("AutoReviewService.reconcileOnStart")(function* () {
    const snapshot = yield* store.getSnapshot;
    const reviewingEntries = Object.values(snapshot.threads).filter(
      (entry) => entry.status === "reviewing" && entry.reviewerThreadId !== null,
    );
    for (const entry of reviewingEntries) {
      const reviewerId = entry.reviewerThreadId;
      if (reviewerId === null) continue;
      const reviewerProj = yield* projections
        .getThreadRecords(reviewerId, ["runs"])
        .pipe(Effect.option);
      const lastRun = Option.match(reviewerProj, {
        onNone: () => undefined,
        onSome: (proj) => proj.runs[proj.runs.length - 1],
      });
      if (lastRun === undefined) {
        yield* settleReviewerCompletion(reviewerId, "failed");
      } else if (TERMINAL_RUN_STATUSES.has(lastRun.status)) {
        yield* settleReviewerCompletion(reviewerId, lastRun.status);
      }
    }
  });

  const start: AutoReviewService["Service"]["start"] = Effect.fn("AutoReviewService.start")(
    function* () {
      yield* reconcileOnStart().pipe(
        Effect.catchCause((cause) => Effect.logWarning("auto-review.reconcile-failed", { cause })),
      );
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, (event) =>
          handle(event).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("auto-review.event-handler-failed", {
                threadId: event.threadId,
                type: event.type,
                cause,
              }),
            ),
          ),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("auto-review.event-stream-failed", { cause }),
          ),
        ),
      );
    },
  );

  const triggerReview: AutoReviewService["Service"]["triggerReview"] = Effect.fn(
    "AutoReviewService.triggerReview",
  )(function* (threadId) {
    return yield* threadLocks.withLock(
      threadId,
      Effect.gen(function* () {
        const projectionOpt = yield* projections
          .getThreadRecords(threadId, ["runs"])
          .pipe(Effect.option);
        if (Option.isNone(projectionOpt)) {
          return yield* new AutoReviewTriggerError({
            reason: "thread_not_found",
            detail: `Thread ${threadId} not found.`,
          });
        }
        const latestReviewableRun = [...projectionOpt.value.runs]
          .reverse()
          .find((run) => REVIEWABLE_RUN_STATUSES.has(run.status));
        if (latestReviewableRun === undefined) {
          return yield* new AutoReviewTriggerError({
            reason: "no_completed_run",
            detail: "This thread has no completed run to review yet.",
          });
        }
        return yield* launchReviewForRun({
          threadId,
          runId: latestReviewableRun.id,
          manual: true,
        });
      }),
    );
  });

  const acknowledgeThread: AutoReviewService["Service"]["acknowledgeThread"] = Effect.fn(
    "AutoReviewService.acknowledgeThread",
  )(function* (threadId) {
    return yield* store.mutate((current) => {
      if (!(threadId in current.threads)) return current;
      const nextThreads = { ...current.threads };
      delete nextThreads[threadId];
      return { ...current, threads: nextThreads };
    });
  });

  return {
    start,
    handle,
    getSnapshot: store.getSnapshot,
    streamSnapshot: store.streamChanges,
    updateConfig: store.updateConfig,
    triggerReview,
    acknowledgeThread,
  } satisfies AutoReviewService["Service"];
});

export const layer = Layer.effect(AutoReviewService, make);
