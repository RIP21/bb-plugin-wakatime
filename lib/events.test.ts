import { describe, expect, it } from "vitest";
import { listThreadEvents, THREAD_EVENT_PAGE_SIZE, type EventPageArgs } from "./events.js";

/** A fake bb that enforces the real page limit, like the server does. */
function fakeThread(count: number) {
  const rows = Array.from({ length: count }, (_, index) => ({ seq: (index + 1) * 2 }));
  const calls: EventPageArgs[] = [];
  async function list(args: EventPageArgs & { threadId: string }) {
    calls.push(args);
    const limit = Number(args.limit);
    if (limit > THREAD_EVENT_PAGE_SIZE) throw new Error("HTTP 400: Thread event limit cannot exceed 100");
    let selected = rows;
    if (args.afterSeq !== undefined) selected = selected.filter((row) => row.seq > Number(args.afterSeq));
    if (args.beforeSeq !== undefined) selected = selected.filter((row) => row.seq < Number(args.beforeSeq));
    if (args.order === "desc") selected = [...selected].reverse();
    return selected.slice(0, limit);
  }
  return { list, calls, rows };
}

describe("listThreadEvents", () => {
  it("splits a large ascending read into pages bb accepts", async () => {
    const thread = fakeThread(250);
    const rows = await listThreadEvents(thread.list, { threadId: "t", order: "asc", limit: 400 });
    expect(rows).toEqual(thread.rows);
    expect(thread.calls.map((call) => call.limit)).toEqual(["100", "100", "100"]);
    expect(thread.calls.map((call) => call.afterSeq)).toEqual([undefined, "200", "400"]);
  });

  it("starts after the caller's cursor and stops at the requested total", async () => {
    const thread = fakeThread(500);
    const rows = await listThreadEvents(thread.list, { threadId: "t", order: "asc", afterSeq: "10", limit: 150 });
    expect(rows).toHaveLength(150);
    expect(rows[0]).toEqual({ seq: 12 });
    expect(thread.calls.map((call) => call.limit)).toEqual(["100", "50"]);
  });

  it("pages backwards for a descending read", async () => {
    const thread = fakeThread(150);
    const rows = await listThreadEvents(thread.list, { threadId: "t", order: "desc", limit: 120 });
    expect(rows.map((row) => row.seq)).toEqual(thread.rows.slice(30).map((row) => row.seq).reverse());
    expect(thread.calls[1]).toMatchObject({ beforeSeq: "102", limit: "20" });
  });

  it("refuses to loop on a server that ignores the cursor", async () => {
    const stuck = async (_: EventPageArgs & { threadId: string }) => Array.from({ length: 100 }, () => ({ seq: 5 }));
    await expect(listThreadEvents(stuck, { threadId: "t", order: "asc", afterSeq: "5", limit: 300 }))
      .rejects.toThrow("no progress");
  });
});
