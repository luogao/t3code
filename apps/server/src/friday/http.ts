import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  FridayDecideThreadInput,
  FridayRolloverInput,
  FridaySendPromptInput,
  FridaySnapshot,
  FridayUpdateCoreModelInput,
  FridayUpdateLayoutInput,
  FridayUpdateMemoryInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import { eventStreamResponse } from "../eventStreamResponse.ts";
import * as FridayService from "./FridayService.ts";

const encodeSnapshotJson = Schema.encodeEffect(Schema.fromJsonString(FridaySnapshot));
const encodeErrorJson = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.String,
      reason: Schema.optional(Schema.String),
    }),
  ),
);

const decodeSendPrompt = Schema.decodeUnknownEffect(FridaySendPromptInput);
const decodeRollover = Schema.decodeUnknownEffect(FridayRolloverInput);
const decodeUpdateMemory = Schema.decodeUnknownEffect(FridayUpdateMemoryInput);
const decodeUpdateLayout = Schema.decodeUnknownEffect(FridayUpdateLayoutInput);
const decodeUpdateCoreModel = Schema.decodeUnknownEffect(FridayUpdateCoreModelInput);
const decodeDecideThread = Schema.decodeUnknownEffect(FridayDecideThreadInput);

const authenticateWithScope = Effect.fnUntraced(function* (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(
        EnvironmentAuth.serverAuthCredentialReason(error),
        EnvironmentAuth.serverAuthDpopFailureReason(error),
      ),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(scope)) {
    return yield* failEnvironmentScopeRequired(scope);
  }
});

const jsonSnapshotResponse = (snapshot: FridaySnapshot, status = 200) =>
  encodeSnapshotJson(snapshot).pipe(
    Effect.map((body) =>
      HttpServerResponse.text(body, {
        status,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
      }),
    ),
    Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
  );

const jsonErrorResponse = (
  payload: { readonly error: string; readonly reason?: string },
  status: number,
) =>
  encodeErrorJson(payload).pipe(
    Effect.map((body) =>
      HttpServerResponse.text(body, {
        status,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
      }),
    ),
    Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
  );

function statusForFridayError(reason: FridayService.FridayActionError["reason"]): number {
  switch (reason) {
    case "thread_not_found":
      return 404;
    case "invalid_request":
      return 400;
    case "no_project":
    case "no_provider":
    case "core_missing":
      return 409;
    case "dispatch_failed":
      return 500;
  }
}

const stateRoute = HttpRouter.add(
  "GET",
  "/api/friday/state",
  Effect.gen(function* () {
    yield* authenticateWithScope(AuthOrchestrationReadScope);
    const service = yield* FridayService.FridayService;
    const snapshot = yield* service.getSnapshot;
    return yield* jsonSnapshotResponse(snapshot);
  }),
);

const streamRoute = HttpRouter.add(
  "GET",
  "/api/friday/stream",
  Effect.gen(function* () {
    yield* authenticateWithScope(AuthOrchestrationReadScope);
    const service = yield* FridayService.FridayService;
    return eventStreamResponse(service.streamSnapshot, encodeSnapshotJson);
  }),
);

const promptRoute = HttpRouter.add(
  "POST",
  "/api/friday/prompt",
  Effect.gen(function* () {
    yield* authenticateWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rawBody = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const decoded = yield* decodeSendPrompt(rawBody).pipe(Effect.result);
    if (decoded._tag === "Failure") {
      return yield* jsonErrorResponse({ error: "Invalid Friday prompt payload." }, 400);
    }
    const service = yield* FridayService.FridayService;
    const result = yield* service.sendPrompt(decoded.success).pipe(Effect.result);
    if (result._tag === "Failure") {
      return yield* jsonErrorResponse(
        { error: result.failure.detail, reason: result.failure.reason },
        statusForFridayError(result.failure.reason),
      );
    }
    return yield* jsonSnapshotResponse(result.success, 202);
  }),
);

const rolloverRoute = HttpRouter.add(
  "POST",
  "/api/friday/rollover",
  Effect.gen(function* () {
    yield* authenticateWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rawBody = yield* request.json.pipe(Effect.orElseSucceed(() => ({})));
    const decoded = yield* decodeRollover(rawBody ?? {}).pipe(Effect.result);
    if (decoded._tag === "Failure") {
      return yield* jsonErrorResponse({ error: "Invalid Friday rollover payload." }, 400);
    }
    const service = yield* FridayService.FridayService;
    const result = yield* service.rollover(decoded.success).pipe(Effect.result);
    if (result._tag === "Failure") {
      return yield* jsonErrorResponse(
        { error: result.failure.detail, reason: result.failure.reason },
        statusForFridayError(result.failure.reason),
      );
    }
    return yield* jsonSnapshotResponse(result.success, 202);
  }),
);

const memoryRoute = HttpRouter.add(
  "PUT",
  "/api/friday/memory",
  Effect.gen(function* () {
    yield* authenticateWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rawBody = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const decoded = yield* decodeUpdateMemory(rawBody).pipe(Effect.result);
    if (decoded._tag === "Failure") {
      return yield* jsonErrorResponse({ error: "Invalid Friday memory payload." }, 400);
    }
    const service = yield* FridayService.FridayService;
    const snapshot = yield* service.updateMemory(decoded.success.markdown);
    return yield* jsonSnapshotResponse(snapshot);
  }),
);

const layoutRoute = HttpRouter.add(
  "PUT",
  "/api/friday/layout",
  Effect.gen(function* () {
    yield* authenticateWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rawBody = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const decoded = yield* decodeUpdateLayout(rawBody).pipe(Effect.result);
    if (decoded._tag === "Failure") {
      return yield* jsonErrorResponse({ error: "Invalid Friday layout payload." }, 400);
    }
    const service = yield* FridayService.FridayService;
    const snapshot = yield* service.updateLayout(decoded.success.positions);
    return yield* jsonSnapshotResponse(snapshot);
  }),
);

const modelRoute = HttpRouter.add(
  "PUT",
  "/api/friday/model",
  Effect.gen(function* () {
    yield* authenticateWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rawBody = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const decoded = yield* decodeUpdateCoreModel(rawBody).pipe(Effect.result);
    if (decoded._tag === "Failure") {
      return yield* jsonErrorResponse({ error: "Invalid Friday model payload." }, 400);
    }
    const service = yield* FridayService.FridayService;
    const result = yield* service
      .updateCoreModel(decoded.success.modelSelection)
      .pipe(Effect.result);
    if (result._tag === "Failure") {
      return yield* jsonErrorResponse(
        { error: result.failure.detail, reason: result.failure.reason },
        statusForFridayError(result.failure.reason),
      );
    }
    return yield* jsonSnapshotResponse(result.success);
  }),
);

const decideThreadRoute = HttpRouter.add(
  "POST",
  "/api/friday/threads/:threadId/decide",
  Effect.gen(function* () {
    yield* authenticateWithScope(AuthOrchestrationOperateScope);
    const params = yield* HttpRouter.params;
    const rawThreadId = params.threadId;
    if (typeof rawThreadId !== "string" || rawThreadId.trim().length === 0) {
      return yield* jsonErrorResponse({ error: "Missing threadId." }, 400);
    }
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rawBody = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const decoded = yield* decodeDecideThread(rawBody).pipe(Effect.result);
    if (decoded._tag === "Failure") {
      return yield* jsonErrorResponse({ error: "Invalid Friday decision payload." }, 400);
    }
    const service = yield* FridayService.FridayService;
    const result = yield* service
      .decideThread(ThreadId.make(decodeURIComponent(rawThreadId)), decoded.success)
      .pipe(Effect.result);
    if (result._tag === "Failure") {
      return yield* jsonErrorResponse(
        { error: result.failure.detail, reason: result.failure.reason },
        statusForFridayError(result.failure.reason),
      );
    }
    return yield* jsonSnapshotResponse(result.success);
  }),
);

export const layer = Layer.mergeAll(
  stateRoute,
  streamRoute,
  promptRoute,
  rolloverRoute,
  memoryRoute,
  layoutRoute,
  modelRoute,
  decideThreadRoute,
);
