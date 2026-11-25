import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AutoReviewConfigPatch,
  AutoReviewSnapshot,
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
import * as AutoReviewService from "./AutoReviewService.ts";

const encodeSnapshotJson = Schema.encodeEffect(Schema.fromJsonString(AutoReviewSnapshot));
const encodeErrorJson = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.String,
      reason: Schema.optional(Schema.String),
    }),
  ),
);
const decodeConfigPatch = Schema.decodeUnknownEffect(AutoReviewConfigPatch);

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

const jsonSnapshotResponse = (snapshot: AutoReviewSnapshot, status = 200) =>
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

const stateRoute = HttpRouter.add(
  "GET",
  "/api/auto-review/state",
  Effect.gen(function* () {
    yield* authenticateWithScope(AuthOrchestrationReadScope);
    const service = yield* AutoReviewService.AutoReviewService;
    const snapshot = yield* service.getSnapshot;
    return yield* jsonSnapshotResponse(snapshot);
  }),
);

const streamRoute = HttpRouter.add(
  "GET",
  "/api/auto-review/stream",
  Effect.gen(function* () {
    yield* authenticateWithScope(AuthOrchestrationReadScope);
    const service = yield* AutoReviewService.AutoReviewService;
    return eventStreamResponse(service.streamSnapshot, encodeSnapshotJson);
  }),
);

const updateConfigRoute = HttpRouter.add(
  "PUT",
  "/api/auto-review/config",
  Effect.gen(function* () {
    yield* authenticateWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const service = yield* AutoReviewService.AutoReviewService;
    const rawBody = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const decoded = yield* decodeConfigPatch(rawBody).pipe(Effect.result);
    if (decoded._tag === "Failure") {
      return yield* jsonErrorResponse({ error: "Invalid auto-review config patch." }, 400);
    }
    const snapshot = yield* service.updateConfig(decoded.success);
    return yield* jsonSnapshotResponse(snapshot);
  }),
);

const triggerReviewRoute = HttpRouter.add(
  "POST",
  "/api/auto-review/threads/:threadId/review",
  Effect.gen(function* () {
    yield* authenticateWithScope(AuthOrchestrationOperateScope);
    const params = yield* HttpRouter.params;
    const rawThreadId = params.threadId;
    if (typeof rawThreadId !== "string" || rawThreadId.trim().length === 0) {
      return yield* jsonErrorResponse({ error: "Missing threadId." }, 400);
    }
    const service = yield* AutoReviewService.AutoReviewService;
    const result = yield* service
      .triggerReview(ThreadId.make(decodeURIComponent(rawThreadId)))
      .pipe(Effect.result);
    if (result._tag === "Failure") {
      const status =
        result.failure.reason === "thread_not_found"
          ? 404
          : result.failure.reason === "launch_failed"
            ? 500
            : 409;
      return yield* jsonErrorResponse(
        { error: result.failure.detail, reason: result.failure.reason },
        status,
      );
    }
    return yield* jsonSnapshotResponse(result.success, 202);
  }),
);

const acknowledgeRoute = HttpRouter.add(
  "POST",
  "/api/auto-review/threads/:threadId/acknowledge",
  Effect.gen(function* () {
    yield* authenticateWithScope(AuthOrchestrationOperateScope);
    const params = yield* HttpRouter.params;
    const rawThreadId = params.threadId;
    if (typeof rawThreadId !== "string" || rawThreadId.trim().length === 0) {
      return yield* jsonErrorResponse({ error: "Missing threadId." }, 400);
    }
    const service = yield* AutoReviewService.AutoReviewService;
    const snapshot = yield* service.acknowledgeThread(
      ThreadId.make(decodeURIComponent(rawThreadId)),
    );
    return yield* jsonSnapshotResponse(snapshot);
  }),
);

export const layer = Layer.mergeAll(
  stateRoute,
  streamRoute,
  updateConfigRoute,
  triggerReviewRoute,
  acknowledgeRoute,
);
