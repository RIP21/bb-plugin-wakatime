import { describe, expect, it } from "vitest";
import type { ThreadContext, ThreadEventRowLike } from "./activity.js";
import { inferWorktreePath, planThreadBackfill, throttleBackfill } from "./backfill.js";

const MIN = 60_000;
const BASE = Date.UTC(2026, 8, 20, 10);

const context: ThreadContext = {
  threadId: "thr_1",
  hostId: "host_1",
  worktreePath: "/work/app",
  branchName: "main",
  projectName: "app",
};

const options = {
  agentCategory: "ai coding" as const,
  humanCategory: "coding" as const,
  classifyCommands: true,
  trackFileReads: true,
  trackOutsideWorkspace: false,
  keepaliveMs: 2 * MIN,
};

function edit(seq: number, at: number, path = "/work/app/src/a.ts"): ThreadEventRowLike {
  return {
    seq,
    createdAt: at,
    type: "item/completed",
    data: {
      item: {
        type: "fileChange",
        status: "completed",
        approvalStatus: null,
        changes: [{ path, kind: "update", diff: "--- a/x\n+++ b/x\n+one\n" }],
      },
    },
  };
}

const times = (entries: { heartbeat: { time: number } }[]) => entries.map((entry) => entry.heartbeat.time * 1000);

describe("planThreadBackfill", () => {
  it("keeps only events inside the window", () => {
    const planned = planThreadBackfill({
      rows: [edit(1, BASE - MIN), edit(2, BASE + MIN), edit(3, BASE + 10 * MIN)],
      turns: [],
      context,
      options,
      from: BASE,
      to: BASE + 10 * MIN,
    });
    expect(times(planned)).toEqual([BASE + MIN]);
  });

  it("fills a quiet turn with keepalives on the last file touched", () => {
    const planned = planThreadBackfill({
      rows: [edit(1, BASE)],
      turns: [{ start: BASE, end: BASE + 7 * MIN }],
      context,
      options,
      from: BASE - 60 * MIN,
      to: BASE + 60 * MIN,
    });
    // The edit covers the turn's first interval; keepalives follow every 2 minutes.
    expect(times(planned)).toEqual([BASE, BASE + 2 * MIN, BASE + 4 * MIN, BASE + 6 * MIN]);
    expect(planned.every((entry) => entry.heartbeat.entity === "/work/app/src/a.ts")).toBe(true);
    expect(planned.slice(1).every((entry) => entry.heartbeat.category === "ai coding")).toBe(true);
  });

  it("falls back to the worktree root before anything was touched", () => {
    const planned = planThreadBackfill({
      rows: [],
      turns: [{ start: BASE, end: BASE + MIN }],
      context,
      options,
      from: BASE - MIN,
      to: BASE + 60 * MIN,
    });
    expect(planned.map((entry) => entry.heartbeat.entity)).toEqual(["/work/app"]);
  });

  it("clips turns to the window", () => {
    const planned = planThreadBackfill({
      rows: [],
      turns: [{ start: BASE - 30 * MIN, end: BASE + 3 * MIN }],
      context,
      options,
      from: BASE,
      to: BASE + 60 * MIN,
    });
    expect(times(planned)).toEqual([BASE, BASE + 2 * MIN]);
  });

  it("marks file heartbeats unsaved so a removed worktree does not drop them", () => {
    const planned = planThreadBackfill({
      rows: [edit(1, BASE)],
      turns: [{ start: BASE, end: BASE + 3 * MIN }],
      context,
      options,
      from: BASE - MIN,
      to: BASE + 60 * MIN,
    });
    expect(planned.length).toBeGreaterThan(1);
    expect(planned.every((entry) => entry.heartbeat.is_unsaved_entity === true)).toBe(true);
  });
});

describe("throttleBackfill", () => {
  it("drops reads of the same file inside the window but keeps every write", () => {
    const keepalive = (at: number) => ({
      hostId: "host_1",
      projectFolder: "/work/app",
      threadId: "thr_1",
      entityKind: "file" as const,
      heartbeat: { entity: "/work/app/src/a.ts", entity_type: "file" as const, category: "ai coding" as const, time: at / 1000 },
    });
    const write = { ...keepalive(BASE + 30_000), heartbeat: { ...keepalive(BASE + 30_000).heartbeat, is_write: true } };
    const admitted = throttleBackfill([keepalive(BASE + MIN), write, keepalive(BASE), keepalive(BASE + 3 * MIN)], 2 * MIN);
    expect(times(admitted)).toEqual([BASE, BASE + 30_000, BASE + 3 * MIN]);
  });
});

describe("inferWorktreePath", () => {
  const command = (seq: number, cwd: string): ThreadEventRowLike => ({
    seq,
    createdAt: BASE,
    type: "item/completed",
    data: { item: { type: "commandExecution", status: "completed", command: "ls", cwd } },
  });

  it("picks the directory the agent ran most commands from", () => {
    expect(inferWorktreePath([
      command(1, "/work/app"), command(2, "/work/app/web"), command(3, "/work/app"), edit(4, BASE),
    ])).toBe("/work/app");
  });

  it("returns null for a thread that ran no commands", () => {
    expect(inferWorktreePath([edit(1, BASE)])).toBeNull();
  });
});
