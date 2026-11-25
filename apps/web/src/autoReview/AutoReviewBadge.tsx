import type { AutoReviewThreadState } from "@t3tools/contracts";
import {
  AlertTriangleIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useGT } from "gt-react";

import { Badge } from "~/components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

export function AutoReviewBadge(props: {
  readonly state: AutoReviewThreadState | null | undefined;
  readonly compact?: boolean;
}) {
  const { state, compact = false } = props;
  const gt = useGT();
  if (!state) return null;

  const presentation =
    state.status === "reviewing"
      ? {
          variant: "info" as const,
          label: gt("Reviewing"),
          icon: <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />,
        }
      : state.status === "reworking"
        ? {
            variant: "warning" as const,
            label: gt("Rework {round}/{max}", {
              round: state.reworkCount,
              max: state.maxReworkRounds,
            }),
            icon: <RotateCcwIcon aria-hidden className="size-3" />,
          }
        : state.status === "approved"
          ? {
              variant: "success" as const,
              label: gt("Reviewed"),
              icon: <ShieldCheckIcon aria-hidden className="size-3" />,
            }
          : state.status === "needs_human"
            ? {
                variant: "error" as const,
                label: gt("Needs you"),
                icon: <ShieldAlertIcon aria-hidden className="size-3" />,
              }
            : {
                variant: "error" as const,
                label: gt("Review failed"),
                icon: <AlertTriangleIcon aria-hidden className="size-3" />,
              };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            size="sm"
            variant={presentation.variant}
            data-testid={`auto-review-badge-${state.status}`}
            className="shrink-0 select-none"
          >
            {presentation.icon}
            {compact && state.status === "approved" ? null : <span>{presentation.label}</span>}
          </Badge>
        }
      />
      <TooltipPopup
        side="top"
        className="max-w-72 text-left whitespace-normal"
        onContextMenu={(event) => event.stopPropagation()}
      >
        <div className="flex flex-col gap-1 text-xs">
          <div className="font-medium text-foreground">{presentation.label}</div>
          {state.summary ? <div className="text-muted-foreground">{state.summary}</div> : null}
          {state.status === "needs_human" &&
          state.humanQuestion &&
          state.humanQuestion !== state.summary ? (
            <div className="border-t border-border/60 pt-1 text-foreground">
              {state.humanQuestion}
            </div>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

export function AutoReviewTooltipDetail(props: {
  readonly state: AutoReviewThreadState | null | undefined;
}) {
  const { state } = props;
  const gt = useGT();
  if (!state) return null;

  const heading =
    state.status === "reviewing"
      ? gt("Auto-review in progress")
      : state.status === "reworking"
        ? gt("Auto-review rework ({round}/{max})", {
            round: state.reworkCount,
            max: state.maxReworkRounds,
          })
        : state.status === "approved"
          ? gt("Auto-review approved")
          : state.status === "needs_human"
            ? gt("Auto-review needs your decision")
            : gt("Auto-review failed");

  const toneClass =
    state.status === "approved"
      ? "text-success-foreground"
      : state.status === "needs_human" || state.status === "failed"
        ? "text-error-foreground"
        : state.status === "reworking"
          ? "text-warning-foreground"
          : "text-info-foreground";

  return (
    <div className="flex min-w-0 flex-col gap-0.5 border-t border-border/60 pt-1.5">
      <div className={cn("flex items-center gap-1.5 font-medium", toneClass)}>
        {state.status === "approved" ? (
          <ShieldCheckIcon aria-hidden className="size-3 shrink-0" />
        ) : state.status === "needs_human" || state.status === "failed" ? (
          <ShieldAlertIcon aria-hidden className="size-3 shrink-0" />
        ) : state.status === "reworking" ? (
          <RotateCcwIcon aria-hidden className="size-3 shrink-0" />
        ) : (
          <LoaderCircleIcon aria-hidden className="size-3 shrink-0 animate-spin" />
        )}
        <span className="min-w-0 truncate">{heading}</span>
      </div>
      {state.summary ? (
        <div className="line-clamp-3 text-muted-foreground">{state.summary}</div>
      ) : null}
      {state.status === "needs_human" &&
      state.humanQuestion &&
      state.humanQuestion !== state.summary ? (
        <div className="line-clamp-3 text-foreground/90">{state.humanQuestion}</div>
      ) : null}
    </div>
  );
}
