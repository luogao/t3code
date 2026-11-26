import type { FridayGraphNode, FridayProjectSummary } from "@t3tools/contracts";

export const FRIDAY_CORE_THREAD_TITLE = "Friday";

export const DEFAULT_FRIDAY_MEMORY_MARKDOWN = `# FRIDAY Operations Playbook

- Role: You are Friday, the persistent cross-project orchestrator hub for this workspace.
- Cross-project dispatch: Use \`delegate_task\` with \`target: { projectId, providerInstanceId, model }\` to dispatch work to any registered local project. Use \`isolation: "worktree"\` for code edits so parallel agents never collide.
- Parallelism & restraint: Split independent tasks cleanly across projects/models; keep your own replies crisp, executive, and action-oriented.
- Escalation: Surface trade-offs, destructive operations, PR merges, main pushes, or schema migrations for explicit human approval before executing.
`;

function formatProjectCatalog(projects: ReadonlyArray<FridayProjectSummary>): string {
  if (projects.length === 0) {
    return "- (No registered projects yet)";
  }
  return projects
    .map((project) => `- \`${project.id}\` | ${project.title} | \`${project.workspaceRoot}\``)
    .join("\n");
}

function formatTopologyDigest(nodes: ReadonlyArray<FridayGraphNode>): string {
  const workers = nodes.filter((node) => node.kind === "worker");
  if (workers.length === 0) {
    return "- (No active delegated worker nodes yet)";
  }
  return workers
    .slice(0, 24)
    .map((node) => {
      const branchPart = node.branch ? ` [${node.branch}]` : "";
      const decisionPart = node.pendingDecision
        ? ` | NEEDS_HUMAN: ${node.pendingDecision.question}`
        : "";
      return `- [${node.status}] ${node.title} (${node.projectTitle}${branchPart}, ${node.providerInstanceId}/${node.model}, thread=${node.threadId})${decisionPart}`;
    })
    .join("\n");
}

export function buildFridayInitialPrompt(input: {
  readonly userText: string;
  readonly memoryMarkdown: string;
  readonly projects: ReadonlyArray<FridayProjectSummary>;
  readonly shiftNumber: number;
}): string {
  return [
    `<friday_context shift="${String(input.shiftNumber)}">`,
    "You are Friday, the user's persistent cross-project orchestration hub inside T3 Code.",
    "Follow the playbook below and use `delegate_task` with `target.projectId` whenever dispatching work to a specific registered local project.",
    "",
    "## FRIDAY.md",
    input.memoryMarkdown.trim() || DEFAULT_FRIDAY_MEMORY_MARKDOWN.trim(),
    "",
    "## Registered Local Projects",
    formatProjectCatalog(input.projects),
    "</friday_context>",
    "",
    input.userText.trim(),
  ].join("\n");
}

export function buildFridayRolloverPrompt(input: {
  readonly shiftNumber: number;
  readonly memoryMarkdown: string;
  readonly projects: ReadonlyArray<FridayProjectSummary>;
  readonly nodes: ReadonlyArray<FridayGraphNode>;
  readonly note?: string | undefined;
}): string {
  const noteSection =
    input.note !== undefined && input.note.trim().length > 0
      ? ["", "## User Shift Note", input.note.trim()]
      : [];

  return [
    `<friday_shift_handoff shift="${String(input.shiftNumber)}">`,
    "You are continuing as Friday in a fresh context shift on the same permanent hub thread.",
    "All active delegated child tasks remain linked to this thread and will report back here.",
    "",
    "## FRIDAY.md",
    input.memoryMarkdown.trim() || DEFAULT_FRIDAY_MEMORY_MARKDOWN.trim(),
    "",
    "## Registered Local Projects",
    formatProjectCatalog(input.projects),
    "",
    "## Live Topology Digest",
    formatTopologyDigest(input.nodes),
    ...noteSection,
    "</friday_shift_handoff>",
    "",
    "Acknowledge shift readiness briefly in 1-2 sentences and highlight anything currently waiting for human decision.",
  ].join("\n");
}
