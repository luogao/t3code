import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  it("disables only rename where no inline title editor exists", () => {
    const items = buildThreadActionMenuItems({ ...baseState, canRename: false });
    expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(["rename"]);
  });

  it("exposes auto-review submenu actions and keeps transcript inspection enabled when read-only", () => {
    const reviewerId = ThreadId.make("thread:auto-review:1");
    const items = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      autoReview: {
        status: "needs_human",
        reviewerThreadId: reviewerId,
        override: "enabled",
      },
    });
    const autoReviewMenu = items.find((item) => item.id === "auto-review");
    expect(autoReviewMenu).toBeDefined();
    expect(autoReviewMenu?.disabled).toBe(false);
    expect(
      autoReviewMenu?.children?.find((c) => c.id === "auto-review:open-reviewer")?.disabled,
    ).toBeFalsy();
    expect(autoReviewMenu?.children?.find((c) => c.id === "auto-review:trigger")?.disabled).toBe(
      true,
    );
    expect(
      autoReviewMenu?.children?.find((c) => c.id === "auto-review:acknowledge")?.disabled,
    ).toBe(true);
    expect(autoReviewMenu?.children?.find((c) => c.id === "auto-review:enabled")?.checked).toBe(
      true,
    );
  });
});
