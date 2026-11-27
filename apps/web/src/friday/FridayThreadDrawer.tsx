import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, FridayGraphNode, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { ArrowUpRightIcon, XIcon } from "lucide-react";

import ChatView from "../components/ChatView";
import { useOpenThreadFamily } from "../components/ThreadRouteView";
import { BackgroundThreadContext } from "../components/chat/backgroundThread";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { ComposerHandleContext } from "../composerHandleContext";
import type { SideChatParentPanel } from "../lib/sideChatPane";
import { useQuietThreadShell } from "../state/entities";
import { useEnvironmentShellStatus } from "../state/shell";
import { useEnvironmentThread } from "../state/threads";
import { isThreadRouteSnapshotAuthoritative } from "../threadRoutes";

export function FridayThreadDrawer({
  environmentId,
  node,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly node: FridayGraphNode | null;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const threadId: ThreadId | null = node?.threadId ?? null;
  const threadRef = threadId === null ? null : scopeThreadRef(environmentId, threadId);
  const shell = useQuietThreadShell(threadRef);
  const bootstrapComplete = isThreadRouteSnapshotAuthoritative(
    useEnvironmentShellStatus(environmentId),
  );
  // Ensure even idle/completed subagents or archived reviewer threads load their projection cleanly.
  useEnvironmentThread(
    threadId !== null && shell === null ? environmentId : null,
    threadId !== null && shell === null ? threadId : null,
  );
  useOpenThreadFamily(threadRef, bootstrapComplete && threadRef !== null && shell === null);

  const openFullThread = () => {
    if (threadId === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    });
  };

  if (node === null || threadId === null || threadRef === null) {
    return null;
  }

  const embeddedPanel: SideChatParentPanel = {
    hostRef: threadRef,
    openToolDiff: () => openFullThread(),
    runShellCommand: () => openFullThread(),
  };

  return (
    <aside
      data-side-chat-pane=""
      aria-label={node.title}
      className="absolute inset-y-2.5 right-2.5 left-2.5 z-30 flex select-text flex-col overflow-hidden rounded-2xl border border-border/60 bg-popover shadow-2xl [-webkit-app-region:no-drag] sm:left-auto sm:w-full sm:max-w-xl"
    >
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {node.status === "running" || node.status === "reviewing" ? (
              <span
                aria-hidden
                className="size-3 shrink-0 animate-spin rounded-full border-2 border-foreground/20 border-t-foreground"
              />
            ) : node.status === "needs_human" || node.status === "failed" ? (
              <span aria-hidden className="size-2 shrink-0 rounded-full bg-destructive" />
            ) : null}
            <div className="truncate text-sm font-semibold tracking-tight text-foreground">
              {node.title}
            </div>
          </div>
          <div className="mt-0.5 truncate font-mono text-2xs text-muted-foreground">
            {node.projectTitle} · {node.providerInstanceId} · {node.model}
            {node.branch ? ` · ${node.branch}` : ""}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={openFullThread}
                  className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground"
                >
                  <span>
                    <T>Open</T>
                  </span>
                  <ArrowUpRightIcon aria-hidden className="size-3.5" />
                </button>
              }
            />
            <TooltipPopup side="bottom">
              <T>Open full thread view</T>
            </TooltipPopup>
          </Tooltip>
          <button
            type="button"
            onClick={onClose}
            aria-label={gt("Close inspector")}
            className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground"
          >
            <XIcon aria-hidden className="size-4" />
          </button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <BackgroundThreadContext value>
          <ComposerHandleContext value={null}>
            <ChatView
              key={threadId}
              environmentId={environmentId}
              threadId={threadId}
              routeKind="server"
              embedded={embeddedPanel}
              reserveTitleBarControlInset={false}
            />
          </ComposerHandleContext>
        </BackgroundThreadContext>
      </div>
    </aside>
  );
}
