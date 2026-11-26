import {
  DEFAULT_FRIDAY_SNAPSHOT,
  FridaySnapshot,
  type FridayDecideThreadInput,
  type FridayNodePosition,
  type FridayRolloverInput,
  type FridaySendPromptInput,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";
import { useEffect, useSyncExternalStore } from "react";

import { parseSseChunkBuffer } from "../autoReview/store";
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
import { m } from "../i18n/messages";

const decodeSnapshotUnknown = Schema.decodeUnknownSync(FridaySnapshot);

let currentSnapshot: FridaySnapshot = DEFAULT_FRIDAY_SNAPSHOT;
const listeners = new Set<() => void>();

function emitSnapshot(next: FridaySnapshot): void {
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

function readFridaySnapshot(): FridaySnapshot {
  return currentSnapshot;
}

function isSameOriginBrowserPrimary(): boolean {
  if (
    typeof window === "undefined" ||
    window.desktopBridge !== undefined ||
    !window.location.origin.startsWith("http")
  ) {
    return false;
  }
  try {
    return new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin === window.location.origin;
  } catch {
    return false;
  }
}

async function primaryFetch(pathname: string, init: RequestInit = {}): Promise<Response> {
  const url = resolvePrimaryEnvironmentHttpUrl(pathname);
  const headers = new Headers(init.headers);
  const sameOrigin = isSameOriginBrowserPrimary();
  if (!sameOrigin) {
    const token = await readDesktopPrimaryBearerToken().catch(() => null);
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }
  return fetch(url, {
    ...init,
    headers,
    credentials: sameOrigin ? "include" : "omit",
  });
}

function tryDecodeSnapshotJson(raw: string): FridaySnapshot | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return decodeSnapshotUnknown(parsed);
  } catch {
    return null;
  }
}

let activeSubscribers = 0;
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
  if (activeSubscribers <= 0 || typeof window === "undefined" || typeof fetch !== "function") {
    return;
  }
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
      const response = await primaryFetch("/api/friday/stream", {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
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

export function useFridaySubscription(enabled: boolean): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ref-counted SSE subscription lifecycle for the Friday orchestration graph
  useEffect(() => {
    if (!enabled) return;
    activeSubscribers += 1;
    if (activeSubscribers === 1) {
      startStreamLoop(1000);
    }
    return () => {
      activeSubscribers = Math.max(0, activeSubscribers - 1);
      if (activeSubscribers === 0) {
        stopStreamLoop();
      }
    };
  }, [enabled]);
}

export function useFridaySnapshot(): FridaySnapshot {
  return useSyncExternalStore(subscribe, readFridaySnapshot, () => DEFAULT_FRIDAY_SNAPSHOT);
}

async function parseJsonError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim().length > 0) {
      return body.error;
    }
  } catch {
    // ignore malformed error body
  }
  return m(msg("Request failed ({status})", { status: response.status }));
}

async function postOrPutSnapshot(
  pathname: string,
  method: "POST" | "PUT",
  body: unknown,
): Promise<FridaySnapshot> {
  const response = await primaryFetch(pathname, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await parseJsonError(response));
  }
  const decoded = decodeSnapshotUnknown(await response.json());
  emitSnapshot(decoded);
  return decoded;
}

export function sendFridayPrompt(input: FridaySendPromptInput): Promise<FridaySnapshot> {
  return postOrPutSnapshot("/api/friday/prompt", "POST", input);
}

export function rolloverFridayContext(input: FridayRolloverInput = {}): Promise<FridaySnapshot> {
  return postOrPutSnapshot("/api/friday/rollover", "POST", input);
}

export function updateFridayMemory(markdown: string): Promise<FridaySnapshot> {
  return postOrPutSnapshot("/api/friday/memory", "PUT", { markdown });
}

export function updateFridayLayout(
  positions: Readonly<Record<string, FridayNodePosition | null>>,
): Promise<FridaySnapshot> {
  return postOrPutSnapshot("/api/friday/layout", "PUT", { positions });
}

export function updateFridayCoreModel(modelSelection: ModelSelection): Promise<FridaySnapshot> {
  return postOrPutSnapshot("/api/friday/model", "PUT", { modelSelection });
}

export function decideFridayThread(
  threadId: ThreadId,
  input: FridayDecideThreadInput,
): Promise<FridaySnapshot> {
  return postOrPutSnapshot(
    `/api/friday/threads/${encodeURIComponent(threadId)}/decide`,
    "POST",
    input,
  );
}
