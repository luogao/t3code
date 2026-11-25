import { describe, expect, it } from "vite-plus/test";

import { isAutoReviewNeedsHuman, parseSseChunkBuffer } from "./store";

describe("autoReview store helpers", () => {
  it("parses complete SSE frames across chunk boundaries and preserves incomplete remainders", () => {
    const first = parseSseChunkBuffer('data: {"version":1}\n\ndata: {"part":');
    expect(first.messages).toEqual(['{"version":1}']);
    expect(first.remainder).toBe('data: {"part":');

    const second = parseSseChunkBuffer(`${first.remainder}2}\r\n\r\n: keepalive\r\n\r\n`);
    expect(second.messages).toEqual(['{"part":2}']);
    expect(second.remainder).toBe("");
  });

  it("identifies statuses requiring human triage", () => {
    expect(isAutoReviewNeedsHuman({ status: "needs_human" })).toBe(true);
    expect(isAutoReviewNeedsHuman({ status: "failed" })).toBe(true);
    expect(isAutoReviewNeedsHuman({ status: "approved" })).toBe(false);
    expect(isAutoReviewNeedsHuman({ status: "reviewing" })).toBe(false);
    expect(isAutoReviewNeedsHuman({ status: "reworking" })).toBe(false);
    expect(isAutoReviewNeedsHuman(null)).toBe(false);
  });
});
