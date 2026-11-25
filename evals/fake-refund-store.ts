// An in-memory stand-in for lib/copper/refunds.ts, used only by the evals.
// It has the same functions and the same demo orders as supabase/seed.sql, so
// the agents behave as they do for real, but nothing here can read or change
// the real database. Call resetStore() before each question.
import type {
  DecidedBy,
  NewRefund,
  OrderRow,
  RefundRow,
  RefundStatus,
  RefundWithOrder,
} from "@/lib/copper/refunds";
import { DEFAULT_LIMIT_CENTS } from "@/lib/copper/refund-policy";

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) =>
  new Date(Date.now() - days * DAY).toISOString();

function seedOrders(): OrderRow[] {
  return [
    ["1001", "Maya Ortiz", "Copper Plus, monthly", 799, 4, false],
    ["1002", "Devon Reyes", "Copper Notes (Desert Sand)", 12900, 9, false],
    ["1003", "Priya Shah", "Copper Home (Night Sky)", 14900, 6, false],
    ["1004", "Sam Whitaker", "Copper Plus, monthly", 799, 3, false],
    ["1005", "Lena Park", "Copper Notes (Night Sky)", 12900, 60, false],
    ["1006", "Omar Haddad", "Copper Plus, monthly", 799, 20, true],
    ["1007", "Nora Whitfield", "Copper Plus, annual", 7900, 8, false],
    [
      "1008",
      "Jamal Brooks",
      "Copper Home (Polished Copper) + Copper Notes (Brushed Copper)",
      27800,
      5,
      false,
    ],
    [
      "1009",
      "Elena Vasquez",
      "Copper Notes (Brushed Copper)",
      12900,
      31,
      false,
    ],
  ].map(([id, name, items, cents, days, refunded]) => ({
    id: id as string,
    customer_name: name as string,
    items: items as string,
    amount_cents: cents as number,
    ordered_at: daysAgo(days as number),
    refunded: refunded as boolean,
  }));
}

let orders: OrderRow[] = seedOrders();
let refunds: RefundRow[] = [];
let limitCents = DEFAULT_LIMIT_CENTS;
let counter = 0;

/** Back to the seed data: nine orders, no refunds, a $50.00 limit. */
export function resetStore(): void {
  orders = seedOrders();
  refunds = [];
  limitCents = DEFAULT_LIMIT_CENTS;
  counter = 0;
}

/** The refunds saved for an order since the last reset (for the evals' checks). */
export function refundsForOrder(orderId: string): RefundRow[] {
  return refunds.filter((r) => r.order_id === orderId);
}

/** Every refund saved since the last reset. */
export function allRefunds(): RefundRow[] {
  return [...refunds];
}

// The functions below mirror lib/copper/refunds.ts.

export async function readOrder(
  id: string,
): Promise<OrderRow | "not_found" | null> {
  return orders.find((o) => o.id === id) ?? "not_found";
}

export async function markOrderRefunded(id: string): Promise<boolean> {
  const order = orders.find((o) => o.id === id);
  if (!order || order.refunded) return false;
  order.refunded = true;
  return true;
}

export async function createRefund(input: NewRefund): Promise<RefundRow> {
  counter += 1;
  const row: RefundRow = {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    order_id: input.orderId,
    amount_cents: input.amountCents,
    reason: input.reason,
    status: input.status,
    decided_by: input.decidedBy,
    reviewer_note: input.reviewerNote,
    created_at: new Date(Date.now() + counter).toISOString(),
    decided_at: input.status === "pending" ? null : new Date().toISOString(),
  };
  refunds.push(row);
  return row;
}

export async function readRefund(
  id: string,
): Promise<RefundRow | "not_found" | null> {
  return refunds.find((r) => r.id === id) ?? "not_found";
}

export async function readOpenRefundForOrder(
  orderId: string,
): Promise<RefundRow | "none" | null> {
  return (
    refunds.find((r) => r.order_id === orderId && r.status === "pending") ??
    "none"
  );
}

export async function readLatestRefundForOrder(
  orderId: string,
): Promise<RefundRow | "none" | null> {
  const mine = refunds.filter((r) => r.order_id === orderId);
  return mine.length ? mine[mine.length - 1] : "none";
}

export async function listRefunds(): Promise<RefundWithOrder[] | null> {
  return [...refunds].reverse().map((r) => {
    const order = orders.find((o) => o.id === r.order_id);
    return {
      ...r,
      orders: order
        ? { customer_name: order.customer_name, items: order.items }
        : null,
    };
  });
}

export async function decidePendingRefund(
  id: string,
  decision: { status: Exclude<RefundStatus, "pending">; note: string | null },
): Promise<RefundRow | "not_pending" | null> {
  const row = refunds.find((r) => r.id === id);
  if (!row || row.status !== "pending") return "not_pending";
  row.status = decision.status;
  row.decided_by = "human" satisfies DecidedBy;
  row.reviewer_note = decision.note;
  row.decided_at = new Date().toISOString();
  return row;
}

export async function readLimitCents(): Promise<number | null> {
  return limitCents;
}

export async function saveLimitCents(next: number): Promise<boolean> {
  limitCents = next;
  return true;
}
