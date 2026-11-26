import { useAtomValue } from "@effect/atom-react";
import type {
  ConnectionCatalogEntry,
  PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { prepareEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { HttpMethod } from "effect/http";
import { Atom, AtomRegistry } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSummaries } from "../state/presentation";
import { localEnvironmentIdAtom, primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import {
  environmentSession,
  readPreparedConnection,
  usePreparedConnection,
} from "../state/session";
import { readDesktopPrimaryBearerToken } from "./primary/desktopAuth";
import { isLoopbackHostname, resolvePrimaryEnvironmentHttpUrl } from "./primary/target";

function isLoopbackUrl(rawUrl: string | null | undefined): boolean {
  if (!rawUrl) return false;
  try {
    return isLoopbackHostname(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

function catalogEntryHttpBaseUrl(entry: ConnectionCatalogEntry | undefined): string | null {
  if (!entry) return null;
  if (entry.target._tag === "PrimaryConnectionTarget") {
    return entry.target.httpBaseUrl;
  }
  if (Option.isSome(entry.profile) && entry.profile.value._tag === "BearerConnectionProfile") {
    return entry.profile.value.httpBaseUrl;
  }
  return null;
}

export function resolveWorkspaceEnvironmentId(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly localEnvironmentId: EnvironmentId | null;
  readonly connectedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly catalogEntries: ReadonlyMap<
    EnvironmentId,
    { readonly httpBaseUrl: string | null } | undefined
  >;
  readonly preparedHttpBaseUrlById?: ReadonlyMap<EnvironmentId, string | null>;
}): EnvironmentId | null {
  if (input.primaryEnvironmentId !== null) {
    return input.primaryEnvironmentId;
  }
  if (input.localEnvironmentId !== null) {
    return input.localEnvironmentId;
  }
  const hasLoopbackUrl = (environmentId: EnvironmentId): boolean =>
    isLoopbackUrl(input.preparedHttpBaseUrlById?.get(environmentId)) ||
    isLoopbackUrl(input.catalogEntries.get(environmentId)?.httpBaseUrl);

  for (const environmentId of input.connectedEnvironmentIds) {
    if (hasLoopbackUrl(environmentId)) {
      return environmentId;
    }
  }
  if (input.connectedEnvironmentIds.length > 0) {
    return input.connectedEnvironmentIds[0] ?? null;
  }
  for (const [environmentId] of input.catalogEntries) {
    if (hasLoopbackUrl(environmentId)) {
      return environmentId;
    }
  }
  for (const [environmentId] of input.catalogEntries) {
    return environmentId;
  }
  return null;
}

/**
 * Resolves the active local/standalone workspace environment for Friday and Auto-Review.
 * Falls back gracefully when Desktop disables its bundled local server (`localEnvironmentEnabled: false`)
 * and connects to a standalone `t3 serve` instance or linked environment instead.
 */
const workspaceEnvironmentIdAtom = Atom.make((get) => {
  const primaryEnvironmentId = get(primaryEnvironmentIdAtom);
  const localEnvironmentId = get(localEnvironmentIdAtom);
  const connectedEnvironmentIds = get(environmentSummaries.connectedEnvironmentIdsAtom);
  const catalogEntries = get(environmentCatalog.catalogValueAtom).entries;

  const entryHttpUrls = new Map<EnvironmentId, { readonly httpBaseUrl: string | null }>();
  const preparedHttpBaseUrlById = new Map<EnvironmentId, string | null>();
  for (const [environmentId, entry] of catalogEntries) {
    entryHttpUrls.set(environmentId, { httpBaseUrl: catalogEntryHttpBaseUrl(entry) });
    const prepared = get(environmentSession.preparedConnectionValueAtom(environmentId));
    preparedHttpBaseUrlById.set(
      environmentId,
      Option.isSome(prepared) ? prepared.value.httpBaseUrl : null,
    );
  }

  return resolveWorkspaceEnvironmentId({
    primaryEnvironmentId,
    localEnvironmentId,
    connectedEnvironmentIds,
    catalogEntries: entryHttpUrls,
    preparedHttpBaseUrlById,
  });
}).pipe(Atom.withLabel("web-workspace-environment-id"));

function readWorkspaceEnvironmentId(): EnvironmentId | null {
  return appAtomRegistry.get(workspaceEnvironmentIdAtom);
}

function workspaceConnectionKey(
  environmentId: EnvironmentId | null,
  prepared: PreparedConnection | null,
): string | null {
  if (environmentId === null) return null;
  if (prepared === null) return `${environmentId}|pending`;
  const authTag = prepared.httpAuthorization?._tag ?? "cookie";
  return `${environmentId}|${prepared.httpBaseUrl}|${authTag}`;
}

export function useWorkspacePreparedConnection(): {
  readonly environmentId: EnvironmentId | null;
  readonly prepared: PreparedConnection | null;
  readonly connectionKey: string | null;
} {
  const environmentId = useAtomValue(workspaceEnvironmentIdAtom);
  const preparedOption = usePreparedConnection(environmentId);
  const prepared = Option.getOrNull(preparedOption);
  return {
    environmentId,
    prepared,
    connectionKey: workspaceConnectionKey(environmentId, prepared),
  };
}

function normalizeHttpMethod(method: string | undefined): HttpMethod.HttpMethod {
  const upper = (method ?? "GET").toUpperCase();
  switch (upper) {
    case "GET":
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
    case "HEAD":
    case "OPTIONS":
      return upper;
    default:
      return "GET";
  }
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

async function prepareDpopRequest(input: {
  readonly prepared: PreparedConnection;
  readonly method: HttpMethod.HttpMethod;
  readonly pathname: string;
  readonly rejectedAccessToken?: string;
}) {
  const requestAtom = connectionAtomRuntime.atom(prepareEnvironmentHttpRequest(input));
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, requestAtom, { suspendOnWaiting: true }),
  );
}

/**
 * Authenticated HTTP fetch against the active workspace environment (supports primary cookie,
 * Desktop local bearer, standalone LaunchAgent Bearer/DPoP, SSH tunnel, and Relay DPoP).
 */
export async function fetchWorkspaceEnvironment(
  pathname: string,
  init: RequestInit = {},
  targetEnvironmentId?: EnvironmentId | null,
): Promise<Response> {
  const environmentId = targetEnvironmentId ?? readWorkspaceEnvironmentId();
  const prepared = environmentId !== null ? readPreparedConnection(environmentId) : null;

  if (prepared !== null) {
    const auth = prepared.httpAuthorization;
    if (auth === null) {
      return fetch(new URL(pathname, prepared.httpBaseUrl).toString(), {
        ...init,
        credentials: "include",
      });
    }
    if (auth._tag === "Bearer") {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${auth.token}`);
      return fetch(new URL(pathname, prepared.httpBaseUrl).toString(), {
        ...init,
        headers,
        credentials: "omit",
      });
    }
    const method = normalizeHttpMethod(init.method);
    const firstAuth = await prepareDpopRequest({ prepared, method, pathname });
    const firstHeaders = new Headers(init.headers);
    if (firstAuth.headers.authorization) {
      firstHeaders.set("Authorization", firstAuth.headers.authorization);
    }
    if (firstAuth.headers.dpop) {
      firstHeaders.set("DPoP", firstAuth.headers.dpop);
    }
    const firstResponse = await fetch(firstAuth.url, {
      ...init,
      headers: firstHeaders,
      credentials: firstAuth.credentials,
    });
    if (firstResponse.status === 401 && firstAuth.accessToken !== undefined) {
      const renewedAuth = await prepareDpopRequest({
        prepared,
        method,
        pathname,
        rejectedAccessToken: firstAuth.accessToken,
      });
      const renewedHeaders = new Headers(init.headers);
      if (renewedAuth.headers.authorization) {
        renewedHeaders.set("Authorization", renewedAuth.headers.authorization);
      }
      if (renewedAuth.headers.dpop) {
        renewedHeaders.set("DPoP", renewedAuth.headers.dpop);
      }
      return fetch(renewedAuth.url, {
        ...init,
        headers: renewedHeaders,
        credentials: renewedAuth.credentials,
      });
    }
    return firstResponse;
  }

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
