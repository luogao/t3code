import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveWorkspaceEnvironmentId } from "./workspaceHttp";

const PRIMARY = EnvironmentId.make("primary");
const LOCAL = EnvironmentId.make("local-service");
const STANDALONE = EnvironmentId.make("standalone-13773");
const REMOTE = EnvironmentId.make("remote-vps");

describe("resolveWorkspaceEnvironmentId", () => {
  it("prefers the primary environment when present", () => {
    expect(
      resolveWorkspaceEnvironmentId({
        primaryEnvironmentId: PRIMARY,
        localEnvironmentId: LOCAL,
        connectedEnvironmentIds: [STANDALONE, PRIMARY],
        catalogEntries: new Map([
          [PRIMARY, { httpBaseUrl: "http://127.0.0.1:3773/" }],
          [STANDALONE, { httpBaseUrl: "http://127.0.0.1:13773/" }],
        ]),
      }),
    ).toBe(PRIMARY);
  });

  it("prefers a connected loopback standalone server when localEnvironmentEnabled is false", () => {
    expect(
      resolveWorkspaceEnvironmentId({
        primaryEnvironmentId: null,
        localEnvironmentId: null,
        connectedEnvironmentIds: [REMOTE, STANDALONE],
        catalogEntries: new Map([
          [REMOTE, { httpBaseUrl: "https://vps.example.com/" }],
          [STANDALONE, { httpBaseUrl: "http://127.0.0.1:13773/" }],
        ]),
        preparedHttpBaseUrlById: new Map([
          [REMOTE, "https://vps.example.com/"],
          [STANDALONE, "http://127.0.0.1:13773/"],
        ]),
      }),
    ).toBe(STANDALONE);
  });

  it("falls back to the first connected remote environment when no loopback exists", () => {
    expect(
      resolveWorkspaceEnvironmentId({
        primaryEnvironmentId: null,
        localEnvironmentId: null,
        connectedEnvironmentIds: [REMOTE],
        catalogEntries: new Map([[REMOTE, { httpBaseUrl: "https://vps.example.com/" }]]),
      }),
    ).toBe(REMOTE);
  });

  it("falls back to a loopback catalog entry while connections are still coming up", () => {
    expect(
      resolveWorkspaceEnvironmentId({
        primaryEnvironmentId: null,
        localEnvironmentId: null,
        connectedEnvironmentIds: [],
        catalogEntries: new Map([
          [REMOTE, { httpBaseUrl: "https://vps.example.com/" }],
          [STANDALONE, { httpBaseUrl: "http://localhost:13773/" }],
        ]),
      }),
    ).toBe(STANDALONE);
  });

  it("returns null when no environments are configured", () => {
    expect(
      resolveWorkspaceEnvironmentId({
        primaryEnvironmentId: null,
        localEnvironmentId: null,
        connectedEnvironmentIds: [],
        catalogEntries: new Map(),
      }),
    ).toBeNull();
  });
});
