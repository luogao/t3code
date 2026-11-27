import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_AUTO_REVIEW_SNAPSHOT,
  IsoDateTime,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type AutoReviewSnapshot,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import * as AutoReviewService from "../autoReview/AutoReviewService.ts";
import * as AutoReviewStore from "../autoReview/AutoReviewStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as FridayService from "./FridayService.ts";
import * as FridayStore from "./FridayStore.ts";

const NOW = DateTime.makeUnsafe("2026-11-26T09:30:00.000Z");
const PROJECT_MOTION = ProjectId.make("project:openmotion");
const PROJECT_T3 = ProjectId.make("project:t3code");

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

interface FakeRecord {
  thread: OrchestrationV2AppThread;
  runs: OrchestrationV2Run[];
  runtimeRequests: OrchestrationV2RuntimeRequest[];
  messages: OrchestrationV2ConversationMessage[];
  children: ThreadId[];
}

function makeThread(
  id: ThreadId,
  overrides: {
    projectId?: ProjectId;
    title?: string;
    modelSelection?: ModelSelection;
    branch?: string | null;
  } = {},
): OrchestrationV2AppThread {
  return {
    id,
    projectId: overrides.projectId ?? PROJECT_MOTION,
    title: overrides.title ?? "Worker task",
    modelSelection: overrides.modelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.3-codex" as ModelSelection["model"],
    },
    branch: overrides.branch ?? "feat/worker",
    worktreePath: null,
    archivedAt: null,
    deletedAt: null,
    updatedAt: NOW,
    lineage: {
      parentThreadId: null,
    },
  } as unknown as OrchestrationV2AppThread;
}

function createHarness() {
  const records = new Map<string, FakeRecord>();
  const dispatched: Array<OrchestrationV2Command> = [];
  const launched: Array<ThreadLaunchService.ThreadLaunchInput & { readonly threadId: ThreadId }> =
    [];
  const acknowledged: Array<ThreadId> = [];

  const run = <A, E>(
    effect: (
      service: FridayService.FridayService["Service"],
      autoReviewRef: Ref.Ref<AutoReviewSnapshot>,
    ) => Effect.Effect<A, E>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tmpDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-friday-test-" });
        const autoReviewRef = yield* Ref.make<AutoReviewSnapshot>(DEFAULT_AUTO_REVIEW_SNAPSHOT);

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
              runtimeRequests: record.runtimeRequests,
              messages: record.messages,
            } as never);
          },
          listAppOwnedChildThreadIds: (threadId: ThreadId) =>
            Effect.succeed(records.get(threadId)?.children ?? []),
        } as unknown as ProjectionStore.ProjectionStoreV2["Service"]);

        const projectLayer = Layer.succeed(ProjectStore.ProjectStoreV2, {
          list: () =>
            Effect.succeed([
              {
                projectId: PROJECT_MOTION,
                title: "openmotion",
                workspaceRoot: "/workspace/openmotion",
                archivedAt: null,
                deletedAt: null,
              },
              {
                projectId: PROJECT_T3,
                title: "t3code",
                workspaceRoot: "/workspace/t3code",
                archivedAt: null,
                deletedAt: null,
              },
            ] as never),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]);

        const launcherLayer = Layer.succeed(ThreadLaunchService.ThreadLaunchService, {
          launch: (input: ThreadLaunchService.ThreadLaunchInput) =>
            Effect.sync(() => {
              const threadId = input.threadId ?? ThreadId.make("thread:friday-core:mock");
              launched.push({ ...input, threadId });
              const thread = makeThread(threadId, {
                projectId: input.projectId,
                title: input.title ?? "Friday",
                modelSelection: input.modelSelection,
                branch: null,
              });
              records.set(threadId, {
                thread,
                runs: [{ id: RunId.make("run:core:1"), status: "running" } as OrchestrationV2Run],
                runtimeRequests: [],
                messages: [
                  {
                    id: input.initialMessage?.messageId,
                    runId: RunId.make("run:core:1"),
                    role: "user",
                    text: input.initialMessage?.text ?? "",
                  } as unknown as OrchestrationV2ConversationMessage,
                ],
                children: [],
              });
              return { thread } as never;
            }),
        } as unknown as ThreadLaunchService.ThreadLaunchService["Service"]);

        const providerLayer = Layer.succeed(ProviderRegistry.ProviderRegistry, {
          getProviders: Effect.succeed([CODEX_PROVIDER, CLAUDE_PROVIDER]),
        } as unknown as ProviderRegistry.ProviderRegistry["Service"]);

        const autoReviewStoreLayer = Layer.succeed(AutoReviewStore.AutoReviewStore, {
          getSnapshot: Ref.get(autoReviewRef),
          streamChanges: Stream.empty,
        } as unknown as AutoReviewStore.AutoReviewStore["Service"]);

        const autoReviewServiceLayer = Layer.succeed(AutoReviewService.AutoReviewService, {
          acknowledgeThread: (threadId: ThreadId) =>
            Effect.gen(function* () {
              acknowledged.push(threadId);
              return yield* Ref.get(autoReviewRef);
            }),
        } as unknown as AutoReviewService.AutoReviewService["Service"]);

        const storeLayer = FridayStore.layer.pipe(Layer.provide(configLayer));
        const serviceLayer = FridayService.layer.pipe(
          Layer.provideMerge(storeLayer),
          Layer.provide(orchestratorLayer),
          Layer.provide(projectionLayer),
          Layer.provide(projectLayer),
          Layer.provide(launcherLayer),
          Layer.provide(providerLayer),
          Layer.provide(autoReviewStoreLayer),
          Layer.provide(autoReviewServiceLayer),
        );

        const value = yield* Effect.gen(function* () {
          const service = yield* FridayService.FridayService;
          return yield* effect(service, autoReviewRef);
        }).pipe(Effect.provide(serviceLayer));

        const fridayJsonExists = yield* fs.exists(path.join(tmpDir, "friday.json"));
        const fridayMdExists = yield* fs.exists(path.join(tmpDir, "FRIDAY.md"));
        return { value, fridayJsonExists, fridayMdExists };
      }).pipe(Effect.provide(NodeServices.layer)),
    );

  return { records, dispatched, launched, acknowledged, run };
}

describe("FridayService", () => {
  it.effect(
    "bootstraps permanent hub thread, aggregates cross-project subagents and QA moons, and supports same-thread freshContext rollover",
    () =>
      Effect.gen(function* () {
        const harness = createHarness();
        const { fridayJsonExists, fridayMdExists } = yield* harness.run((service, autoReviewRef) =>
          Effect.gen(function* () {
            const initial = yield* service.getSnapshot;
            expect(initial.coreThreadId).toBeNull();
            expect(initial.projects).toHaveLength(2);
            expect(initial.memoryMarkdown).toContain("FRIDAY Operations Playbook");

            // First prompt launches permanent Friday core thread with playbook & project catalog.
            const afterFirst = yield* service.sendPrompt({
              text: "Audit openmotion and t3code open defects in parallel.",
            });
            expect(afterFirst.coreThreadId).not.toBeNull();
            const coreThreadId = afterFirst.coreThreadId!;
            expect(harness.launched).toHaveLength(1);
            expect(harness.launched[0]!.initialMessage?.text).toContain("project:openmotion");
            expect(harness.launched[0]!.initialMessage?.text).toContain("project:t3code");
            const runningCoreNode = afterFirst.nodes.find((node) => node.kind === "core");
            expect(runningCoreNode?.status).toBe("running");
            expect(runningCoreNode?.latestMessagePreview).toBe(
              "Audit openmotion and t3code open defects in parallel.",
            );

            // Once Friday replies and run finishes, core status returns to "core" with assistant reply preview.
            harness.records.get(coreThreadId)!.runs = [
              { id: RunId.make("run:core:1"), status: "completed" } as OrchestrationV2Run,
            ];
            harness.records.get(coreThreadId)!.messages.push({
              role: "assistant",
              text: "Hello! Ready across openmotion and t3code.",
            } as unknown as OrchestrationV2ConversationMessage);
            const afterReply = yield* service.getSnapshot;
            const repliedCoreNode = afterReply.nodes.find((node) => node.kind === "core");
            expect(repliedCoreNode?.status).toBe("core");
            expect(repliedCoreNode?.latestMessagePreview).toBe(
              "Hello! Ready across openmotion and t3code.",
            );

            // Second prompt dispatches onto the SAME core thread (never creates a second core thread).
            yield* service.sendPrompt({ text: "Prioritize openmotion render retries first." });
            expect(harness.launched).toHaveLength(1);
            expect(harness.dispatched[0]?.type).toBe("message.dispatch");

            // Attach two cross-project child threads: one needing approval, one with an Auto-Review moon.
            const childApproveId = ThreadId.make("thread:child-approve");
            const childReviewedId = ThreadId.make("thread:child-reviewed");
            const reviewerId = ThreadId.make("thread:auto-review:child");
            const approvalReqId = RuntimeRequestId.make("req:cmd:1");

            harness.records.get(coreThreadId)!.children.push(childApproveId, childReviewedId);
            harness.records.set(childApproveId, {
              thread: makeThread(childApproveId, {
                projectId: PROJECT_T3,
                title: "Upstream PR #40673 reply",
                modelSelection: {
                  instanceId: ProviderInstanceId.make("claudeAgent"),
                  model: "claude-opus-4-6" as ModelSelection["model"],
                },
              }),
              runs: [{ id: RunId.make("run:c1"), status: "waiting" } as OrchestrationV2Run],
              runtimeRequests: [
                {
                  id: approvalReqId,
                  nodeId: NodeId.make("node:1"),
                  kind: "command",
                  status: "pending",
                } as unknown as OrchestrationV2RuntimeRequest,
              ],
              messages: [
                {
                  role: "assistant",
                  text: "Ready to post reply to @juliusmarminge on GitHub PR #40673.",
                } as unknown as OrchestrationV2ConversationMessage,
              ],
              children: [],
            });
            harness.records.set(childReviewedId, {
              thread: makeThread(childReviewedId, {
                projectId: PROJECT_MOTION,
                title: "Cloud render retry strategy",
              }),
              runs: [{ id: RunId.make("run:c2"), status: "completed" } as OrchestrationV2Run],
              runtimeRequests: [],
              messages: [],
              children: [],
            });
            harness.records.set(reviewerId, {
              thread: makeThread(reviewerId, {
                projectId: PROJECT_MOTION,
                title: "[Auto-Review] Cloud render retry strategy",
                modelSelection: {
                  instanceId: ProviderInstanceId.make("claudeAgent"),
                  model: "claude-opus-4-6" as ModelSelection["model"],
                },
              }),
              runs: [{ id: RunId.make("run:rev"), status: "completed" } as OrchestrationV2Run],
              runtimeRequests: [],
              messages: [],
              children: [],
            });

            yield* Ref.set(autoReviewRef, {
              ...DEFAULT_AUTO_REVIEW_SNAPSHOT,
              reviewerThreadIds: [reviewerId],
              threads: {
                [childReviewedId]: {
                  threadId: childReviewedId,
                  status: "needs_human",
                  reworkCount: 2,
                  maxReworkRounds: 2,
                  lastReviewedRunId: RunId.make("run:c2"),
                  activeReviewRunId: null,
                  reviewerThreadId: reviewerId,
                  verdict: "needs_human",
                  summary: "SLA trade-off needs decision.",
                  reworkPrompt: null,
                  humanQuestion: "Choose queue backoff vs API idempotency key?",
                  reviewedAt: IsoDateTime.make("2026-11-26T09:30:00.000Z"),
                  updatedAt: IsoDateTime.make("2026-11-26T09:30:00.000Z"),
                },
              },
            });

            const graph = yield* service.getSnapshot;
            expect(graph.nodes.map((node) => node.id)).toEqual([
              coreThreadId,
              childApproveId,
              childReviewedId,
              `reviewer:${childReviewedId}`,
            ]);
            const approveNode = graph.nodes.find((node) => node.id === childApproveId)!;
            expect(approveNode.status).toBe("needs_human");
            expect(approveNode.pendingDecision?.kind).toBe("approval");
            expect(approveNode.projectTitle).toBe("t3code");

            const reviewedNode = graph.nodes.find((node) => node.id === childReviewedId)!;
            expect(reviewedNode.status).toBe("needs_human");
            expect(reviewedNode.pendingDecision?.kind).toBe("auto_review");

            // Inline approval decision dispatches native runtime-request.respond.
            yield* service.decideThread(childApproveId, {
              action: "approval_accept",
              requestId: approvalReqId,
            });
            const approvalCmd = harness.dispatched.find(
              (cmd) => cmd.type === "runtime-request.respond",
            );
            expect(approvalCmd).toBeDefined();
            if (approvalCmd?.type === "runtime-request.respond") {
              expect(approvalCmd.decision).toBe("accept");
            }

            // Inline auto-review acknowledge delegates cleanly to AutoReviewService.
            yield* service.decideThread(childReviewedId, { action: "acknowledge" });
            expect(harness.acknowledged).toContain(childReviewedId);

            // Manual soft rollover dispatches freshContext: true on the SAME coreThreadId and increments shift.
            const afterRollover = yield* service.rollover({ note: "Focus on Friday M1 next." });
            expect(afterRollover.coreThreadId).toBe(coreThreadId);
            expect(afterRollover.config.shiftNumber).toBe(2);
            const rolloverCmd = harness.dispatched.find(
              (cmd) => cmd.type === "message.dispatch" && cmd.freshContext === true,
            );
            expect(rolloverCmd).toBeDefined();
            if (rolloverCmd?.type === "message.dispatch") {
              expect(rolloverCmd.threadId).toBe(coreThreadId);
              expect(rolloverCmd.text).toContain("Focus on Friday M1 next.");
              expect(rolloverCmd.text).toContain("Cloud render retry strategy");
            }

            // Memory, layout, and core model hot-swap persist cleanly.
            const afterMemory = yield* service.updateMemory("# Updated Friday Rules\n");
            expect(afterMemory.memoryMarkdown).toBe("# Updated Friday Rules\n");

            const afterLayout = yield* service.updateLayout({
              [childApproveId]: { x: 220, y: -140 },
            });
            expect(afterLayout.config.nodePositions[childApproveId]).toEqual({ x: 220, y: -140 });

            yield* service.updateCoreModel({
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-opus-4-6" as ModelSelection["model"],
            });
            expect(harness.dispatched.some((cmd) => cmd.type === "provider.switch")).toBe(true);
          }),
        );

        expect(fridayJsonExists).toBe(true);
        expect(fridayMdExists).toBe(true);
      }),
  );
});
