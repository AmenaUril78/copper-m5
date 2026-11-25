// The golden set itself: it must be well formed, and the facts it relies on
// must match the demo orders and the refund rule, so a wrong expectation is
// caught here and not by a confusing failed eval.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@/lib/copper/refunds",
  async () => import("@/evals/fake-refund-store"),
);

import { GOLDEN_SET } from "@/evals/golden-set";
import {
  allRefunds,
  refundsForOrder,
  resetStore,
} from "@/evals/fake-refund-store";
import { requestRefund } from "@/lib/copper/refund-service";

describe("golden set", () => {
  it("has at least ten unique questions, each with an expectation", () => {
    expect(GOLDEN_SET.length).toBeGreaterThanOrEqual(10);
    const ids = GOLDEN_SET.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of GOLDEN_SET) {
      expect(c.question.trim().length, c.id).toBeGreaterThan(5);
      expect(c.expectation.trim().length, c.id).toBeGreaterThan(20);
    }
  });

  it("covers shopping, refunds and safety", () => {
    const categories = new Set(GOLDEN_SET.map((c) => c.category));
    expect(categories).toEqual(new Set(["shopping", "refund", "safety"]));
  });

  it("the refund rule really gives the outcome each case expects", async () => {
    // For every case that names an order and an outcome of approved, pending or
    // rejected, ask for the refund directly and compare.
    for (const c of GOLDEN_SET) {
      if (!c.refundOutcome || c.refundOutcome.status === "none") continue;
      resetStore();
      const r = await requestRefund({
        orderId: c.refundOutcome.orderId,
        reason: "test",
      });
      const saved = refundsForOrder(c.refundOutcome.orderId).at(-1)?.status;
      expect(r.status, c.id).toBe(c.refundOutcome.status);
      expect(saved, c.id).toBe(c.refundOutcome.status);
    }
  });
});

describe("fake refund store", () => {
  beforeEach(resetStore);

  it("starts clean after every reset, so questions can't affect each other", async () => {
    await requestRefund({ orderId: "1004", reason: "test" });
    expect(allRefunds()).toHaveLength(1);
    resetStore();
    expect(allRefunds()).toHaveLength(0);
    const again = await requestRefund({ orderId: "1004", reason: "test" });
    expect(again.status).toBe("approved");
  });

  it("matches the seed: an unknown order is not found", async () => {
    expect((await requestRefund({ orderId: "9999", reason: "x" })).status).toBe(
      "not_found",
    );
  });
});
