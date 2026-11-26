import {
  IsoDateTime,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FridayGraphNode,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildSmoothElbowPath, computeAutoFitCamera, computeFridayNodePositions } from "./layout";

function makeNode(id: string, overrides: Partial<FridayGraphNode> = {}): FridayGraphNode {
  return {
    id,
    threadId: ThreadId.make(id),
    kind: "worker",
    parentId: "core",
    projectId: ProjectId.make("project:test"),
    projectTitle: "openmotion",
    title: id,
    branch: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.3-codex",
    status: "running",
    statusDetail: "openmotion · codex · running",
    updatedAt: IsoDateTime.make("2026-11-26T09:30:00.000Z"),
    position: null,
    pendingDecision: null,
    autoReviewStatus: null,
    autoReviewSummary: null,
    latestMessagePreview: null,
    ...overrides,
  };
}

describe("Friday spatial layout", () => {
  it("zones core, needs_human priority shelf, ambient streams, completed archive, and reviewer moons", () => {
    const nodes: FridayGraphNode[] = [
      makeNode("core", { kind: "core", parentId: null, status: "core" }),
      makeNode("urgent-1", { status: "needs_human" }),
      makeNode("urgent-2", { status: "needs_human" }),
      makeNode("run-1", { status: "running" }),
      makeNode("run-2", { status: "reviewing" }),
      makeNode("done-1", { status: "completed" }),
      makeNode("reviewer:urgent-1", {
        kind: "reviewer",
        parentId: "urgent-1",
        status: "needs_human",
      }),
      makeNode("custom-pinned", { status: "running", position: { x: 310, y: 40 } }),
    ];

    const positions = computeFridayNodePositions(nodes);
    expect(positions.get("core")).toEqual({ x: 0, y: 12 });
    expect(positions.get("urgent-1")!.y).toBeLessThan(0);
    expect(positions.get("urgent-2")!.y).toBeLessThan(0);
    expect(positions.get("urgent-1")!.x).toBeLessThan(0);
    expect(positions.get("urgent-2")!.x).toBeGreaterThan(0);
    expect(positions.get("run-1")!.y).toBeGreaterThan(0);
    expect(positions.get("run-2")!.y).toBeGreaterThan(0);
    expect(positions.get("done-1")!.y).toBeLessThan(positions.get("urgent-1")!.y);
    expect(positions.get("reviewer:urgent-1")!.y).toBeLessThan(positions.get("urgent-1")!.y);
    // Persisted custom coordinates are honored verbatim.
    expect(positions.get("custom-pinned")).toEqual({ x: 310, y: 40 });

    const camera = computeAutoFitCamera({ positions, width: 1024, height: 720 });
    expect(camera.scale).toBeGreaterThanOrEqual(0.46);
    expect(camera.scale).toBeLessThanOrEqual(1);
  });

  it("produces orthogonal smooth-elbow paths and straight lines for aligned nodes", () => {
    expect(buildSmoothElbowPath({ x: 0, y: 0 }, { x: 0, y: 180 })).toBe("M 0 0 L 0 180");
    const elbow = buildSmoothElbowPath({ x: 0, y: 0 }, { x: 180, y: -140 });
    expect(elbow).toContain("Q ");
    expect(elbow.startsWith("M 0 0")).toBe(true);
    expect(elbow.endsWith("L 180 -140")).toBe(true);
  });
});
