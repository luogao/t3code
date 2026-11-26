import {
  AutoReviewSnapshot,
  DEFAULT_AUTO_REVIEW_SNAPSHOT,
  type AutoReviewConfigPatch,
  type AutoReviewThreadState,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";
import { useEffect, useSyncExternalStore } from "react";

import { fetchWorkspaceEnvironment } from "../environments/workspaceHttp";
import { m } from "../i18n/messages";

const decodeSnapshotUnknown = Schema.decodeUnknownSync(AutoReviewSnapshot);

let currentSnapshot: AutoReviewSnapshot = DEFAULT_AUTO_REVIEW_SNAPSHOT;
const listeners = new Set<() => void>();

function emitSnapshot(next: AutoReviewSnapshot): void {
  currentSnapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readAutoReviewSnapshot(): AutoReviewSnapshot {
  return currentSnapshot;
}

export function isAutoReviewNeedsHuman(
  state: Pick<AutoReviewThreadState, "status"> | null | undefined,
): boolean {
  return state?.status === "needs_human" || state?.status === "failed";
}

/**
 * Incrementally parses SSE text frames (`data: ...` separated by blank lines) and
 * returns all complete `data` payloads plus the trailing incomplete buffer.
 */
export function parseSseChunkBuffer(buffer: string): {
  readonly messages: ReadonlyArray<string>;
  readonly remainder: string;
} {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const remainder = blocks.pop() ?? "";
  const messages: string[] = [];
  for (const block of blocks) {
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length > 0) {
      messages.push(dataLines.join("\n"));
    }
  }
  return { messages, remainder };
}

function tryDecodeSnapshotJson(raw: string): AutoReviewSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return decodeSnapshotUnknown(parsed);
  } catch {
    return null;
  }
}

let activeSubscribers = 0;
let activeEnvironmentId: EnvironmentId | null = null;
let activeConnectionKey: string | null = null;
let streamController: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function stopStreamLoop(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (streamController !== null) {
    streamController.abort();
    streamController = null;
  }
}

function startStreamLoop(backoffMs = 1000): void {
  if (
    activeSubscribers <= 0 ||
    activeEnvironmentId === null ||
    typeof window === "undefined" ||
    typeof fetch !== "function"
  ) {
    return;
  }
  const targetEnvironmentId = activeEnvironmentId;
  stopStreamLoop();
  const controller = new AbortController();
  streamController = controller;

  const scheduleReconnect = (nextBackoffMs: number) => {
    if (controller.signal.aborted || activeSubscribers <= 0) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      startStreamLoop(Math.min(nextBackoffMs * 2, 15_000));
    }, nextBackoffMs);
  };

  void (async () => {
    try {
      const response = await fetchWorkspaceEnvironment(
        "/api/auto-review/stream",
        {
          method: "GET",
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        },
        targetEnvironmentId,
      );
      if (!response.ok || response.body === null) {
        scheduleReconnect(backoffMs);
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let receivedAny = false;
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { messages, remainder } = parseSseChunkBuffer(buffer);
        buffer = remainder;
        for (const payload of messages) {
          const decoded = tryDecodeSnapshotJson(payload);
          if (decoded !== null) {
            receivedAny = true;
            emitSnapshot(decoded);
          }
        }
      }
      scheduleReconnect(receivedAny ? 1000 : backoffMs);
    } catch {
      if (!controller.signal.aborted) {
        scheduleReconnect(backoffMs);
      }
    }
  })();
}

export function useAutoReviewSubscription(
  environmentId: EnvironmentId | null,
  connectionKey: string | null = environmentId,
): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ref-counted SSE stream subscription lifecycle for the workspace environment's auto-review state
  useEffect(() => {
    if (environmentId === null) return;
    const connectionChanged =
      activeEnvironmentId !== environmentId || activeConnectionKey !== connectionKey;
    activeEnvironmentId = environmentId;
    activeConnectionKey = connectionKey;
    activeSubscribers += 1;
    if (activeSubscribers === 1 || connectionChanged) {
      startStreamLoop(1000);
    }
    return () => {
      activeSubscribers = Math.max(0, activeSubscribers - 1);
      if (activeSubscribers === 0) {
        activeEnvironmentId = null;
        activeConnectionKey = null;
        stopStreamLoop();
      }
    };
  }, [environmentId, connectionKey]);
}

export function useAutoReviewSnapshot(): AutoReviewSnapshot {
  return useSyncExternalStore(
    subscribe,
    readAutoReviewSnapshot,
    () => DEFAULT_AUTO_REVIEW_SNAPSHOT,
  );
}

async function parseJsonError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim().length > 0) {
      return body.error;
    }
  } catch {
    // ignore invalid JSON body
  }
  return m(msg("Request failed ({status})", { status: response.status }));
}

export async function updateAutoReviewConfig(
  patch: AutoReviewConfigPatch,
): Promise<AutoReviewSnapshot> {
  const response = await fetchWorkspaceEnvironment(
    "/api/auto-review/config",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
    activeEnvironmentId,
  );
  if (!response.ok) {
    throw new Error(await parseJsonError(response));
  }
  const decoded = decodeSnapshotUnknown(await response.json());
  emitSnapshot(decoded);
  return decoded;
}

export async function triggerThreadAutoReview(threadId: ThreadId): Promise<AutoReviewSnapshot> {
  const response = await fetchWorkspaceEnvironment(
    `/api/auto-review/threads/${encodeURIComponent(threadId)}/review`,
    {
      method: "POST",
    },
    activeEnvironmentId,
  );
  if (!response.ok) {
    throw new Error(await parseJsonError(response));
  }
  const decoded = decodeSnapshotUnknown(await response.json());
  emitSnapshot(decoded);
  return decoded;
}

export async function acknowledgeThreadAutoReview(threadId: ThreadId): Promise<AutoReviewSnapshot> {
  const response = await fetchWorkspaceEnvironment(
    `/api/auto-review/threads/${encodeURIComponent(threadId)}/acknowledge`,
    { method: "POST" },
    activeEnvironmentId,
  );
  if (!response.ok) {
    throw new Error(await parseJsonError(response));
  }
  const decoded = decodeSnapshotUnknown(await response.json());
  emitSnapshot(decoded);
  return decoded;
}
