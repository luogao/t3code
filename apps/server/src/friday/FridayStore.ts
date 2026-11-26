import { DEFAULT_FRIDAY_CONFIG, FridayConfig, type FridayNodePosition } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as ServerConfig from "../config.ts";
import { DEFAULT_FRIDAY_MEMORY_MARKDOWN } from "./FridayPrompt.ts";

const FRIDAY_STATE_FILE = "friday.json";
const FRIDAY_MEMORY_FILE = "FRIDAY.md";
const MAX_STORED_POSITIONS = 250;

const decodeConfigJson = Schema.decodeUnknownEffect(Schema.fromJsonString(FridayConfig));
const encodeConfigJson = Schema.encodeEffect(Schema.fromJsonString(FridayConfig));

export interface FridayPersistedState {
  readonly config: FridayConfig;
  readonly memoryMarkdown: string;
}

export class FridayStore extends Context.Service<
  FridayStore,
  {
    readonly getState: Effect.Effect<FridayPersistedState>;
    readonly mutateConfig: (
      updater: (current: FridayConfig) => FridayConfig,
    ) => Effect.Effect<FridayPersistedState>;
    readonly updateMemory: (markdown: string) => Effect.Effect<FridayPersistedState>;
    readonly updateLayout: (
      positions: Readonly<Record<string, FridayNodePosition | null>>,
    ) => Effect.Effect<FridayPersistedState>;
  }
>()("t3/friday/FridayStore") {}

function trimNodePositions(
  positions: Readonly<Record<string, FridayNodePosition>>,
): Record<string, FridayNodePosition> {
  const entries = Object.entries(positions);
  if (entries.length <= MAX_STORED_POSITIONS) {
    return { ...positions };
  }
  return Object.fromEntries(entries.slice(-MAX_STORED_POSITIONS));
}

const make = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configPath = path.join(serverConfig.stateDir, FRIDAY_STATE_FILE);
  const memoryPath = path.join(serverConfig.stateDir, FRIDAY_MEMORY_FILE);
  const writeLock = yield* Semaphore.make(1);

  const atomicWrite = Effect.fn("FridayStore.atomicWrite")(function* (
    filePath: string,
    contents: string,
  ) {
    const stamp = yield* Clock.currentTimeMillis;
    const nonce = (yield* randomUuidV4).slice(0, 8);
    const tmpPath = `${filePath}.tmp.${String(stamp)}.${nonce}`;
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(tmpPath, contents);
    yield* fs.rename(tmpPath, filePath);
  });

  const loadInitialConfig = Effect.gen(function* () {
    const exists = yield* fs.exists(configPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return DEFAULT_FRIDAY_CONFIG;
    const raw = yield* fs.readFileString(configPath).pipe(Effect.orElseSucceed(() => ""));
    if (raw.trim().length === 0) return DEFAULT_FRIDAY_CONFIG;
    return yield* decodeConfigJson(raw).pipe(
      Effect.map((decoded) => ({
        ...DEFAULT_FRIDAY_CONFIG,
        ...decoded,
        shiftNumber: Math.max(1, decoded.shiftNumber),
      })),
      Effect.catch((error) =>
        Effect.logWarning("friday.store.load-config-failed", { configPath, error }).pipe(
          Effect.as(DEFAULT_FRIDAY_CONFIG),
        ),
      ),
    );
  });

  const loadInitialMemory = Effect.gen(function* () {
    const exists = yield* fs.exists(memoryPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      yield* atomicWrite(memoryPath, DEFAULT_FRIDAY_MEMORY_MARKDOWN).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("friday.store.seed-memory-failed", { memoryPath, cause }),
        ),
      );
      return DEFAULT_FRIDAY_MEMORY_MARKDOWN;
    }
    const raw = yield* fs
      .readFileString(memoryPath)
      .pipe(Effect.orElseSucceed(() => DEFAULT_FRIDAY_MEMORY_MARKDOWN));
    return raw;
  });

  const stateRef = yield* Ref.make<FridayPersistedState>({
    config: yield* loadInitialConfig,
    memoryMarkdown: yield* loadInitialMemory,
  });

  const persistConfig = Effect.fn("FridayStore.persistConfig")(function* (config: FridayConfig) {
    const normalized: FridayConfig = {
      ...config,
      shiftNumber: Math.max(1, config.shiftNumber),
      nodePositions: trimNodePositions(config.nodePositions),
    };
    const encoded = yield* encodeConfigJson(normalized).pipe(Effect.map((json) => `${json}\n`));
    yield* atomicWrite(configPath, encoded);
    return normalized;
  });

  const mutateConfig: FridayStore["Service"]["mutateConfig"] = Effect.fn(
    "FridayStore.mutateConfig",
  )(function* (updater) {
    return yield* writeLock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(stateRef);
        const candidate = updater(current.config);
        if (candidate === current.config) return current;
        const savedConfig = yield* persistConfig(candidate).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("friday.store.persist-config-failed", { configPath, cause }).pipe(
              Effect.as(candidate),
            ),
          ),
        );
        const next: FridayPersistedState = {
          ...current,
          config: savedConfig,
        };
        yield* Ref.set(stateRef, next);
        return next;
      }),
    );
  });

  const updateMemory: FridayStore["Service"]["updateMemory"] = Effect.fn(
    "FridayStore.updateMemory",
  )(function* (markdown) {
    return yield* writeLock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(stateRef);
        yield* atomicWrite(memoryPath, markdown).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("friday.store.persist-memory-failed", { memoryPath, cause }),
          ),
        );
        const next: FridayPersistedState = {
          ...current,
          memoryMarkdown: markdown,
        };
        yield* Ref.set(stateRef, next);
        return next;
      }),
    );
  });

  const updateLayout: FridayStore["Service"]["updateLayout"] = Effect.fn(
    "FridayStore.updateLayout",
  )(function* (positions) {
    return yield* mutateConfig((current) => {
      const nextPositions: Record<string, FridayNodePosition> = { ...current.nodePositions };
      for (const [nodeId, position] of Object.entries(positions)) {
        if (position === null) {
          delete nextPositions[nodeId];
        } else {
          nextPositions[nodeId] = {
            x: Math.round(position.x),
            y: Math.round(position.y),
          };
        }
      }
      return {
        ...current,
        nodePositions: nextPositions,
      };
    });
  });

  return {
    getState: Ref.get(stateRef),
    mutateConfig,
    updateMemory,
    updateLayout,
  } satisfies FridayStore["Service"];
});

export const layer = Layer.effect(FridayStore, make);
