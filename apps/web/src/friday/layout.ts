import type { FridayGraphNode, FridayNodePosition } from "@t3tools/contracts";

export interface FridayCamera {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

const CORE_DEFAULT_POS: FridayNodePosition = { x: 0, y: 12 };

function spreadRowX(count: number, spacing: number): ReadonlyArray<number> {
  if (count <= 0) return [];
  if (count === 1) return [0];
  if (count === 2) return [-spacing / 2, spacing / 2];
  const totalWidth = (count - 1) * spacing;
  return Array.from({ length: count }, (_, index) => Math.round(-totalWidth / 2 + index * spacing));
}

/**
 * Deterministic architectural zone layout for Friday: center core, upper needs_human shelf,
 * lower ambient streams, top completed archive, and offset reviewer QA branches.
 * Persisted drag coordinates (`node.position`) always override auto-layout.
 */
export function computeFridayNodePositions(
  nodes: ReadonlyArray<FridayGraphNode>,
): ReadonlyMap<string, FridayNodePosition> {
  const positions = new Map<string, FridayNodePosition>();

  const core = nodes.find((node) => node.kind === "core");
  if (core !== undefined) {
    positions.set(core.id, core.position ?? CORE_DEFAULT_POS);
  }

  const workers = nodes.filter((node) => node.kind === "worker");
  const needsHuman = workers.filter((node) => node.status === "needs_human");
  const activeAmbient = workers.filter(
    (node) => node.status === "running" || node.status === "reviewing" || node.status === "failed",
  );
  const completed = workers.filter((node) => node.status === "completed");

  const needsXs = spreadRowX(needsHuman.length, 320);
  needsHuman.forEach((node, index) => {
    positions.set(
      node.id,
      node.position ?? {
        x: needsXs[index] ?? 0,
        y: -148,
      },
    );
  });

  // Lower ambient streams: first two flank left/right cleanly, third anchors center-bottom spine,
  // additional streams expand cleanly in lower tiers.
  activeAmbient.forEach((node, index) => {
    if (node.position !== null) {
      positions.set(node.id, node.position);
      return;
    }
    if (activeAmbient.length === 1) {
      positions.set(node.id, { x: 0, y: 158 });
      return;
    }
    if (index === 0) {
      positions.set(node.id, { x: -188, y: 128 });
    } else if (index === 1) {
      positions.set(node.id, { x: 188, y: 128 });
    } else if (index === 2) {
      positions.set(node.id, { x: 0, y: 188 });
    } else {
      const extraIndex = index - 3;
      const tier = Math.floor(extraIndex / 2);
      const side = extraIndex % 2 === 0 ? -1 : 1;
      positions.set(node.id, { x: side * 224, y: 214 + tier * 72 });
    }
  });

  const completedXs = spreadRowX(completed.length, 210);
  completed.forEach((node, index) => {
    positions.set(
      node.id,
      node.position ?? {
        x: completedXs[index] ?? 0,
        y: needsHuman.length > 0 ? -236 : -148,
      },
    );
  });

  const reviewers = nodes.filter((node) => node.kind === "reviewer");
  for (const reviewer of reviewers) {
    if (reviewer.position !== null) {
      positions.set(reviewer.id, reviewer.position);
      continue;
    }
    const parentPos =
      reviewer.parentId !== null ? positions.get(reviewer.parentId) : CORE_DEFAULT_POS;
    const base = parentPos ?? CORE_DEFAULT_POS;
    if (base.y < 0) {
      positions.set(reviewer.id, { x: base.x - 84, y: base.y - 86 });
    } else {
      positions.set(reviewer.id, { x: base.x + 152, y: base.y + 44 });
    }
  }

  return positions;
}

/** Smooth rounded-corner orthogonal wire matching architectural engineering diagrams. */
export function buildSmoothElbowPath(a: FridayNodePosition, b: FridayNodePosition): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) < 8 || Math.abs(dy) < 8) {
    return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  }
  const midY = a.y + dy * 0.52;
  const radius = Math.min(14, Math.abs(dx) / 2, Math.abs(midY - a.y), Math.abs(b.y - midY));
  const sx = dx > 0 ? 1 : -1;
  const sy = dy > 0 ? 1 : -1;
  return [
    `M ${a.x} ${a.y}`,
    `L ${a.x} ${midY - sy * radius}`,
    `Q ${a.x} ${midY}, ${a.x + sx * radius} ${midY}`,
    `L ${b.x - sx * radius} ${midY}`,
    `Q ${b.x} ${midY}, ${b.x} ${midY + sy * radius}`,
    `L ${b.x} ${b.y}`,
  ].join(" ");
}

export function computeEdgeEndpoints(input: {
  readonly sourceNode: FridayGraphNode;
  readonly sourcePos: FridayNodePosition;
  readonly targetNode: FridayGraphNode;
  readonly targetPos: FridayNodePosition;
}): { readonly a: FridayNodePosition; readonly b: FridayNodePosition } {
  let ax = input.sourcePos.x;
  let ay = input.sourcePos.y;
  let bx = input.targetPos.x;
  let by = input.targetPos.y;

  if (input.sourceNode.kind === "core") {
    const dy = input.targetPos.y - input.sourcePos.y;
    const dx = input.targetPos.x - input.sourcePos.x;
    if (Math.abs(dy) > 40) {
      ay = input.sourcePos.y + (dy < 0 ? -74 : 74);
      ax = input.sourcePos.x + Math.max(-88, Math.min(88, dx * 0.24));
    } else {
      ax = input.sourcePos.x + (dx < 0 ? -144 : 144);
    }
  } else if (input.sourceNode.status === "needs_human") {
    ay = input.sourcePos.y + (input.targetPos.y < input.sourcePos.y ? -56 : 56);
  }

  if (input.targetNode.kind === "worker") {
    if (input.targetNode.status === "needs_human") {
      by = input.targetPos.y + 58;
    } else {
      by = input.targetPos.y - 7;
    }
  }

  return { a: { x: ax, y: ay }, b: { x: bx, y: by } };
}

export function computeAutoFitCamera(input: {
  readonly positions: ReadonlyMap<string, FridayNodePosition>;
  readonly width: number;
  readonly height: number;
}): FridayCamera {
  const isMobile = input.width < 600;
  const topClear = isMobile ? 56 : 64;
  const bottomClear = isMobile ? 76 : 104;
  const availW = Math.max(260, input.width - (isMobile ? 24 : 48));
  const availH = Math.max(240, input.height - topClear - bottomClear);

  if (input.positions.size <= 1) {
    return {
      x: input.width / 2,
      y: topClear + availH / 2,
      scale: 1,
    };
  }

  let minX = -150;
  let maxX = 150;
  let minY = -120;
  let maxY = 120;
  for (const pos of input.positions.values()) {
    minX = Math.min(minX, pos.x - 160);
    maxX = Math.max(maxX, pos.x + 160);
    minY = Math.min(minY, pos.y - 70);
    maxY = Math.max(maxY, pos.y + 70);
  }

  const spanW = Math.max(480, maxX - minX);
  const spanH = Math.max(360, maxY - minY);
  const scale = Math.max(0.46, Math.min(1, availW / spanW, availH / spanH));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  return {
    x: input.width / 2 - centerX * scale,
    y: topClear + availH / 2 - centerY * scale,
    scale,
  };
}
