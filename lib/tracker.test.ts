import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadEventRowLike } from "./activity.js";
import type { PendingHeartbeat } from "./heartbeat.js";
import {
  Tracker,
  chunkGroups,
  placeCursor,
  type HeartbeatGroup,
  type SendOutcome,
  type TrackerDeps,
  type TrackerOptions,
} from "./tracker.js";

const baseOptions: TrackerOptions = {
  agentCategory: "ai coding",
  humanCategory: "coding",
  classifyCommands: true,
  trackFileReads: true,
  trackOutsideWorkspace: false,
  keepaliveMs: 120_000,
  throttleMs: 120_000,
  staleAfterMs: 24 * 60 * 60 * 1000,
  maxEventsPerPoll: 400,
};

function fileChangeRow(seq: number, createdAt: number, path: string): ThreadEventRowLike {
  return {
    seq,
    createdAt,
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

interface HarnessOptions {
  events?: Record<string, ThreadEventRowLike[]>;
  cursors?: Record<string, number>;
  now?: number;
  options?: Partial<TrackerOptions>;
  environment?: { hostId: string; path: string | null; branchName: string | null } | null;
  sendResult?: SendOutcome | Error;
  threadStatus?: string;
  /**
   * Threads bb reports as running. This is the authority the tracker
   * reconciles against, so a test with a live thread must list it here.
   */
  active?: string[];
}

function harness(config: HarnessOptions = {}) {
  const cursors = new Map<string, number>(Object.entries(config.cursors ?? {}));
  const sends: { hostId: string; groups: HeartbeatGroup[] }[] = [];
  const records: { entries: readonly PendingHeartbeat[]; outcome: SendOutcome }[] = [];
  const logs: string[] = [];
  let now = config.now ?? 1_700_000_000_000;

  const deps: TrackerDeps = {
    now: () => now,
    options: async () => ({ ...baseOptions, ...config.options }),
    log: (level, message) => logs.push(`${level}: ${message}`),

    listEvents: vi.fn(async ({ threadId, afterSeq }) => {
      const rows = config.events?.[threadId] ?? [];
      return afterSeq === null ? rows : rows.filter((row) => row.seq > afterSeq);
    }),
    recentEvents: vi.fn(async ({ threadId, limit }) => {
      const rows = config.events?.[threadId] ?? [];
      return [...rows].sort((a, b) => b.seq - a.seq).slice(0, limit);
    }),
    listActiveThreadIds: vi.fn(async () => config.active ?? []),
    getThread: vi.fn(async (threadId: string) => ({
      kind: "found" as const,
      thread: {
        id: threadId,
        projectId: "proj_1",
        environmentId: "env_1",
        status: config.threadStatus ?? "active",
      },
    })),
    getEnvironment: vi.fn(async () =>
      config.environment === undefined
        ? { hostId: "host_1", path: "/work/app", branchName: "main" }
        : config.environment,
    ),
    getProjectName: vi.fn(async () => "app"),

    readCursor: async (threadId) => cursors.get(threadId) ?? null,
    writeCursor: async (threadId, seq) => {
      cursors.set(threadId, seq);
    },
    clearCursor: async (threadId) => {
      cursors.delete(threadId);
    },

    send: vi.fn(async (hostId: string, groups: HeartbeatGroup[]) => {
      sends.push({ hostId, groups });
      if (config.sendResult instanceof Error) throw config.sendResult;
      return config.sendResult ?? { accepted: groups.reduce((sum, g) => sum + g.heartbeats.length, 0), failures: [] };
    }),
    record: (entries, outcome) => records.push({ entries, outcome }),
  };

  return {
    deps,
    sends,
    records,
    logs,
    cursors,
    advance: (ms: number) => {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

describe("Tracker cursors", () => {
  it("starts a newly seen thread at its tip so it never backfills history", async () => {
    const events = { thr_1: [fileChangeRow(1, 1_699_999_000_000, "/work/app/old.ts")] };
    const context = harness({ events, active: ["thr_1"] });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");

    await tracker.poll();

    // The pre-existing edit is not replayed; only the keepalive for time from
    // now on is reported.
    const entities = context.sends.flatMap((send) => send.groups.flatMap((g) => g.heartbeats.map((h) => h.entity)));
    expect(entities).toEqual(["/work/app"]);
    expect(context.cursors.get("thr_1")).toBe(1);
  });

  it("resumes from a stored cursor, which is what survives a bb restart", async () => {
    const events = {
      thr_1: [
        fileChangeRow(1, 1_700_000_000_000, "/work/app/a.ts"),
        fileChangeRow(2, 1_700_000_001_000, "/work/app/b.ts"),
      ],
    };
    const context = harness({ events, cursors: { thr_1: 1 } });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");

    await tracker.poll();

    const entities = context.sends.flatMap((send) => send.groups.flatMap((g) => g.heartbeats.map((h) => h.entity)));
    expect(entities).toEqual(["/work/app/b.ts"]);
    expect(context.cursors.get("thr_1")).toBe(2);
  });

  it("advances the cursor even when a batch yields no heartbeats", async () => {
    const events = {
      thr_1: [{ seq: 7, createdAt: 1_700_000_000_000, type: "item/completed", data: { item: { type: "reasoning" } } }],
    };
    const context = harness({ events, cursors: { thr_1: 1 } });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");

    await tracker.poll();
    expect(context.cursors.get("thr_1")).toBe(7);
  });

  it("drops heartbeats older than the stale window instead of backfilling a day", async () => {
    const events = { thr_1: [fileChangeRow(2, 1_700_000_000_000 - 48 * 3600 * 1000, "/work/app/a.ts")] };
    const context = harness({ events, cursors: { thr_1: 1 } });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");

    await tracker.poll();
    expect(context.sends).toHaveLength(0);
    expect(context.logs.some((line) => line.includes("stale"))).toBe(true);
  });

  it("forgets a thread's cursor when it is archived", async () => {
    const context = harness({ cursors: { thr_1: 5 } });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");
    await tracker.forget("thr_1");
    expect(context.cursors.has("thr_1")).toBe(false);
    expect(tracker.trackedCount).toBe(0);
  });
});

describe("Tracker: a stopped thread stops counting", () => {
  it("stops keepalives when bb no longer reports the thread as active", async () => {
    // The one failure mode a time tracker must not have: inventing time for
    // work that ended. A missed `thread.idle` event must not cause it.
    const context = harness({ cursors: { thr_1: 0 }, active: ["thr_1"] });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");

    await tracker.poll();
    expect(context.sends).toHaveLength(1);

    // bb now says the thread is idle, but no lifecycle event arrived.
    (context.deps.getThread as ReturnType<typeof vi.fn>).mockImplementation(async (threadId: string) => ({
      kind: "found" as const,
      thread: { id: threadId, projectId: "proj_1", environmentId: "env_1", status: "idle" },
    }));
    context.advance(200_000);
    await tracker.poll();

    expect(context.sends).toHaveLength(1);
    expect(tracker.activeCount).toBe(0);
  });

  it("stops keepalives for a thread missing from bb's active list", async () => {
    const context = harness({ cursors: { thr_1: 0 }, active: ["thr_1"] });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");
    await tracker.poll();

    (context.deps.listActiveThreadIds as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (context.deps.getThread as ReturnType<typeof vi.fn>).mockImplementation(async (threadId: string) => ({
      kind: "found" as const,
      thread: { id: threadId, projectId: "proj_1", environmentId: "env_1", status: "idle" },
    }));
    context.advance(200_000);
    await tracker.poll();

    expect(tracker.activeCount).toBe(0);
    expect(context.sends).toHaveLength(1);
  });

  it("keeps a thread that is still starting up", async () => {
    const context = harness({ cursors: { thr_1: 0 }, active: ["thr_1"], threadStatus: "starting" });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");
    await tracker.poll();
    expect(tracker.activeCount).toBe(1);
  });
});

describe("Tracker: transient bb errors", () => {
  it("keeps a thread whose lookup failed instead of treating it as deleted", async () => {
    const context = harness({ cursors: { thr_1: 0 }, active: ["thr_1"] });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");
    await tracker.poll();

    (context.deps.getThread as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "error" as const,
      message: "socket hang up",
    });
    context.advance(200_000);
    await tracker.poll();

    // Still watched, and the last known context kept it reporting.
    expect(tracker.trackedCount).toBe(1);
    expect(context.sends).toHaveLength(2);
  });

  it("forgets a thread bb confirms is gone", async () => {
    const context = harness({ cursors: { thr_1: 0 }, active: ["thr_1"] });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");
    (context.deps.getThread as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "missing" as const });

    await tracker.poll();
    expect(tracker.trackedCount).toBe(0);
  });
});

describe("Tracker: a failed send is retried, not lost", () => {
  it("holds the cursor so the next poll re-reads the same events", async () => {
    const events = { thr_1: [fileChangeRow(2, 1_700_000_000_000, "/work/app/a.ts")] };
    const context = harness({
      events,
      cursors: { thr_1: 1 },
      active: ["thr_1"],
      sendResult: new Error("host offline"),
    });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");

    await tracker.poll();
    // The cursor did not move, so the edit is still pending rather than gone.
    expect(context.cursors.get("thr_1")).toBe(1);
    expect(context.logs.some((line) => line.includes("holding cursor"))).toBe(true);

    await tracker.poll();
    const attempts = context.sends.flatMap((send) => send.groups.flatMap((g) => g.heartbeats.map((h) => h.entity)));
    expect(attempts.filter((entity) => entity === "/work/app/a.ts")).toHaveLength(2);
  });

  it("commits the cursor once the send succeeds", async () => {
    const events = { thr_1: [fileChangeRow(2, 1_700_000_000_000, "/work/app/a.ts")] };
    const context = harness({ events, cursors: { thr_1: 1 }, active: ["thr_1"] });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");

    await tracker.poll();
    expect(context.cursors.get("thr_1")).toBe(2);
  });

  it("gives up rather than re-reading the same events forever", async () => {
    const events = { thr_1: [fileChangeRow(2, 1_700_000_000_000, "/work/app/a.ts")] };
    const context = harness({
      events,
      cursors: { thr_1: 1 },
      active: ["thr_1"],
      sendResult: { accepted: 0, failures: [{ message: "nope", count: 1 }] },
    });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");

    for (let poll = 0; poll < 21; poll += 1) await tracker.poll();
    expect(context.cursors.get("thr_1")).toBe(2);
    expect(context.logs.some((line) => line.includes("giving up"))).toBe(true);
  });

  it("does not hold one thread's cursor because another thread failed", async () => {
    const context = harness({
      events: {
        thr_1: [fileChangeRow(2, 1_700_000_000_000, "/work/a/one.ts")],
        thr_2: [fileChangeRow(2, 1_700_000_000_000, "/work/b/two.ts")],
      },
      cursors: { thr_1: 1, thr_2: 1 },
      active: ["thr_1", "thr_2"],
    });
    (context.deps.getEnvironment as ReturnType<typeof vi.fn>).mockImplementation(async (environmentId: string) =>
      environmentId === "env_1"
        ? { hostId: "host_1", path: "/work/a", branchName: "main" }
        : { hostId: "host_2", path: "/work/b", branchName: "main" },
    );
    (context.deps.getThread as ReturnType<typeof vi.fn>).mockImplementation(async (threadId: string) => ({
      kind: "found" as const,
      thread: {
        id: threadId,
        projectId: "proj_1",
        environmentId: threadId === "thr_1" ? "env_1" : "env_2",
        status: "active",
      },
    }));
    (context.deps.send as ReturnType<typeof vi.fn>).mockImplementation(async (hostId: string) =>
      hostId === "host_1" ? { accepted: 0, failures: [{ message: "down", count: 1 }] } : { accepted: 1, failures: [] },
    );

    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");
    tracker.markActive("thr_2");
    await tracker.poll();

    expect(context.cursors.get("thr_1")).toBe(1);
    expect(context.cursors.get("thr_2")).toBe(2);
  });
});

describe("placeCursor", () => {
  it("skips a thread's pre-existing history", () => {
    const rows = [
      { seq: 9, createdAt: 500, type: "item/completed" },
      { seq: 8, createdAt: 400, type: "item/completed" },
    ];
    expect(placeCursor(rows, 1000)).toBe(9);
  });

  it("keeps events that arrived after the plugin first saw the thread", () => {
    // Without this, every thread loses the work done between starting and the
    // first poll, including its opening prompt.
    const rows = [
      { seq: 9, createdAt: 1200, type: "item/completed" },
      { seq: 8, createdAt: 1100, type: "item/completed" },
      { seq: 7, createdAt: 900, type: "item/completed" },
    ];
    expect(placeCursor(rows, 1000)).toBe(7);
  });

  it("starts from zero for a thread with no events", () => {
    expect(placeCursor([], 1000)).toBe(0);
  });

  it("never returns a negative sequence", () => {
    expect(placeCursor([{ seq: 1, createdAt: 2000, type: "item/completed" }], 1000)).toBe(0);
  });
});

describe("Tracker keepalive", () => {
  it("reports the worktree while an active thread produces no events", async () => {
    const context = harness({ cursors: { thr_1: 0 }, active: ["thr_1"] });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");

    await tracker.poll();

    expect(context.sends).toHaveLength(1);
    expect(context.sends[0]!.groups[0]!.heartbeats[0]).toMatchObject({
      entity: "/work/app",
      category: "ai coding",
    });
  });

  it("does not keepalive faster than the configured interval", async () => {
    const context = harness({ cursors: { thr_1: 0 }, active: ["thr_1"] });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");

    await tracker.poll();
    context.advance(30_000);
    await tracker.poll();
    expect(context.sends).toHaveLength(1);

    context.advance(120_000);
    await tracker.poll();
    expect(context.sends).toHaveLength(2);
  });

  it("does not keepalive an idle thread", async () => {
    const context = harness({ cursors: { thr_1: 0 } });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");
    tracker.markIdle("thr_1");

    await tracker.poll();
    expect(context.sends).toHaveLength(0);
  });

  it("keepalives against the last file touched, not the directory", async () => {
    const events = { thr_1: [fileChangeRow(2, 1_700_000_000_000, "/work/app/src/a.ts")] };
    const context = harness({ events, cursors: { thr_1: 1 }, active: ["thr_1"] });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");

    await tracker.poll();
    context.advance(150_000);
    await tracker.poll();

    // wakatime-cli cannot count the lines in a directory, so reusing the file
    // keeps the language attribution and keeps its shared log quiet.
    const second = context.sends[1]!.groups[0]!.heartbeats[0]!;
    expect(second.entity).toBe("/work/app/src/a.ts");
    expect(second.is_write).toBeUndefined();
  });

  it("does not reuse a command's working directory as the keepalive target", async () => {
    const commandRow: ThreadEventRowLike = {
      seq: 2,
      createdAt: 1_700_000_000_000,
      type: "item/completed",
      data: { item: { type: "commandExecution", status: "completed", command: "ls", cwd: "/work/app/src" } },
    };
    const context = harness({ events: { thr_1: [commandRow] }, cursors: { thr_1: 1 }, active: ["thr_1"] });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");

    await tracker.poll();
    context.advance(150_000);
    await tracker.poll();

    expect(context.sends[1]!.groups[0]!.heartbeats[0]!.entity).toBe("/work/app");
  });

  it("skips the keepalive when real activity already reported time", async () => {
    const events = { thr_1: [fileChangeRow(2, 1_700_000_000_000, "/work/app/a.ts")] };
    const context = harness({ events, cursors: { thr_1: 1 } });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");

    await tracker.poll();
    const entities = context.sends[0]!.groups.flatMap((g) => g.heartbeats.map((h) => h.entity));
    expect(entities).toEqual(["/work/app/a.ts"]);
  });
});

describe("Tracker lifecycle", () => {
  it("drains once after a thread goes idle, then stops watching it", async () => {
    const events = { thr_1: [fileChangeRow(2, 1_700_000_000_000, "/work/app/a.ts")] };
    const context = harness({ events, cursors: { thr_1: 1 } });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");
    tracker.markIdle("thr_1");

    // The final drain still collects the trailing file change.
    await tracker.poll();
    expect(context.sends).toHaveLength(1);
    expect(tracker.trackedCount).toBe(1);

    await tracker.poll();
    expect(tracker.trackedCount).toBe(0);
  });

  it("rediscovers already-running threads on its first poll", async () => {
    const context = harness({ cursors: { thr_9: 0 } });
    (context.deps.listActiveThreadIds as ReturnType<typeof vi.fn>).mockResolvedValue(["thr_9"]);
    const tracker = new Tracker(context.deps);

    await tracker.poll();
    expect(tracker.activeCount).toBe(1);
    expect(context.sends).toHaveLength(1);
  });

  it("keeps polling other threads when one fails to read", async () => {
    const context = harness({ cursors: { thr_1: 0, thr_2: 0 }, active: ["thr_1", "thr_2"] });
    (context.deps.listEvents as ReturnType<typeof vi.fn>).mockImplementation(async ({ threadId }) => {
      if (threadId === "thr_1") throw new Error("boom");
      return [];
    });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");
    tracker.markActive("thr_2");

    await tracker.poll();
    expect(context.logs.some((line) => line.includes("boom"))).toBe(true);
    // thr_2 still reported its keepalive.
    expect(context.sends).toHaveLength(1);
  });

  it("reports nothing for a thread whose environment has no path", async () => {
    const context = harness({ cursors: { thr_1: 0 }, environment: { hostId: "host_1", path: null, branchName: null } });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");

    await tracker.poll();
    expect(context.sends).toHaveLength(0);
  });

  it("records a failed send so the error surfaces in status", async () => {
    const context = harness({ cursors: { thr_1: 0 }, sendResult: new Error("host offline"), active: ["thr_1"] });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");

    await tracker.poll();
    expect(context.records[0]!.outcome.failures[0]!.message).toBe("host offline");
    expect(context.logs.some((line) => line.includes("host offline"))).toBe(true);
  });
});

describe("Tracker throttling", () => {
  it("suppresses a repeated read of the same file inside the window", async () => {
    const readRow = (seq: number, createdAt: number): ThreadEventRowLike => ({
      seq,
      createdAt,
      type: "item/completed",
      data: { item: { type: "toolCall", tool: "Read", arguments: { file_path: "/work/app/a.ts" } } },
    });
    const context = harness({
      events: { thr_1: [readRow(2, 1_700_000_000_000), readRow(3, 1_700_000_030_000)] },
      cursors: { thr_1: 1 },
    });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");

    await tracker.poll();
    const sent = context.sends.flatMap((s) => s.groups.flatMap((g) => g.heartbeats));
    expect(sent).toHaveLength(1);
  });

  it("lets every write through, however close together", async () => {
    const context = harness({
      events: {
        thr_1: [
          fileChangeRow(2, 1_700_000_000_000, "/work/app/a.ts"),
          fileChangeRow(3, 1_700_000_001_000, "/work/app/a.ts"),
          fileChangeRow(4, 1_700_000_002_000, "/work/app/a.ts"),
        ],
      },
      cursors: { thr_1: 1 },
    });
    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");

    await tracker.poll();
    const sent = context.sends.flatMap((s) => s.groups.flatMap((g) => g.heartbeats));
    expect(sent).toHaveLength(3);
  });
});

describe("chunkGroups", () => {
  function entry(projectFolder: string | null, entity: string): PendingHeartbeat {
    return {
      hostId: "host_1",
      projectFolder,
      threadId: "thr_1",
      entityKind: "file",
      heartbeat: { entity, entity_type: "file", category: "ai coding", time: 1 },
    };
  }

  it("keeps each project root in its own group, since the flag is per process", () => {
    const batches = chunkGroups([
      entry("/a", "/a/one.ts"),
      entry("/b", "/b/two.ts"),
      entry("/a", "/a/three.ts"),
    ]);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.groups).toHaveLength(2);
    expect(batches[0]!.groups.map((g) => g.projectFolder).sort()).toEqual(["/a", "/b"]);
    expect(batches[0]!.groups.find((g) => g.projectFolder === "/a")!.heartbeats).toHaveLength(2);
  });

  it("splits a group larger than the contract's per-group cap", () => {
    const entries = Array.from({ length: 501 }, (_, index) => entry("/a", `/a/${index}.ts`));
    const batches = chunkGroups(entries);
    const groups = batches.flatMap((batch) => batch.groups);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.heartbeats).toHaveLength(500);
    expect(groups[1]!.heartbeats).toHaveLength(1);
  });

  it("splits into several calls past the per-call group cap", () => {
    const entries = Array.from({ length: 65 }, (_, index) => entry(`/root${index}`, `/root${index}/x.ts`));
    const batches = chunkGroups(entries);
    expect(batches).toHaveLength(2);
    expect(batches[0]!.groups).toHaveLength(64);
    expect(batches[1]!.groups).toHaveLength(1);
  });

  it("keeps a null project root as its own group", () => {
    const batches = chunkGroups([entry(null, "/etc/hosts"), entry("/a", "/a/x.ts")]);
    expect(batches[0]!.groups.map((g) => g.projectFolder)).toContain(null);
  });

  it("returns nothing for no entries", () => {
    expect(chunkGroups([])).toEqual([]);
  });
});

describe("Tracker host routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends each machine's heartbeats to that machine", async () => {
    const context = harness({ cursors: { thr_1: 0, thr_2: 0 }, active: ["thr_1", "thr_2"] });
    (context.deps.getEnvironment as ReturnType<typeof vi.fn>).mockImplementation(async (environmentId: string) =>
      environmentId === "env_1"
        ? { hostId: "host_1", path: "/work/a", branchName: "main" }
        : { hostId: "host_2", path: "/work/b", branchName: "main" },
    );
    (context.deps.getThread as ReturnType<typeof vi.fn>).mockImplementation(async (threadId: string) => ({
      kind: "found" as const,
      thread: {
        id: threadId,
        projectId: "proj_1",
        environmentId: threadId === "thr_1" ? "env_1" : "env_2",
        status: "active",
      },
    }));

    const tracker = new Tracker(context.deps);
    tracker.markActive("thr_1");
    tracker.markActive("thr_2");

    await tracker.poll();
    expect(context.sends.map((send) => send.hostId).sort()).toEqual(["host_1", "host_2"]);
  });
});
