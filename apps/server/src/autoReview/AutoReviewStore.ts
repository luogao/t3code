import {
  AutoReviewSnapshot,
  DEFAULT_AUTO_REVIEW_CONFIG,
  DEFAULT_AUTO_REVIEW_SNAPSHOT,
  clampAutoReviewConcurrency,
  clampAutoReviewRounds,
  type AutoReviewConfig,
  type AutoReviewConfigPatch,
  type AutoReviewThreadState,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as ServerConfig from "../config.ts";

const AUTO_REVIEW_STATE_FILE = "auto-review.json";
const MAX_STORED_REVIEWER_IDS = 500;

const decodeSnapshotJson = Schema.decodeUnknownEffect(Schema.fromJsonString(AutoReviewSnapshot));
const encodeSnapshotJson = Schema.encodeEffect(Schema.fromJsonString(AutoReviewSnapshot));

function applyOverridePatch(
  current: Readonly<Record<string, "enabled" | "disabled">>,
  patch: Readonly<Record<string, "enabled" | "disabled" | null>> | undefined,
): Record<string, "enabled" | "disabled"> {
  const next: Record<string, "enabled" | "disabled"> = { ...current };
  if (patch === undefined) return next;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}

function applyAutoReviewConfigPatch(
  current: AutoReviewConfig,
  patch: AutoReviewConfigPatch,
): AutoReviewConfig {
  return {
    enabled: patch.enabled ?? current.enabled,
    defaultProjectMode: patch.defaultProjectMode ?? current.defaultProjectMode,
    projectOverrides: applyOverridePatch(current.projectOverrides, patch.projectOverrides),
    threadOverrides: applyOverridePatch(current.threadOverrides, patch.threadOverrides),
    reviewerModel: patch.reviewerModel === undefined ? current.reviewerModel : patch.reviewerModel,
    maxReworkRounds:
      patch.maxReworkRounds === undefined
        ? current.maxReworkRounds
        : clampAutoReviewRounds(patch.maxReworkRounds),
    maxConcurrency:
      patch.maxConcurrency === undefined
        ? current.maxConcurrency
        : clampAutoReviewConcurrency(patch.maxConcurrency),
    customInstructions: patch.customInstructions ?? current.customInstructions,
  };
}

export class AutoReviewStore extends Context.Service<
  AutoReviewStore,
  {
    readonly getSnapshot: Effect.Effect<AutoReviewSnapshot>;
    readonly streamChanges: Stream.Stream<AutoReviewSnapshot>;
    readonly updateConfig: (patch: AutoReviewConfigPatch) => Effect.Effect<AutoReviewSnapshot>;
    readonly mutate: (
      updater: (current: AutoReviewSnapshot) => AutoReviewSnapshot,
    ) => Effect.Effect<AutoReviewSnapshot>;
    readonly getThreadState: (threadId: string) => Effect.Effect<AutoReviewThreadState | undefined>;
    readonly isReviewerThread: (threadId: string) => Effect.Effect<boolean>;
  }
>()("t3/autoReview/AutoReviewStore") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const statePath = path.join(config.stateDir, AUTO_REVIEW_STATE_FILE);
  const writeLock = yield* Semaphore.make(1);
  const pubsub = yield* PubSub.unbounded<AutoReviewSnapshot>();

  const loadInitial = Effect.gen(function* () {
    const exists = yield* fs.exists(statePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return DEFAULT_AUTO_REVIEW_SNAPSHOT;
    const raw = yield* fs.readFileString(statePath).pipe(Effect.orElseSucceed(() => ""));
    if (raw.trim().length === 0) return DEFAULT_AUTO_REVIEW_SNAPSHOT;
    return yield* decodeSnapshotJson(raw).pipe(
      Effect.map((decoded) => ({
        ...decoded,
        config: {
          ...DEFAULT_AUTO_REVIEW_CONFIG,
          ...decoded.config,
          maxReworkRounds: clampAutoReviewRounds(decoded.config.maxReworkRounds),
          maxConcurrency: clampAutoReviewConcurrency(decoded.config.maxConcurrency),
        },
      })),
      Effect.catch((error) =>
        Effect.logWarning("auto-review.store.load-failed", { statePath, error }).pipe(
          Effect.as(DEFAULT_AUTO_REVIEW_SNAPSHOT),
        ),
      ),
    );
  });

  const snapshotRef = yield* Ref.make(yield* loadInitial);

  const persistSnapshot = Effect.fn("AutoReviewStore.persistSnapshot")(function* (
    snapshot: AutoReviewSnapshot,
  ) {
    const trimmedReviewerIds =
      snapshot.reviewerThreadIds.length > MAX_STORED_REVIEWER_IDS
        ? snapshot.reviewerThreadIds.slice(-MAX_STORED_REVIEWER_IDS)
        : snapshot.reviewerThreadIds;
    const normalized: AutoReviewSnapshot =
      trimmedReviewerIds === snapshot.reviewerThreadIds
        ? snapshot
        : { ...snapshot, reviewerThreadIds: trimmedReviewerIds };
    const encoded = yield* encodeSnapshotJson(normalized).pipe(Effect.map((json) => `${json}\n`));
    const stamp = yield* Clock.currentTimeMillis;
    const nonce = (yield* randomUuidV4).slice(0, 8);
    const tmpPath = `${statePath}.tmp.${String(stamp)}.${nonce}`;
    yield* fs.makeDirectory(path.dirname(statePath), { recursive: true });
    yield* fs.writeFileString(tmpPath, encoded);
    yield* fs.rename(tmpPath, statePath);
    return normalized;
  });

  const mutate: AutoReviewStore["Service"]["mutate"] = Effect.fn("AutoReviewStore.mutate")(
    function* (updater) {
      return yield* writeLock.withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(snapshotRef);
          const candidate = updater(current);
          if (candidate === current) return current;
          const saved = yield* persistSnapshot(candidate).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("auto-review.store.persist-failed", { statePath, cause }).pipe(
                Effect.as(candidate),
              ),
            ),
          );
          yield* Ref.set(snapshotRef, saved);
          yield* PubSub.publish(pubsub, saved);
          return saved;
        }),
      );
    },
  );

  const updateConfig: AutoReviewStore["Service"]["updateConfig"] = Effect.fn(
    "AutoReviewStore.updateConfig",
  )(function* (patch) {
    return yield* mutate((current) => ({
      ...current,
      config: applyAutoReviewConfigPatch(current.config, patch),
    }));
  });

  const getSnapshot = Ref.get(snapshotRef);

  const streamChanges: Stream.Stream<AutoReviewSnapshot> = Stream.unwrap(
    Effect.gen(function* () {
      const live = Stream.fromPubSub(pubsub);
      const initial = yield* getSnapshot;
      return Stream.concat(Stream.make(initial), live);
    }),
  );

  const getThreadState = (threadId: string) =>
    Ref.get(snapshotRef).pipe(Effect.map((snapshot) => snapshot.threads[threadId]));

  const isReviewerThread = (threadId: string) =>
    Ref.get(snapshotRef).pipe(
      Effect.map((snapshot) => snapshot.reviewerThreadIds.includes(threadId)),
    );

  return {
    getSnapshot,
    streamChanges,
    updateConfig,
    mutate,
    getThreadState,
    isReviewerThread,
  } satisfies AutoReviewStore["Service"];
});

export const layer = Layer.effect(AutoReviewStore, make);
