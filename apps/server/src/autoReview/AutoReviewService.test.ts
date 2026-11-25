import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_AUTO_REVIEW_CONFIG,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { AUTO_REVIEW_OUTPUT_SCHEMA, AUTO_REVIEW_TITLE_PREFIX } from "./AutoReviewPrompt.ts";
import * as AutoReviewService from "./AutoReviewService.ts";
import * as AutoReviewStore from "./AutoReviewStore.ts";

const NOW = DateTime.makeUnsafe("2026-11-25T06:00:00.000Z");

const PROJECT_A = ProjectId.make("project:alpha");
const WORKER_1 = ThreadId.make("thread:worker-1");
const WORKER_2 = ThreadId.make("thread:worker-2");
const WORKER_3 = ThreadId.make("thread:worker-3");
const SUBAGENT_1 = ThreadId.make("thread:subagent-1");
const ARCHIVED_1 = ThreadId.make("thread:archived-1");

const CODEX_PROVIDER = {
  provider: ProviderDriverKind.make("codex"),
  instanceId: ProviderInstanceId.make("codex"),
  enabled: true,
  installed: true,
  status: "ready",
  models: [{ slug: "gpt-5.3-codex", name: "GPT-5.3 Codex", isDefault: true, isLegacy: false }],
} as unknown as ServerProvider;

const CLAUDE_PROVIDER = {
  provider: ProviderDriverKind.make("claudeAgent"),
  instanceId: ProviderInstanceId.make("claudeAgent"),
  enabled: true,
  installed: true,
  status: "ready",
  models: [{ slug: "claude-opus-4-6", name: "Claude Opus 4.6", isDefault: true, isLegacy: false }],
} as unknown as ServerProvider;

interface FakeThreadRecord {
  thread: OrchestrationV2AppThread;
  runs: OrchestrationV2Run[];
  messages: OrchestrationV2ConversationMessage[];
}

function makeThread(
  id: ThreadId,
  overrides: {
    projectId?: ProjectId;
    title?: string;
    modelSelection?: ModelSelection;
    parentThreadId?: ThreadId | null;
    archivedAt?: DateTime.Utc | null;
    worktreePath?: string | null;
    branch?: string | null;
  } = {},
): OrchestrationV2AppThread {
  return {
    id,
    projectId: overrides.projectId ?? PROJECT_A,
    title: overrides.title ?? "Implement feature X",
    modelSelection: overrides.modelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.3-codex" as ModelSelection["model"],
    },
    branch: overrides.branch ?? "feat/x",
    worktreePath: overrides.worktreePath ?? null,
    archivedAt: overrides.archivedAt ?? null,
    deletedAt: null,
    lineage: {
      parentThreadId: overrides.parentThreadId ?? null,
    },
  } as unknown as OrchestrationV2AppThread;
}

function makeRun(
  id: RunId,
  threadId: ThreadId,
  status: string,
  outputValue?: unknown,
): OrchestrationV2Run {
  return {
    id,
    threadId,
    status,
    output: outputValue === undefined ? null : { value: outputValue },
  } as unknown as OrchestrationV2Run;
}

function makeMessage(
  id: MessageId,
  role: "user" | "assistant",
  text: string,
  createdBy: "user" | "agent" | "system" = "user",
): OrchestrationV2ConversationMessage {
  return {
    id,
    role,
    text,
    createdBy,
  } as unknown as OrchestrationV2ConversationMessage;
}

function runUpdatedEvent(
  threadId: ThreadId,
  runId: RunId,
  status: string,
): OrchestrationV2DomainEvent {
  return {
    eventId: EventId.make(`evt:${threadId}:${runId}:${status}`),
    threadId,
    type: "run.updated",
    occurredAt: NOW,
    payload: { id: runId, status },
  } as unknown as OrchestrationV2DomainEvent;
}

function runCreatedEvent(
  threadId: ThreadId,
  runId: RunId,
  userMessageId: MessageId,
): OrchestrationV2DomainEvent {
  return {
    eventId: EventId.make(`evt:created:${threadId}:${runId}`),
    threadId,
    type: "run.created",
    occurredAt: NOW,
    payload: { id: runId, userMessageId },
  } as unknown as OrchestrationV2DomainEvent;
}

function createTestHarness(options?: {
  providers?: ReadonlyArray<ServerProvider>;
  initialRecords?: ReadonlyArray<FakeThreadRecord>;
}) {
  const records = new Map<string, FakeThreadRecord>();
  for (const record of options?.initialRecords ?? []) {
    records.set(record.thread.id, record);
  }
  const launched: Array<ThreadLaunchService.ThreadLaunchInput & { readonly threadId: ThreadId }> =
    [];
  const dispatched: Array<OrchestrationV2Command> = [];
  const providers = options?.providers ?? [CODEX_PROVIDER, CLAUDE_PROVIDER];

  const makeTempDirAndRun = <A, E>(
    effect: (service: AutoReviewService.AutoReviewService["Service"]) => Effect.Effect<A, E>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tmpDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-auto-review-test-" });
        const configLayer = Layer.succeed(ServerConfig.ServerConfig, {
          stateDir: tmpDir,
        } as unknown as ServerConfig.ServerConfig["Service"]);
        const orchestratorLayer = Layer.succeed(Orchestrator.OrchestratorV2, {
          streamDomainEvents: Stream.empty,
          dispatch: (command: OrchestrationV2Command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: dispatched.length } as never;
            }),
        } as unknown as Orchestrator.OrchestratorV2["Service"]);
        const projectionLayer = Layer.succeed(ProjectionStore.ProjectionStoreV2, {
          getThreadRecords: (threadId: ThreadId) => {
            const record = records.get(threadId);
            if (!record) {
              return Effect.fail(new Error(`Missing thread ${threadId}`) as never);
            }
            return Effect.succeed({
              thread: record.thread,
              runs: record.runs,
              messages: record.messages,
            } as never);
          },
        } as unknown as ProjectionStore.ProjectionStoreV2["Service"]);
        const launcherLayer = Layer.succeed(ThreadLaunchService.ThreadLaunchService, {
          launch: (input: ThreadLaunchService.ThreadLaunchInput) =>
            Effect.sync(() => {
              const threadId =
                input.threadId ?? ThreadId.make(`thread:auto-review:mock-${launched.length + 1}`);
              launched.push({ ...input, threadId });
              const reviewerThread = makeThread(threadId, {
                projectId: input.projectId,
                title: input.title ?? `${AUTO_REVIEW_TITLE_PREFIX}Review`,
                modelSelection: input.modelSelection,
              });
              records.set(threadId, {
                thread: reviewerThread,
                runs: [makeRun(RunId.make(`run:rev:${launched.length}`), threadId, "running")],
                messages: [],
              });
              return { thread: reviewerThread } as never;
            }),
        } as unknown as ThreadLaunchService.ThreadLaunchService["Service"]);
        const providerLayer = Layer.succeed(ProviderRegistry.ProviderRegistry, {
          getProviders: Effect.succeed(providers),
        } as unknown as ProviderRegistry.ProviderRegistry["Service"]);

        const storeLayer = AutoReviewStore.layer.pipe(Layer.provide(configLayer));
        const serviceLayer = AutoReviewService.layer.pipe(
          Layer.provideMerge(storeLayer),
          Layer.provide(orchestratorLayer),
          Layer.provide(projectionLayer),
          Layer.provide(launcherLayer),
          Layer.provide(providerLayer),
        );

        const result = yield* Effect.gen(function* () {
          const service = yield* AutoReviewService.AutoReviewService;
          return yield* effect(service);
        }).pipe(Effect.provide(serviceLayer));

        const stateFileExists = yield* fs.exists(path.join(tmpDir, "auto-review.json"));
        return { result, stateFileExists };
      }).pipe(Effect.provide(NodeServices.layer)),
    );

  return { records, launched, dispatched, run: makeTempDirAndRun };
}

describe("resolveReviewerModelSelection", () => {
  it("prefers explicit configured reviewerModel, then cross-provider ready model, then worker fallback", () => {
    const workerCodex: ModelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.3-codex" as ModelSelection["model"],
    };

    const crossPicked = AutoReviewService.resolveReviewerModelSelection({
      config: DEFAULT_AUTO_REVIEW_CONFIG,
      workerModelSelection: workerCodex,
      providers: [CODEX_PROVIDER, CLAUDE_PROVIDER],
    });
    expect(crossPicked.instanceId).toBe("claudeAgent");
    expect(crossPicked.model).toBe("claude-opus-4-6");

    const explicitPicked = AutoReviewService.resolveReviewerModelSelection({
      config: {
        ...DEFAULT_AUTO_REVIEW_CONFIG,
        reviewerModel: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
      },
      workerModelSelection: workerCodex,
      providers: [CODEX_PROVIDER, CLAUDE_PROVIDER],
    });
    expect(explicitPicked.instanceId).toBe("codex");
    expect(explicitPicked.model).toBe("gpt-5.4");

    const fallbackPicked = AutoReviewService.resolveReviewerModelSelection({
      config: DEFAULT_AUTO_REVIEW_CONFIG,
      workerModelSelection: workerCodex,
      providers: [CODEX_PROVIDER],
    });
    expect(fallbackPicked).toEqual(workerCodex);
  });
});

describe("AutoReviewService", () => {
  it.effect(
    "runs isolated review on worker completion, archives reviewer on approval, and prevents recursion",
    () =>
      Effect.gen(function* () {
        const workerRun1 = RunId.make("run:worker-1");
        const harness = createTestHarness({
          initialRecords: [
            {
              thread: makeThread(WORKER_1),
              runs: [makeRun(workerRun1, WORKER_1, "completed")],
              messages: [],
            },
            {
              thread: makeThread(SUBAGENT_1, { parentThreadId: WORKER_1 }),
              runs: [makeRun(RunId.make("run:sub-1"), SUBAGENT_1, "completed")],
              messages: [],
            },
            {
              thread: makeThread(ARCHIVED_1, { archivedAt: NOW }),
              runs: [makeRun(RunId.make("run:arch-1"), ARCHIVED_1, "completed")],
              messages: [],
            },
          ],
        });

        const { result, stateFileExists } = yield* harness.run((service) =>
          Effect.gen(function* () {
            yield* service.updateConfig({ enabled: true });

            // Subagents and archived threads are skipped.
            yield* service.handle(
              runUpdatedEvent(SUBAGENT_1, RunId.make("run:sub-1"), "completed"),
            );
            yield* service.handle(
              runUpdatedEvent(ARCHIVED_1, RunId.make("run:arch-1"), "completed"),
            );
            expect(harness.launched).toHaveLength(0);

            // Top-level worker completion triggers isolated cross-model reviewer.
            yield* service.handle(runUpdatedEvent(WORKER_1, workerRun1, "completed"));
            expect(harness.launched).toHaveLength(1);
            const reviewerLaunch = harness.launched[0]!;
            expect(reviewerLaunch.modelSelection.instanceId).toBe("claudeAgent");
            expect(reviewerLaunch.runtimeMode).toBe("full-access");
            expect(reviewerLaunch.interactionMode).toBe("default");
            expect(reviewerLaunch.initialMessage?.outputSchema).toEqual(AUTO_REVIEW_OUTPUT_SCHEMA);

            const reviewingSnap = yield* service.getSnapshot;
            expect(reviewingSnap.threads[WORKER_1]?.status).toBe("reviewing");
            expect(reviewingSnap.reviewerThreadIds).toContain(reviewerLaunch.threadId);

            // Simulate reviewer completing with structured "approved" verdict.
            const reviewerRecord = harness.records.get(reviewerLaunch.threadId)!;
            const revRunId = reviewerRecord.runs[0]!.id;
            reviewerRecord.runs = [
              makeRun(revRunId, reviewerLaunch.threadId, "completed", {
                verdict: "approved",
                summary: "All tests pass and diff is scoped.",
              }),
            ];
            yield* service.handle(runUpdatedEvent(reviewerLaunch.threadId, revRunId, "completed"));

            // Must NOT launch a recursive review of the reviewer thread!
            expect(harness.launched).toHaveLength(1);
            // Reviewer thread must be auto-archived; worker must NOT be marked unread on approval.
            expect(
              harness.dispatched.some(
                (cmd) => cmd.type === "thread.archive" && cmd.threadId === reviewerLaunch.threadId,
              ),
            ).toBe(true);
            expect(harness.dispatched.some((cmd) => cmd.type === "thread.mark-unread")).toBe(false);

            return yield* service.getSnapshot;
          }),
        );

        expect(stateFileExists).toBe(true);
        expect(result.threads[WORKER_1]?.status).toBe("approved");
        expect(result.threads[WORKER_1]?.summary).toBe("All tests pass and diff is scoped.");
        expect(result.threads[WORKER_1]?.lastReviewedRunId).toBe(workerRun1);
      }),
  );

  it.effect(
    "dispatches bounded rework and escalates to needs_human when circuit breaker hits",
    () =>
      Effect.gen(function* () {
        const run1 = RunId.make("run:worker-r1");
        const run2 = RunId.make("run:worker-r2");
        const harness = createTestHarness({
          initialRecords: [
            {
              thread: makeThread(WORKER_1),
              runs: [makeRun(run1, WORKER_1, "completed")],
              messages: [],
            },
          ],
        });

        const { result } = yield* harness.run((service) =>
          Effect.gen(function* () {
            yield* service.updateConfig({ enabled: true, maxReworkRounds: 1 });

            // Round 1: worker finishes -> reviewer asks for rework -> server dispatches rework (1/1).
            yield* service.handle(runUpdatedEvent(WORKER_1, run1, "completed"));
            const rev1Id = harness.launched[0]!.threadId;
            const rev1RunId = harness.records.get(rev1Id)!.runs[0]!.id;
            harness.records.get(rev1Id)!.runs = [
              makeRun(rev1RunId, rev1Id, "completed", {
                verdict: "rework",
                summary: "Missing edge-case unit test.",
                reworkPrompt: "Add a unit test for empty input and re-run vitest.",
              }),
            ];
            yield* service.handle(runUpdatedEvent(rev1Id, rev1RunId, "completed"));

            const afterRound1 = yield* service.getSnapshot;
            expect(afterRound1.threads[WORKER_1]?.status).toBe("reworking");
            expect(afterRound1.threads[WORKER_1]?.reworkCount).toBe(1);
            const dispatchCmd = harness.dispatched.find((cmd) => cmd.type === "message.dispatch");
            expect(dispatchCmd).toBeDefined();
            if (dispatchCmd?.type === "message.dispatch") {
              expect(dispatchCmd.threadId).toBe(WORKER_1);
              expect(dispatchCmd.text).toContain("Round 1/1");
              expect(dispatchCmd.text).toContain("Add a unit test for empty input");
            }

            // Rework run created must NOT wipe auto-review state.
            if (dispatchCmd?.type === "message.dispatch") {
              yield* service.handle(runCreatedEvent(WORKER_1, run2, dispatchCmd.messageId));
            }
            expect((yield* service.getSnapshot).threads[WORKER_1]?.reworkCount).toBe(1);

            // Round 2: worker finishes rework -> reviewer STILL requests rework -> circuit breaker escalates to needs_human!
            harness.records.get(WORKER_1)!.runs.push(makeRun(run2, WORKER_1, "completed"));
            yield* service.handle(runUpdatedEvent(WORKER_1, run2, "completed"));
            expect(harness.launched).toHaveLength(2);
            const rev2Id = harness.launched[1]!.threadId;
            const rev2RunId = harness.records.get(rev2Id)!.runs[0]!.id;
            harness.records.get(rev2Id)!.runs = [
              makeRun(rev2RunId, rev2Id, "completed", {
                verdict: "rework",
                summary: "Test still fails on null input.",
                reworkPrompt: "Handle null input safely.",
              }),
            ];
            yield* service.handle(runUpdatedEvent(rev2Id, rev2RunId, "completed"));

            // Must NOT dispatch a 2nd rework; must mark worker unread and escalate to needs_human.
            expect(
              harness.dispatched.filter((cmd) => cmd.type === "message.dispatch"),
            ).toHaveLength(1);
            expect(
              harness.dispatched.some(
                (cmd) => cmd.type === "thread.mark-unread" && cmd.threadId === WORKER_1,
              ),
            ).toBe(true);

            const escalated = yield* service.getSnapshot;
            expect(escalated.threads[WORKER_1]?.status).toBe("needs_human");
            expect(escalated.threads[WORKER_1]?.humanQuestion).toContain(
              "Handle null input safely.",
            );

            // Fresh human message resets the review state and reworkCount.
            const userMsgId = MessageId.make("msg:human-next");
            harness.records
              .get(WORKER_1)!
              .messages.push(makeMessage(userMsgId, "user", "Let's try X", "user"));
            yield* service.handle(
              runCreatedEvent(WORKER_1, RunId.make("run:worker-r3"), userMsgId),
            );

            return yield* service.getSnapshot;
          }),
        );

        expect(result.threads[WORKER_1]).toBeUndefined();
      }),
  );

  it.effect("respects maxConcurrency queue, manual trigger bypass, and acknowledgeThread", () =>
    Effect.gen(function* () {
      const r1 = RunId.make("run:w1");
      const r2 = RunId.make("run:w2");
      const r3 = RunId.make("run:w3");
      const harness = createTestHarness({
        initialRecords: [
          {
            thread: makeThread(WORKER_1),
            runs: [makeRun(r1, WORKER_1, "completed")],
            messages: [],
          },
          {
            thread: makeThread(WORKER_2),
            runs: [makeRun(r2, WORKER_2, "completed")],
            messages: [],
          },
          {
            thread: makeThread(WORKER_3),
            runs: [makeRun(r3, WORKER_3, "completed")],
            messages: [],
          },
        ],
      });

      yield* harness.run((service) =>
        Effect.gen(function* () {
          // Manual trigger works even while global enabled=false.
          const manualSnap = yield* service.triggerReview(WORKER_3);
          expect(manualSnap.threads[WORKER_3]?.status).toBe("reviewing");
          expect(harness.launched).toHaveLength(1);

          // Settle WORKER_3 as needs_human, then acknowledge clears it.
          const rev3Id = harness.launched[0]!.threadId;
          const rev3Run = harness.records.get(rev3Id)!.runs[0]!.id;
          harness.records.get(rev3Id)!.runs = [
            makeRun(rev3Run, rev3Id, "completed", {
              verdict: "needs_human",
              summary: "Needs product decision.",
              humanQuestion: "Should we keep backward compatibility for v1?",
            }),
          ];
          yield* service.handle(runUpdatedEvent(rev3Id, rev3Run, "completed"));
          expect((yield* service.getSnapshot).threads[WORKER_3]?.status).toBe("needs_human");

          const acked = yield* service.acknowledgeThread(WORKER_3);
          expect(acked.threads[WORKER_3]).toBeUndefined();

          // Concurrency = 1 queues WORKER_2 until WORKER_1 finishes review.
          yield* service.updateConfig({ enabled: true, maxConcurrency: 1 });
          yield* service.handle(runUpdatedEvent(WORKER_1, r1, "completed"));
          yield* service.handle(runUpdatedEvent(WORKER_2, r2, "completed"));
          expect(harness.launched).toHaveLength(2); // only WORKER_3 (done) + WORKER_1

          const rev1Id = harness.launched[1]!.threadId;
          const rev1Run = harness.records.get(rev1Id)!.runs[0]!.id;
          harness.records.get(rev1Id)!.runs = [
            makeRun(rev1Run, rev1Id, "completed", {
              verdict: "approved",
              summary: "Looks good.",
            }),
          ];
          yield* service.handle(runUpdatedEvent(rev1Id, rev1Run, "completed"));

          // Drained pending queue should immediately launch review for WORKER_2!
          expect(harness.launched).toHaveLength(3);
          expect((yield* service.getSnapshot).threads[WORKER_2]?.status).toBe("reviewing");
        }),
      );
    }),
  );
});
