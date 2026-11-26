import type {
  FridayDecisionOption,
  FridayGraphNode,
  FridayNodePosition,
  ModelSelection,
  ServerProvider,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import { ArrowUpIcon, CheckIcon, MinusIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { SidebarInset } from "../components/ui/sidebar";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { useWorkspacePreparedConnection } from "../environments/workspaceHttp";
import { observeResize } from "../lib/observeResize";
import { cn } from "../lib/utils";
import { useEnvironmentProviders } from "../state/environments";
import { FridayThreadDrawer } from "./FridayThreadDrawer";
import {
  buildSmoothElbowPath,
  computeAutoFitCamera,
  computeEdgeEndpoints,
  computeFridayNodePositions,
  type FridayCamera,
} from "./layout";
import {
  decideFridayThread,
  rolloverFridayContext,
  sendFridayPrompt,
  updateFridayCoreModel,
  updateFridayLayout,
  updateFridayMemory,
  useFridaySnapshot,
  useFridaySubscription,
} from "./store";

type FridayLens = "all" | "active" | "needs_human";

interface ModelOption {
  readonly label: string;
  readonly selection: ModelSelection;
}

function collectAvailableCoreModels(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ModelOption> {
  const options: ModelOption[] = [];
  for (const provider of providers) {
    if (!provider.enabled || !provider.installed) continue;
    const defaultModel =
      provider.models.find((model) => model.isDefault && !model.isLegacy) ??
      provider.models.find((model) => !model.isLegacy) ??
      provider.models[0];
    if (defaultModel === undefined) continue;
    options.push({
      label: defaultModel.name || defaultModel.slug,
      selection: {
        instanceId: provider.instanceId,
        model: defaultModel.slug,
      },
    });
  }
  return options;
}

export function FridayCanvasPage() {
  const gt = useGT();
  const navigate = useNavigate();
  const { environmentId: workspaceEnvironmentId, connectionKey: workspaceConnectionKey } =
    useWorkspacePreparedConnection();
  const providersByEnvironment = useEnvironmentProviders();
  useFridaySubscription(workspaceEnvironmentId, workspaceConnectionKey);
  const snapshot = useFridaySnapshot();

  const [lens, setLens] = useState<FridayLens>("all");
  const [classicListOpen, setClassicListOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [composerText, setComposerText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [decidingNodeId, setDecidingNodeId] = useState<string | null>(null);

  const [memoryModalOpen, setMemoryModalOpen] = useState(false);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [savingMemory, setSavingMemory] = useState(false);

  const [rolloverModalOpen, setRolloverModalOpen] = useState(false);
  const [rolloverNote, setRolloverNote] = useState("");
  const [rollingOver, setRollingOver] = useState(false);

  const [dragPositions, setDragPositions] = useState<Readonly<Record<string, FridayNodePosition>>>(
    {},
  );
  const [camera, setCamera] = useState<FridayCamera>({ x: 0, y: 0, scale: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const hasAutoFittedRef = useRef(false);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const panStateRef = useRef<{
    active: boolean;
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  }>({ active: false, pointerId: -1, startX: 0, startY: 0, origX: 0, origY: 0 });

  const dragNodeRef = useRef<{
    nodeId: string;
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
    latestX: number;
    latestY: number;
  } | null>(null);

  const availableModels =
    workspaceEnvironmentId === null
      ? []
      : collectAvailableCoreModels(providersByEnvironment.get(workspaceEnvironmentId) ?? []);

  const basePositions = computeFridayNodePositions(snapshot.nodes);
  const resolvedPositions = new Map<string, FridayNodePosition>(basePositions);
  for (const [nodeId, pos] of Object.entries(dragPositions)) {
    resolvedPositions.set(nodeId, pos);
  }

  const fitCameraToCanvas = (positionsMap: ReadonlyMap<string, FridayNodePosition>) => {
    const el = stageRef.current;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    setCamera(
      computeAutoFitCamera({
        positions: positionsMap,
        width: rect.width,
        height: rect.height,
      }),
    );
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- initial viewport centering and resize tracking for the infinite canvas camera
  useEffect(() => {
    const el = stageRef.current;
    if (el === null) return;
    const fitToElement = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      setCamera(
        computeAutoFitCamera({
          positions: computeFridayNodePositions(snapshot.nodes),
          width: rect.width,
          height: rect.height,
        }),
      );
    };
    if (!hasAutoFittedRef.current) {
      hasAutoFittedRef.current = true;
      fitToElement();
    }
    return observeResize(el, () => {
      if (!panStateRef.current.active && dragNodeRef.current === null) {
        fitToElement();
      }
    });
  }, [snapshot.nodes]);

  const workers = snapshot.nodes.filter((node) => node.kind === "worker");
  const activeCount = workers.filter((node) => node.status !== "completed").length;
  const needsHumanCount = workers.filter((node) => node.status === "needs_human").length;
  const coreNode = snapshot.nodes.find((node) => node.kind === "core") ?? null;
  const selectedNode = snapshot.nodes.find((node) => node.id === selectedNodeId) ?? null;

  const isNodeVisible = (node: FridayGraphNode): boolean => {
    if (node.kind === "core") return true;
    if (lens === "all") return true;
    if (lens === "active") return node.status !== "completed";
    if (node.status === "needs_human") return true;
    if (node.kind === "reviewer" && node.parentId !== null) {
      const parent = snapshot.nodes.find((candidate) => candidate.id === node.parentId);
      return parent?.status === "needs_human";
    }
    return false;
  };

  const handleResetLayout = async () => {
    const clearEntries: Record<string, null> = {};
    for (const key of Object.keys(snapshot.config.nodePositions)) {
      clearEntries[key] = null;
    }
    setDragPositions({});
    if (Object.keys(clearEntries).length > 0) {
      try {
        await updateFridayLayout(clearEntries);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: gt("Could not reset layout"),
          description: error instanceof Error ? error.message : String(error),
        });
      }
    }
    fitCameraToCanvas(
      computeFridayNodePositions(snapshot.nodes.map((node) => ({ ...node, position: null }))),
    );
  };

  const handleCycleCoreModel = async () => {
    if (availableModels.length === 0) return;
    const currentInstance =
      coreNode?.providerInstanceId ?? snapshot.config.preferredModel?.instanceId ?? null;
    const currentModel = coreNode?.model ?? snapshot.config.preferredModel?.model ?? null;
    const currentIdx = availableModels.findIndex(
      (item) =>
        item.selection.instanceId === currentInstance && item.selection.model === currentModel,
    );
    const nextOption = availableModels[(currentIdx + 1) % availableModels.length];
    if (nextOption === undefined) return;
    try {
      await updateFridayCoreModel(nextOption.selection);
      toastManager.add({
        type: "info",
        title: gt("Friday core switched to {model}", { model: nextOption.label }),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: gt("Failed to switch Friday model"),
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleDispatchPrompt = async (textOverride?: string) => {
    const text = (textOverride ?? composerText).trim();
    if (text.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      await sendFridayPrompt({ text });
      if (textOverride === undefined) {
        setComposerText("");
      }
      setLens("all");
      toastManager.add({
        type: "info",
        title: gt("Dispatched to Friday"),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: gt("Could not send instruction to Friday"),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleInlineDecision = async (node: FridayGraphNode, option: FridayDecisionOption) => {
    if (decidingNodeId !== null) return;
    setDecidingNodeId(node.id);
    try {
      await decideFridayThread(node.threadId, {
        action: option.action,
        ...(node.pendingDecision?.requestId ? { requestId: node.pendingDecision.requestId } : {}),
        ...(option.payload ? { payload: option.payload } : {}),
      });
      toastManager.add({
        type: "info",
        title: gt("{title}: {action}", { title: node.title, action: option.label }),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: gt("Could not apply decision"),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDecidingNodeId(null);
    }
  };

  const handleSaveMemory = async () => {
    setSavingMemory(true);
    try {
      await updateFridayMemory(memoryDraft);
      setMemoryModalOpen(false);
      toastManager.add({ type: "info", title: gt("Saved FRIDAY.md") });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: gt("Could not save FRIDAY.md"),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSavingMemory(false);
    }
  };

  const handleConfirmRollover = async () => {
    setRollingOver(true);
    try {
      const updated = await rolloverFridayContext(
        rolloverNote.trim().length > 0 ? { note: rolloverNote.trim() } : {},
      );
      setRolloverModalOpen(false);
      setRolloverNote("");
      toastManager.add({
        type: "info",
        title: gt("Shift {shift} ready", { shift: updated.config.shiftNumber }),
        description: gt("Started fresh context on the same Friday hub thread."),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: gt("Could not roll over Friday context"),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRollingOver(false);
    }
  };

  const handleViewportPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("[data-friday-node]")) return;
    panStateRef.current = {
      active: true,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origX: camera.x,
      origY: camera.y,
    };
    setIsPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleViewportPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panStateRef.current;
    if (!pan.active || pan.pointerId !== event.pointerId) return;
    setCamera((current) => ({
      ...current,
      x: pan.origX + (event.clientX - pan.startX),
      y: pan.origY + (event.clientY - pan.startY),
    }));
  };

  const handleViewportPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panStateRef.current;
    if (!pan.active || pan.pointerId !== event.pointerId) return;
    panStateRef.current.active = false;
    setIsPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleViewportWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const el = stageRef.current;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    const factor = event.deltaY < 0 ? 1.08 : 0.92;
    setCamera((current) => {
      const nextScale = Math.max(0.45, Math.min(1.6, current.scale * factor));
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const ratio = nextScale / current.scale;
      return {
        x: mx - (mx - current.x) * ratio,
        y: my - (my - current.y) * ratio,
        scale: nextScale,
      };
    });
  };

  const startNodePointer = (
    event: React.PointerEvent<HTMLDivElement>,
    node: FridayGraphNode,
    pos: FridayNodePosition,
  ) => {
    if ((event.target as HTMLElement).closest("button")) return;
    event.stopPropagation();
    dragNodeRef.current = {
      nodeId: node.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origX: pos.x,
      origY: pos.y,
      moved: false,
      latestX: pos.x,
      latestY: pos.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveNodePointer = (event: React.PointerEvent<HTMLDivElement>, node: FridayGraphNode) => {
    const drag = dragNodeRef.current;
    if (drag === null || drag.nodeId !== node.id || drag.pointerId !== event.pointerId) return;
    const dx = (event.clientX - drag.startX) / camera.scale;
    const dy = (event.clientY - drag.startY) / camera.scale;
    if (!drag.moved && Math.hypot(dx, dy) > 4) {
      drag.moved = true;
    }
    if (drag.moved && node.kind !== "core") {
      drag.latestX = Math.round(drag.origX + dx);
      drag.latestY = Math.round(drag.origY + dy);
      setDragPositions((current) => ({
        ...current,
        [node.id]: { x: drag.latestX, y: drag.latestY },
      }));
    }
  };

  const endNodePointer = (event: React.PointerEvent<HTMLDivElement>, node: FridayGraphNode) => {
    const drag = dragNodeRef.current;
    if (drag === null || drag.nodeId !== node.id || drag.pointerId !== event.pointerId) return;
    dragNodeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.moved) {
      setSelectedNodeId(node.id);
      return;
    }
    if (node.kind !== "core") {
      const nextPos = { x: drag.latestX, y: drag.latestY };
      void updateFridayLayout({ [node.id]: nextPos })
        .then(() => {
          setDragPositions((current) => {
            const copy = { ...current };
            delete copy[node.id];
            return copy;
          });
        })
        .catch(() => {
          // keep optimistic position visible on transient error
        });
    }
  };

  const gridStep = Math.max(18, 28 * camera.scale);
  const coreUsage = snapshot.coreContextUsagePercent ?? 0;
  const activeModelLabel =
    coreNode?.model ??
    snapshot.config.preferredModel?.model ??
    availableModels[0]?.label ??
    gt("Default model");

  const quickSuggestions = snapshot.projects.slice(0, 2).map((project) => ({
    label: gt("+ Dispatch {project}", { project: project.title }),
    prompt: `Inspect ${project.title} (${project.id}) for current status and open work, and delegate independent fixes in a worktree if appropriate.`,
  }));

  return (
    <TooltipProvider delay={200}>
      <SidebarInset className="relative flex h-dvh min-h-0 flex-col overflow-hidden">
        {/* Minimal Editorial Top Header */}
        <WorkspacePageHeader className="relative z-20 justify-between border-b border-transparent bg-transparent">
          <div className="flex items-center gap-0.5" role="group" aria-label={gt("Friday filter")}>
            <button
              type="button"
              onClick={() => setLens("all")}
              className={cn(
                "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                lens === "all"
                  ? "bg-foreground/8 text-foreground"
                  : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
              )}
            >
              <span>
                <T>All</T>
              </span>
              <span className="font-mono text-3xs tabular-nums text-muted-foreground">
                {workers.length}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setLens("active")}
              className={cn(
                "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                lens === "active"
                  ? "bg-foreground/8 text-foreground"
                  : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
              )}
            >
              <span>
                <T>Active</T>
              </span>
              <span className="font-mono text-3xs tabular-nums text-muted-foreground">
                {activeCount}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setLens("needs_human")}
              className={cn(
                "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                lens === "needs_human"
                  ? "bg-foreground/8 text-foreground"
                  : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
              )}
            >
              {needsHumanCount > 0 ? (
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-destructive" />
              ) : null}
              <span>
                <T>Needs you</T>
              </span>
              <span className="font-mono text-3xs tabular-nums text-muted-foreground">
                {needsHumanCount}
              </span>
            </button>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setMemoryDraft(snapshot.memoryMarkdown);
                setMemoryModalOpen(true);
              }}
              className="cursor-pointer rounded-md px-2.5 py-1 font-mono text-2xs font-medium text-muted-foreground transition-colors hover:bg-foreground/6 hover:text-foreground"
            >
              <T>FRIDAY.md</T>
            </button>
            <button
              type="button"
              onClick={() => setClassicListOpen((open) => !open)}
              className={cn(
                "cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                classicListOpen
                  ? "bg-foreground/8 text-foreground"
                  : "text-muted-foreground hover:bg-foreground/6 hover:text-foreground",
              )}
            >
              {classicListOpen ? <T>Canvas</T> : <T>List</T>}
            </button>
          </div>
        </WorkspacePageHeader>

        {/* Infinite Spatial Drafting Canvas */}
        <div
          ref={stageRef}
          className={cn(
            "relative flex-1 overflow-hidden select-none touch-none",
            isPanning ? "cursor-grabbing" : "cursor-grab",
          )}
          onPointerDown={handleViewportPointerDown}
          onPointerMove={handleViewportPointerMove}
          onPointerUp={handleViewportPointerUp}
          onWheel={handleViewportWheel}
        >
          {/* Ultra-faint architectural monochrome dot grid */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-35"
            style={{
              backgroundImage:
                "radial-gradient(color-mix(in srgb, var(--foreground) 15%, transparent) 0.75px, transparent 0.75px)",
              backgroundSize: `${gridStep}px ${gridStep}px`,
              backgroundPosition: `${camera.x}px ${camera.y}px`,
              maskImage: "radial-gradient(ellipse 78% 74% at 50% 48%, black 35%, transparent 96%)",
              WebkitMaskImage:
                "radial-gradient(ellipse 78% 74% at 50% 48%, black 35%, transparent 96%)",
            }}
          />

          {/* Transformed Spatial World */}
          <div
            className="absolute top-0 left-0 h-0 w-0 origin-top-left"
            style={{
              transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`,
            }}
          >
            {/* Orthogonal 1px Hairline Connectors */}
            <svg
              aria-hidden
              viewBox="-1600 -1200 3200 2400"
              className="pointer-events-none absolute -top-[1200px] -left-[1600px] h-[2400px] w-[3200px] overflow-visible"
            >
              {snapshot.edges.map((edge) => {
                const sourceNode = snapshot.nodes.find((n) => n.id === edge.sourceId);
                const targetNode = snapshot.nodes.find((n) => n.id === edge.targetId);
                const sourcePos = resolvedPositions.get(edge.sourceId);
                const targetPos = resolvedPositions.get(edge.targetId);
                if (
                  sourceNode === undefined ||
                  targetNode === undefined ||
                  sourcePos === undefined ||
                  targetPos === undefined
                ) {
                  return null;
                }
                const visible = isNodeVisible(targetNode);
                const highlighted =
                  hoveredNodeId === targetNode.id || selectedNodeId === targetNode.id;
                const { a, b } = computeEdgeEndpoints({
                  sourceNode,
                  sourcePos,
                  targetNode,
                  targetPos,
                });
                const d = buildSmoothElbowPath(a, b);
                const wireClass = highlighted
                  ? "stroke-foreground/55"
                  : targetNode.status === "needs_human"
                    ? "stroke-foreground/25"
                    : targetNode.status === "completed"
                      ? "stroke-foreground/10"
                      : "stroke-foreground/15";
                return (
                  <g key={edge.id} style={{ opacity: visible ? 1 : 0.14 }}>
                    <path
                      d={d}
                      fill="none"
                      className={wireClass}
                      strokeWidth={
                        highlighted ? 1.4 : targetNode.status === "needs_human" ? 1.25 : 1
                      }
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeDasharray={edge.kind === "review" ? "2.5 3.5" : undefined}
                    />
                    {targetNode.kind === "worker" && targetNode.status === "needs_human" ? (
                      <circle
                        cx={b.x}
                        cy={b.y}
                        r={3.5}
                        className="fill-destructive stroke-background"
                        strokeWidth={1.5}
                      />
                    ) : targetNode.kind === "worker" && sourceNode.kind === "core" ? (
                      <circle
                        cx={a.x}
                        cy={a.y}
                        r={2.2}
                        className="fill-background stroke-foreground/30"
                        strokeWidth={1.25}
                      />
                    ) : null}
                  </g>
                );
              })}
            </svg>

            {/* Center Friday Hub (Standby Anchor before first prompt) */}
            {coreNode === null ? (
              <div
                data-friday-node="core-empty"
                style={{ left: "0px", top: "12px" }}
                className="absolute z-10 flex w-64 -translate-x-1/2 -translate-y-1/2 flex-col gap-2.5 rounded-2xl border border-border/50 bg-popover px-4 py-3.5 shadow-xl"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="inline-flex size-4.5 shrink-0 items-center justify-center rounded-sm bg-foreground text-background"
                    >
                      <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor">
                        <rect x="1" y="1" width="4" height="4" rx="1" />
                        <rect x="7" y="1" width="4" height="4" rx="1" opacity="0.45" />
                        <rect x="1" y="7" width="4" height="4" rx="1" opacity="0.45" />
                        <rect x="7" y="7" width="4" height="4" rx="1" />
                      </svg>
                    </span>
                    <span className="text-sm font-semibold tracking-tight text-foreground">
                      <T>Friday</T>
                    </span>
                  </div>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          onClick={() => void handleCycleCoreModel()}
                          className="max-w-32 cursor-pointer truncate rounded bg-foreground/6 px-1.5 py-0.5 font-mono text-3xs text-muted-foreground transition-colors hover:bg-foreground/12 hover:text-foreground"
                        >
                          {activeModelLabel}
                        </button>
                      }
                    />
                    <TooltipPopup>
                      <T>Switch Friday core model</T>
                    </TooltipPopup>
                  </Tooltip>
                </div>
                <div className="text-xs leading-relaxed text-muted-foreground">
                  <T>
                    Ready across{" "}
                    <strong className="font-semibold text-foreground">
                      <Var>{snapshot.projects.length}</Var>
                    </strong>{" "}
                    local projects. Send an instruction below to launch your hub.
                  </T>
                </div>
                <div className="flex items-center justify-between border-t border-foreground/8 pt-2">
                  <span className="font-mono text-3xs text-muted-foreground">
                    <T>
                      Shift <Var>{snapshot.config.shiftNumber}</Var> · standby
                    </T>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setMemoryDraft(snapshot.memoryMarkdown);
                      setMemoryModalOpen(true);
                    }}
                    className="cursor-pointer rounded px-1.5 py-0.5 text-2xs font-medium text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground"
                  >
                    <T>Playbook →</T>
                  </button>
                </div>
              </div>
            ) : null}

            {/* Live Spatial Nodes */}
            {snapshot.nodes.map((node) => {
              const pos = resolvedPositions.get(node.id) ?? { x: 0, y: 0 };
              const visible = isNodeVisible(node);
              const selected = selectedNodeId === node.id;

              if (node.kind === "core") {
                return (
                  <div
                    key={node.id}
                    data-friday-node={node.id}
                    style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
                    onPointerEnter={() => setHoveredNodeId(node.id)}
                    onPointerLeave={() => setHoveredNodeId((cur) => (cur === node.id ? null : cur))}
                    onPointerDown={(event) => startNodePointer(event, node, pos)}
                    onPointerMove={(event) => moveNodePointer(event, node)}
                    onPointerUp={(event) => endNodePointer(event, node)}
                    className={cn(
                      "absolute z-10 flex w-60 -translate-x-1/2 -translate-y-1/2 cursor-pointer flex-col gap-2 rounded-2xl border border-border/50 bg-popover px-3.5 py-3 shadow-xl transition-shadow",
                      selected && "border-foreground/25",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className="inline-flex size-4.5 shrink-0 items-center justify-center rounded-sm bg-foreground text-background"
                        >
                          <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor">
                            <rect x="1" y="1" width="4" height="4" rx="1" />
                            <rect x="7" y="1" width="4" height="4" rx="1" opacity="0.45" />
                            <rect x="1" y="7" width="4" height="4" rx="1" opacity="0.45" />
                            <rect x="7" y="7" width="4" height="4" rx="1" />
                          </svg>
                        </span>
                        <span className="text-sm font-semibold tracking-tight text-foreground">
                          {node.title}
                        </span>
                      </div>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              onClick={() => void handleCycleCoreModel()}
                              className="max-w-28 cursor-pointer truncate rounded bg-foreground/6 px-1.5 py-0.5 font-mono text-3xs text-muted-foreground transition-colors hover:bg-foreground/12 hover:text-foreground"
                            >
                              {node.model}
                            </button>
                          }
                        />
                        <TooltipPopup>
                          <T>Switch Friday core model</T>
                        </TooltipPopup>
                      </Tooltip>
                    </div>

                    <div className="text-xs text-muted-foreground">
                      {needsHumanCount > 0 ? (
                        <T>
                          <strong className="font-semibold text-foreground">
                            <Var>{activeCount}</Var>
                          </strong>{" "}
                          active ·{" "}
                          <strong className="font-semibold text-foreground">
                            <Var>{needsHumanCount}</Var>
                          </strong>{" "}
                          needs you
                        </T>
                      ) : (
                        <T>
                          <strong className="font-semibold text-foreground">
                            <Var>{activeCount}</Var>
                          </strong>{" "}
                          active · all clear
                        </T>
                      )}
                    </div>

                    <div className="flex items-center justify-between gap-2 border-t border-foreground/8 pt-2">
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="shrink-0 font-mono text-3xs tabular-nums text-muted-foreground">
                          <T>
                            Shift <Var>{snapshot.config.shiftNumber}</Var> · <Var>{coreUsage}</Var>%
                          </T>
                        </span>
                        <span className="block h-0.5 flex-1 overflow-hidden rounded-full bg-foreground/10">
                          <span
                            className={cn(
                              "block h-full rounded-full transition-[width]",
                              coreUsage >= 65 ? "bg-warning" : "bg-foreground/65",
                            )}
                            style={{ width: `${Math.min(100, Math.max(4, coreUsage))}%` }}
                          />
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setRolloverModalOpen(true)}
                        className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-2xs font-medium text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground"
                      >
                        <T>Shift →</T>
                      </button>
                    </div>
                  </div>
                );
              }

              if (node.kind === "reviewer") {
                const dotClass =
                  node.status === "needs_human"
                    ? "bg-destructive"
                    : node.status === "completed"
                      ? "bg-success"
                      : "bg-warning";
                return (
                  <div
                    key={node.id}
                    data-friday-node={node.id}
                    style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
                    onPointerEnter={() => setHoveredNodeId(node.id)}
                    onPointerLeave={() => setHoveredNodeId((cur) => (cur === node.id ? null : cur))}
                    onPointerDown={(event) => startNodePointer(event, node, pos)}
                    onPointerMove={(event) => moveNodePointer(event, node)}
                    onPointerUp={(event) => endNodePointer(event, node)}
                    className={cn(
                      "absolute z-5 inline-flex -translate-x-2.5 -translate-y-1/2 cursor-pointer items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-3xs whitespace-nowrap text-muted-foreground transition-colors hover:bg-foreground/6 hover:text-foreground",
                      selected && "bg-foreground/8 text-foreground",
                      !visible && "pointer-events-none opacity-15",
                    )}
                  >
                    <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dotClass)} />
                    <span>
                      ↳ {node.title} · {node.statusDetail}
                    </span>
                  </div>
                );
              }

              if (node.status === "needs_human" && node.pendingDecision !== null) {
                const decision = node.pendingDecision;
                const isBusy = decidingNodeId === node.id;
                return (
                  <div
                    key={node.id}
                    data-friday-node={node.id}
                    style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
                    onPointerEnter={() => setHoveredNodeId(node.id)}
                    onPointerLeave={() => setHoveredNodeId((cur) => (cur === node.id ? null : cur))}
                    onPointerDown={(event) => startNodePointer(event, node, pos)}
                    onPointerMove={(event) => moveNodePointer(event, node)}
                    onPointerUp={(event) => endNodePointer(event, node)}
                    className={cn(
                      "absolute z-10 flex w-60 -translate-x-1/2 -translate-y-1/2 cursor-pointer flex-col gap-1.5 rounded-xl border border-border/50 bg-popover px-3.5 py-3 shadow-lg transition-shadow",
                      selected && "border-foreground/25",
                      !visible && "pointer-events-none opacity-15",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2 text-3xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
                        <span aria-hidden className="size-1.5 rounded-full bg-destructive" />
                        <span className="truncate">{decision.kicker}</span>
                      </span>
                      <span className="truncate font-mono">{node.projectTitle}</span>
                    </div>
                    <div className="truncate text-sm font-semibold tracking-tight text-foreground">
                      {node.title}
                    </div>
                    <div className="line-clamp-2 text-2xs leading-snug text-muted-foreground">
                      {decision.question}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {decision.options.length > 0 ? (
                        decision.options.map((option, index) => (
                          <button
                            key={option.id}
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleInlineDecision(node, option)}
                            className={cn(
                              "cursor-pointer rounded-md px-2.5 py-1 text-2xs font-medium transition-opacity disabled:opacity-50",
                              index === 0
                                ? "bg-foreground text-background hover:opacity-85"
                                : "bg-foreground/8 text-foreground hover:bg-foreground/14",
                            )}
                          >
                            {option.label}
                          </button>
                        ))
                      ) : (
                        <button
                          type="button"
                          onClick={() => setSelectedNodeId(node.id)}
                          className="cursor-pointer rounded-md bg-foreground px-2.5 py-1 text-2xs font-medium text-background transition-opacity hover:opacity-85"
                        >
                          <T>Answer →</T>
                        </button>
                      )}
                    </div>
                  </div>
                );
              }

              // Calm borderless ambient stream node (running / reviewing / completed / failed)
              const alignLeft = pos.x < -12;
              return (
                <div
                  key={node.id}
                  data-friday-node={node.id}
                  style={{
                    left: `${pos.x}px`,
                    top: `${pos.y}px`,
                    transform: alignLeft
                      ? "translate(calc(-100% + 16px), -50%)"
                      : "translate(-16px, -50%)",
                  }}
                  onPointerEnter={() => setHoveredNodeId(node.id)}
                  onPointerLeave={() => setHoveredNodeId((cur) => (cur === node.id ? null : cur))}
                  onPointerDown={(event) => startNodePointer(event, node, pos)}
                  onPointerMove={(event) => moveNodePointer(event, node)}
                  onPointerUp={(event) => endNodePointer(event, node)}
                  className={cn(
                    "absolute z-5 flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-foreground/5",
                    alignLeft && "flex-row-reverse text-right",
                    selected && "bg-foreground/8",
                    !visible && "pointer-events-none opacity-15",
                  )}
                >
                  <span className="relative z-10 inline-flex h-4.5 w-3.5 shrink-0 items-center justify-center">
                    {node.status === "completed" ? (
                      <span className="inline-flex size-3.5 items-center justify-center rounded-full bg-background">
                        <CheckIcon aria-hidden className="size-3 text-success" />
                      </span>
                    ) : node.status === "failed" ? (
                      <span className="size-2 rounded-full bg-destructive" />
                    ) : (
                      <span
                        aria-hidden
                        className={cn(
                          "size-3 animate-spin rounded-full border-2 border-foreground/15 bg-background",
                          node.status === "reviewing" ? "border-t-warning" : "border-t-foreground",
                        )}
                      />
                    )}
                  </span>
                  <div className="flex min-w-0 max-w-52 flex-col gap-0.5">
                    <div
                      className={cn(
                        "truncate leading-tight tracking-tight",
                        node.status === "completed"
                          ? "text-xs font-normal text-muted-foreground"
                          : "text-sm font-medium text-foreground",
                      )}
                    >
                      {node.title}
                    </div>
                    <div className="truncate font-mono text-3xs text-muted-foreground">
                      {node.statusDetail}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Quiet Monochrome Zoom Controls (Desktop) */}
          <div className="absolute bottom-4 left-4 z-15 hidden items-center gap-0.5 sm:inline-flex">
            <button
              type="button"
              aria-label={gt("Zoom out")}
              onClick={() =>
                setCamera((current) => ({
                  ...current,
                  scale: Math.max(0.45, current.scale * 0.87),
                }))
              }
              className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/7 hover:text-foreground"
            >
              <MinusIcon aria-hidden className="size-3.5" />
            </button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => fitCameraToCanvas(resolvedPositions)}
                    className="h-7 cursor-pointer rounded-md px-2 font-mono text-2xs tabular-nums text-muted-foreground transition-colors hover:bg-foreground/7 hover:text-foreground"
                  >
                    {Math.round(camera.scale * 100)}%
                  </button>
                }
              />
              <TooltipPopup>
                <T>Fit to canvas</T>
              </TooltipPopup>
            </Tooltip>
            <button
              type="button"
              aria-label={gt("Zoom in")}
              onClick={() =>
                setCamera((current) => ({
                  ...current,
                  scale: Math.min(1.6, current.scale * 1.15),
                }))
              }
              className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/7 hover:text-foreground"
            >
              <PlusIcon aria-hidden className="size-3.5" />
            </button>
            {Object.keys(snapshot.config.nodePositions).length > 0 ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={gt("Reset node positions")}
                      onClick={() => void handleResetLayout()}
                      className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/7 hover:text-foreground"
                    >
                      <RotateCcwIcon aria-hidden className="size-3" />
                    </button>
                  }
                />
                <TooltipPopup>
                  <T>Reset custom node positions</T>
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </div>

          {/* Floating Bottom T3-Native Matte Composer (hidden while right drawer composer is open) */}
          {selectedNode === null ? (
            <div className="absolute bottom-3.5 left-1/2 z-20 flex w-full max-w-lg -translate-x-1/2 flex-col items-center gap-1.5 px-3">
              {quickSuggestions.length > 0 && workers.length === 0 ? (
                <div className="hidden flex-wrap justify-center gap-3 sm:flex">
                  {quickSuggestions.map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      disabled={submitting}
                      onClick={() => void handleDispatchPrompt(item.prompt)}
                      className="cursor-pointer text-2xs text-muted-foreground/80 transition-colors hover:text-foreground disabled:opacity-50"
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              ) : null}
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleDispatchPrompt();
                }}
                className="flex w-full items-center gap-2 rounded-xl border border-border/60 bg-popover py-1.5 pr-1.5 pl-3.5 shadow-lg focus-within:border-foreground/25"
              >
                <input
                  type="text"
                  value={composerText}
                  onChange={(event) => setComposerText(event.target.value)}
                  disabled={submitting}
                  placeholder={gt("Direct Friday across your projects...")}
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                />
                <button
                  type="submit"
                  disabled={submitting || composerText.trim().length === 0}
                  aria-label={gt("Send to Friday")}
                  className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-foreground text-background transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-35"
                >
                  <ArrowUpIcon aria-hidden className="size-3.5" />
                </button>
              </form>
            </div>
          ) : null}

          {/* Classic List Overlay */}
          {classicListOpen ? (
            <div className="scrollbar-gutter-both absolute inset-0 z-25 overflow-y-auto bg-background px-5 py-4">
              <div className="mx-auto flex max-w-2xl flex-col gap-1">
                {snapshot.nodes.length === 0 ? (
                  <div className="py-12 text-center text-xs text-muted-foreground">
                    <T>No active Friday threads yet. Send an instruction below to start.</T>
                  </div>
                ) : (
                  snapshot.nodes
                    .filter((node) => node.kind !== "reviewer")
                    .map((node) => (
                      <button
                        key={node.id}
                        type="button"
                        onClick={() => {
                          setClassicListOpen(false);
                          setSelectedNodeId(node.id);
                        }}
                        className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-foreground/5"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-foreground">
                            {node.title}
                          </div>
                          <div className="truncate font-mono text-3xs text-muted-foreground">
                            {node.statusDetail}
                          </div>
                        </div>
                        <span
                          className={cn(
                            "size-2 shrink-0 rounded-full",
                            node.status === "needs_human" || node.status === "failed"
                              ? "bg-destructive"
                              : node.status === "completed"
                                ? "bg-success"
                                : node.status === "reviewing"
                                  ? "bg-warning"
                                  : "bg-foreground/45",
                          )}
                        />
                      </button>
                    ))
                )}
                {workspaceEnvironmentId !== null && coreNode !== null ? (
                  <div className="mt-4 flex justify-end">
                    <button
                      type="button"
                      onClick={() =>
                        void navigate({
                          to: "/$environmentId/$threadId",
                          params: {
                            environmentId: workspaceEnvironmentId,
                            threadId: coreNode.threadId,
                          },
                        })
                      }
                      className="cursor-pointer rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-foreground/6 hover:text-foreground"
                    >
                      <T>Open Friday thread in Classic mode →</T>
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Right Slide-Over Native Thread Inspector Drawer */}
          {workspaceEnvironmentId !== null ? (
            <FridayThreadDrawer
              environmentId={workspaceEnvironmentId}
              node={selectedNode}
              onClose={() => setSelectedNodeId(null)}
            />
          ) : null}

          {/* Soft Rollover Modal (Option B: Same-Thread freshContext) */}
          {rolloverModalOpen ? (
            <div className="absolute inset-0 z-40 flex items-center justify-center bg-background/75 p-4">
              <div className="flex w-full max-w-md flex-col gap-3 rounded-2xl border border-border/60 bg-popover p-5 shadow-2xl">
                <div>
                  <h3 className="text-sm font-semibold tracking-tight text-foreground">
                    <T>
                      Soft Rollover · Shift <Var>{snapshot.config.shiftNumber}</Var> →{" "}
                      <Var>{snapshot.config.shiftNumber + 1}</Var>
                    </T>
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    <T>
                      Starts a fresh provider context on the same permanent Friday hub thread using
                      native <code className="font-mono text-2xs">freshContext</code>, keeping all
                      live subagent callbacks connected.
                    </T>
                  </p>
                </div>
                <pre className="max-h-40 overflow-y-auto rounded-lg bg-foreground/5 p-3 font-mono text-3xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
                  {[
                    `1. FRIDAY.md (${String(snapshot.memoryMarkdown.split("\n").length)} lines)`,
                    `2. Registered local projects (${String(snapshot.projects.length)})`,
                    `3. Live topology digest (${String(workers.length)} workers, ${String(needsHumanCount)} needs you)`,
                    ...workers
                      .filter((worker) => worker.status !== "completed")
                      .slice(0, 6)
                      .map((worker) => `   · [${worker.status}] ${worker.title}`),
                  ].join("\n")}
                </pre>
                <input
                  type="text"
                  value={rolloverNote}
                  onChange={(event) => setRolloverNote(event.target.value)}
                  placeholder={gt("Optional focus note for the new shift...")}
                  className="w-full rounded-lg border border-transparent bg-foreground/6 px-3 py-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/25"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setRolloverModalOpen(false)}
                    className="cursor-pointer rounded-lg bg-foreground/8 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-foreground/14"
                  >
                    <T>Cancel</T>
                  </button>
                  <button
                    type="button"
                    disabled={rollingOver || snapshot.coreThreadId === null}
                    onClick={() => void handleConfirmRollover()}
                    className="cursor-pointer rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-85 disabled:opacity-45"
                  >
                    {rollingOver ? <T>Rolling over...</T> : <T>Confirm Rollover</T>}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {/* FRIDAY.md White-Box Editor Modal */}
          {memoryModalOpen ? (
            <div className="absolute inset-0 z-40 flex items-center justify-center bg-background/75 p-4">
              <div className="flex w-full max-w-lg flex-col gap-3 rounded-2xl border border-border/60 bg-popover p-5 shadow-2xl">
                <div>
                  <h3 className="font-mono text-sm font-semibold text-foreground">
                    <T>FRIDAY.md</T>
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    <T>
                      White-box operational memory stored under your T3 state directory. Loaded
                      automatically on initialization and every shift rollover.
                    </T>
                  </p>
                </div>
                <textarea
                  value={memoryDraft}
                  onChange={(event) => setMemoryDraft(event.target.value)}
                  rows={9}
                  className="w-full resize-y rounded-lg border border-transparent bg-foreground/5 p-3 font-mono text-2xs leading-relaxed text-foreground outline-none focus:border-foreground/25"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setMemoryModalOpen(false)}
                    className="cursor-pointer rounded-lg bg-foreground/8 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-foreground/14"
                  >
                    <T>Cancel</T>
                  </button>
                  <button
                    type="button"
                    disabled={savingMemory}
                    onClick={() => void handleSaveMemory()}
                    className="cursor-pointer rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-85 disabled:opacity-45"
                  >
                    {savingMemory ? <T>Saving...</T> : <T>Save</T>}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </SidebarInset>
    </TooltipProvider>
  );
}
