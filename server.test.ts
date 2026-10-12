import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";

interface HeartbeatCallInput {
  groups: {
    projectFolder: string | null;
    heartbeats: {
      entity: string;
      category: string;
      is_write?: boolean;
      ai_line_changes?: number;
      alternate_project?: string;
      alternate_branch?: string;
    }[];
  }[];
  options: { pluginUserAgent: string };
}

interface Options {
  settings?: Record<string, string | boolean>;
  hostResults?: Partial<Record<string, unknown>>;
}

const CLI_STATUS = {
  path: "/home/me/.wakatime/wakatime-cli",
  version: "v2.24.4",
  origin: "existing" as const,
  hasConfiguredApiKey: true,
  error: null,
};

function fakeHost(options: Options = {}) {
  const results: Record<string, unknown> = {
    sendHeartbeats: { cli: CLI_STATUS, accepted: 1, failures: [] },
    probe: { cli: CLI_STATUS, offlineQueueCount: 0, today: "1 hr 2 mins", todayError: null },
    syncOffline: { cli: CLI_STATUS, queuedBefore: 3, queuedAfter: 0, error: null },
    ...options.hostResults,
  };

  return createFakePluginHost({
    pluginId: "wakatime",
    settings: options.settings ?? {},
    sdk: {
      system: { version: async () => ({ currentVersion: "0.39.0" }) },
      hosts: { list: async () => [{ id: "host_1", name: "laptop", status: "connected" }] },
      projects: { get: async () => ({ id: "proj_1", name: "app", kind: "standard" }) },
      threads: {
        list: async () => [],
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({ id: threadId, projectId: "proj_1", environmentId: "env_1", status: "active" }),
        events: { list: async () => [] },
      },
      environments: {
        get: async () => ({ id: "env_1", hostId: "host_1", path: "/work/app", branchName: "main" }),
      },
    },
    experimental_callHostRpc: async ({ method }) => {
      const result = results[method];
      if (!result) throw new Error(`unstubbed host method ${method}`);
      return result;
    },
  });
}

describe("registration", () => {
  it("registers the surfaces the plugin advertises", async () => {
    const { bb, harness } = fakeHost();
    await plugin(bb);

    expect(harness.registrations.services.map((service) => service.name)).toContain("tracker");
    expect(harness.registrations.schedules.map((schedule) => schedule.name).sort()).toEqual(["prune", "sync-offline"]);
    expect(harness.registrations.rpcMethods.sort()).toEqual(["getActivityStatus", "getSummary", "recentActivity", "status", "syncNow", "todayStats"]);
    expect(harness.registrations.cli?.name).toBe("wakatime");
  });

  it("documents every CLI subcommand it accepts, for the agent skill", async () => {
    const { bb, harness } = fakeHost();
    await plugin(bb);
    const names = harness.registrations.cli?.commands?.map((command) => command.name).sort();
    expect(names).toEqual(["activity", "backfill", "backfill-wakatime", "doctor", "log", "recheck-history", "status", "sync", "today"]);
    for (const command of harness.registrations.cli?.commands ?? []) {
      expect(command.summary, command.name).toBeTruthy();
      expect(command.usage, command.name).toContain("bb wakatime");
    }
  });

  it("reloads without leaking a duplicate registration", async () => {
    const { bb, harness } = fakeHost();
    await plugin(bb);
    await harness.lifecycle.reload(plugin);
    expect(harness.registrations.rpcMethods.sort()).toEqual(["getActivityStatus", "getSummary", "recentActivity", "status", "syncNow", "todayStats"]);
  });
});

describe("status rpc", () => {
  it("reports the key as coming from settings when one is configured", async () => {
    const { bb, harness } = fakeHost({ settings: { apiKey: "secret-key" } });
    await plugin(bb);
    const status = (await harness.behavior.callRpc("status", { includeToday: false })) as {
      apiKeySource: string;
      hosts: { name: string; today: string | null }[];
    };
    expect(status.apiKeySource).toBe("settings");
    expect(status.hosts[0]!.name).toBe("laptop");
  });

  it("falls back to reporting the machine's own config", async () => {
    const { bb, harness } = fakeHost();
    await plugin(bb);
    const status = (await harness.behavior.callRpc("status", { includeToday: true })) as { apiKeySource: string };
    expect(status.apiKeySource).toBe("host-config");
  });

  it("says the key is missing when no machine has one", async () => {
    const { bb, harness } = fakeHost({
      hostResults: {
        probe: {
          cli: { ...CLI_STATUS, hasConfiguredApiKey: false },
          offlineQueueCount: 0,
          today: null,
          todayError: null,
        },
      },
    });
    await plugin(bb);
    const status = (await harness.behavior.callRpc("status", { includeToday: false })) as { apiKeySource: string };
    expect(status.apiKeySource).toBe("missing");
  });

  it("keeps a probe failure out of the way of the rest of the status", async () => {
    const { bb, harness } = fakeHost({ hostResults: { probe: undefined } });
    await plugin(bb);
    const status = (await harness.behavior.callRpc("status", { includeToday: false })) as {
      apiKeySource: string;
      hosts: { error: string | null }[];
    };
    expect(status.apiKeySource).toBe("unknown");
    expect(status.hosts[0]!.error).toContain("unstubbed host method probe");
  });
});

describe("todayStats rpc", () => {
  it("serves cached numbers without touching a machine", async () => {
    const { bb, harness } = fakeHost({ settings: { apiKey: "k" } });
    await plugin(bb);
    const before = harness.experimental_hostRpcCalls.length;
    const stats = (await harness.behavior.callRpc("todayStats", null)) as {
      total: string | null;
      compact: string | null;
      heartbeats: { sent: number };
    };
    // The sidebar accessory calls this; it must not spawn a process per render.
    expect(harness.experimental_hostRpcCalls.length).toBe(before);
    expect(stats.heartbeats.sent).toBe(0);
    expect(stats.total).toBeNull();
  });

  it("finds a thread that was already running past the first page of threads", async () => {
    // bb does not list threads newest first, so a running thread can sit
    // anywhere; it was active before the plugin loaded, so no event says so.
    const threads = Array.from({ length: 250 }, (_, index) =>
      makeThreadResponse({ id: `thr_${index}`, status: index === 240 ? "active" : "idle" }));
    const { bb, harness } = fakeHost({ settings: { apiKey: "k" } });
    harness.sdk.stub("threads.list", async ({ limit = 50, offset = 0 }: { limit?: number; offset?: number }) =>
      threads.slice(offset, offset + limit));
    await plugin(bb);

    const service = harness.behavior.runService("tracker");
    const tracking = async () => ((await harness.behavior.callRpc("status", { includeToday: false })) as {
      tracking: { activeThreads: number };
    }).tracking.activeThreads;
    await waitFor(async () => (await tracking()) === 1);
    service.controller.abort();
    await service.done;
  });

  it("reports the total the poll loop cached, in both forms", async () => {
    const { bb, harness } = fakeHost({ settings: { apiKey: "k" } });
    await plugin(bb);

    const service = harness.behavior.runService("tracker");
    await waitFor(() => harness.experimental_hostRpcCalls.some((call) => call.method === "probe"));
    service.controller.abort();
    await service.done;

    const stats = (await harness.behavior.callRpc("todayStats", null)) as {
      total: string | null;
      compact: string | null;
      refreshedAt: number | null;
    };
    expect(stats.total).toBe("1 hr 2 mins");
    expect(stats.compact).toBe("1h 2m");
    expect(stats.refreshedAt).not.toBeNull();
  });

  it("signals the sidebar when the total changes", async () => {
    const { bb, harness } = fakeHost({ settings: { apiKey: "k" } });
    await plugin(bb);

    const service = harness.behavior.runService("tracker");
    await waitFor(() => harness.realtimeSignals.length > 0);
    service.controller.abort();
    await service.done;

    expect(harness.realtimeSignals[0]).toMatchObject({ channel: "today" });
  });

  it("breaks the day down by project and category", async () => {
    const { bb, harness } = fakeHost({ settings: { apiKey: "k" } });
    harness.sdk.stub("threads.events.list", async () => [
      {
        seq: 5,
        createdAt: Date.now(),
        type: "item/completed",
        data: {
          item: {
            type: "fileChange",
            status: "completed",
            approvalStatus: null,
            changes: [{ path: "/work/app/src/a.ts", kind: "update", diff: "--- a/x\n+++ b/x\n+one\n-two\n" }],
          },
        },
      },
    ]);
    await plugin(bb);

    await bb.storage.kv.set("cursor:thr_1", 4);
    await harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thr_1", projectId: "proj_1", environmentId: "env_1", status: "active" }),
    });
    const service = harness.behavior.runService("tracker");
    await waitFor(async () => {
      const stats = (await harness.behavior.callRpc("todayStats", null)) as {
        projects: { project: string; lineChanges: number }[];
      };
      return stats.projects.length > 0;
    });
    service.controller.abort();
    await service.done;

    const stats = (await harness.behavior.callRpc("todayStats", null)) as {
      projects: { project: string; heartbeats: number; lineChanges: number }[];
      categories: { category: string; heartbeats: number }[];
    };
    expect(stats.projects[0]).toMatchObject({ project: "app", lineChanges: 2 });
    expect(stats.categories[0]).toMatchObject({ category: "ai coding" });
  });
});

describe("api key secrecy", () => {
  it("never returns the key through rpc, which the frontend can read", async () => {
    const { bb, harness } = fakeHost({ settings: { apiKey: "super-secret-key" } });
    await plugin(bb);
    const status = await harness.behavior.callRpc("status", { includeToday: true });
    expect(JSON.stringify(status)).not.toContain("super-secret-key");
  });

  it("does pass the key to the host, which is what runs wakatime-cli", async () => {
    const { bb, harness } = fakeHost({ settings: { apiKey: "super-secret-key" } });
    await plugin(bb);
    await harness.behavior.callRpc("syncNow", null);
    const call = harness.experimental_hostRpcCalls.find((entry) => entry.method === "syncOffline");
    expect((call?.input as { options: { apiKey: string } }).options.apiKey).toBe("super-secret-key");
  });
});

describe("cli command", () => {
  it("prints a status summary", async () => {
    const { bb, harness } = fakeHost({ settings: { apiKey: "k" } });
    await plugin(bb);
    const result = await harness.behavior.runCli(["status"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("API key:");
    expect(result.stdout).toContain("laptop: v2.24.4");
  });

  it("defaults to status with no arguments", async () => {
    const { bb, harness } = fakeHost({ settings: { apiKey: "k" } });
    await plugin(bb);
    expect((await harness.behavior.runCli([])).stdout).toContain("Tracking:");
  });

  it("reports today's total per machine", async () => {
    const { bb, harness } = fakeHost({ settings: { apiKey: "k" } });
    await plugin(bb);
    expect((await harness.behavior.runCli(["today"])).stdout).toBe("laptop: 1 hr 2 mins\n");
  });

  it("flushes the offline queue and says how many went out", async () => {
    const { bb, harness } = fakeHost({ settings: { apiKey: "k" } });
    await plugin(bb);
    const result = await harness.behavior.runCli(["sync"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("flushed 3");
  });

  it("exits non-zero when a sync fails", async () => {
    const { bb, harness } = fakeHost({
      hostResults: { syncOffline: { cli: CLI_STATUS, queuedBefore: 1, queuedAfter: 1, error: "network down" } },
    });
    await plugin(bb);
    const result = await harness.behavior.runCli(["sync"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("network down");
  });

  it("fails the doctor when no API key is reachable", async () => {
    const { bb, harness } = fakeHost({
      hostResults: {
        probe: { cli: { ...CLI_STATUS, hasConfiguredApiKey: false }, offlineQueueCount: 0, today: null, todayError: null },
      },
    });
    await plugin(bb);
    const result = await harness.behavior.runCli(["doctor"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("No API key");
  });

  it("echoes the effective settings in the doctor output", async () => {
    const { bb, harness } = fakeHost({ settings: { apiKey: "k", privacy: "hide-project-folder" } });
    await plugin(bb);
    expect((await harness.behavior.runCli(["doctor"])).stdout).toContain("privacy:               hide-project-folder");
  });

  it("says so plainly when nothing has been reported", async () => {
    const { bb, harness } = fakeHost();
    await plugin(bb);
    expect((await harness.behavior.runCli(["log"])).stdout).toBe("No activity reported yet.\n");
  });

  it("rejects an unknown subcommand with a usable hint", async () => {
    const { bb, harness } = fakeHost();
    await plugin(bb);
    const result = await harness.behavior.runCli(["nope"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Try status, today, sync, doctor, log, activity, or backfill.");
  });
});

describe("thread activity", () => {
  const fileChange = {
    seq: 5,
    createdAt: Date.now(),
    type: "item/completed",
    data: {
      item: {
        type: "fileChange",
        status: "completed",
        approvalStatus: null,
        changes: [{ path: "/work/app/src/a.ts", kind: "update", diff: "--- a/x\n+++ b/x\n+one\n-two\n" }],
      },
    },
  };

  /**
   * Seeding the cursor is what keeps this a one-poll test. The tracker's
   * multi-poll behavior is covered in lib/tracker.test.ts, so waiting out the
   * real 30s interval here would buy nothing.
   */
  async function runOnePoll(bb: Parameters<typeof plugin>[0], harness: ReturnType<typeof fakeHost>["harness"]) {
    await bb.storage.kv.set("cursor:thr_1", 4);
    await harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thr_1", projectId: "proj_1", environmentId: "env_1", status: "active" }),
    });
    const service = harness.behavior.runService("tracker");
    await waitFor(() => harness.experimental_hostRpcCalls.some((call) => call.method === "sendHeartbeats"));
    service.controller.abort();
    await service.done;
    return harness.experimental_hostRpcCalls
      .filter((call) => call.method === "sendHeartbeats")
      .map((call) => call.input as HeartbeatCallInput);
  }

  it("never asks bb for more than 100 events at once", async () => {
    // bb answers a larger page with HTTP 400 and no rows; that stopped every
    // heartbeat once bb started enforcing it.
    const limits: number[] = [];
    const { bb, harness } = fakeHost({ settings: { apiKey: "k" } });
    harness.sdk.stub("threads.events.list", async ({ limit, types }: { limit?: string; types?: string[] }) => {
      limits.push(Number(limit));
      if (Number(limit) > 100) throw new Error("HTTP 400: Thread event limit cannot exceed 100");
      return types?.includes("item/completed") ? [fileChange] : [];
    });
    await plugin(bb);

    const inputs = await runOnePoll(bb, harness);

    expect(inputs.flatMap((input) => input.groups.flatMap((group) => group.heartbeats))
      .some((heartbeat) => heartbeat.entity === "/work/app/src/a.ts")).toBe(true);
    expect(limits.length).toBeGreaterThan(0);
    expect(Math.max(...limits)).toBeLessThanOrEqual(100);
  });

  it("reports an agent's file change to the host that owns the worktree", async () => {
    const { bb, harness } = fakeHost({ settings: { apiKey: "k" } });
    harness.sdk.stub("threads.events.list", async () => [fileChange]);
    await plugin(bb);

    const inputs = await runOnePoll(bb, harness);
    const heartbeats = inputs.flatMap((input) => input.groups.flatMap((group) => group.heartbeats));

    expect(inputs[0]!.options.pluginUserAgent).toBe("bb/0.39.0 bb-wakatime/0.2.0");
    const change = heartbeats.find((heartbeat) => heartbeat.entity === "/work/app/src/a.ts");
    // One added and one removed line is two lines of churn.
    expect(change).toMatchObject({ category: "ai coding", is_write: true, ai_line_changes: 2 });
    // bb's project and branch ride along as fallbacks only.
    expect(change).toMatchObject({ alternate_project: "app", alternate_branch: "main" });
    expect(inputs[0]!.groups[0]!.projectFolder).toBe("/work/app");
  });

  it("uses the plain coding category for a prompt the human sent", async () => {
    const { bb, harness } = fakeHost({ settings: { apiKey: "k" } });
    harness.sdk.stub("threads.events.list", async () => [
      { seq: 5, createdAt: Date.now(), type: "item/completed", data: { item: { type: "userMessage", id: "m1" } } },
    ]);
    await plugin(bb);

    const inputs = await runOnePoll(bb, harness);
    const heartbeats = inputs.flatMap((input) => input.groups.flatMap((group) => group.heartbeats));
    expect(heartbeats).toEqual([expect.objectContaining({ entity: "/work/app", category: "coding" })]);
  });

  it("honours the setting that merges agent time into plain coding", async () => {
    const { bb, harness } = fakeHost({ settings: { apiKey: "k", agentCategory: "coding" } });
    harness.sdk.stub("threads.events.list", async () => [fileChange]);
    await plugin(bb);

    const inputs = await runOnePoll(bb, harness);
    const heartbeats = inputs.flatMap((input) => input.groups.flatMap((group) => group.heartbeats));
    expect(heartbeats.every((heartbeat) => heartbeat.category === "coding")).toBe(true);
  });

  it("records what it sent so bb wakatime log can show it", async () => {
    const { bb, harness } = fakeHost({ settings: { apiKey: "k" } });
    harness.sdk.stub("threads.events.list", async () => [fileChange]);
    await plugin(bb);
    await runOnePoll(bb, harness);

    await waitFor(async () => {
      const result = (await harness.behavior.callRpc("recentActivity", { limit: 10 })) as {
        entries: { entity: string; isWrite: boolean }[];
      };
      return result.entries.some((entry) => entry.entity === "/work/app/src/a.ts" && entry.isWrite);
    });
  });

  it("hides file names in its own log when privacy asks for it", async () => {
    const { bb, harness } = fakeHost({ settings: { apiKey: "k", privacy: "obfuscate-file-names" } });
    harness.sdk.stub("threads.events.list", async () => [fileChange]);
    await plugin(bb);
    await runOnePoll(bb, harness);

    await waitFor(async () => {
      const result = (await harness.behavior.callRpc("recentActivity", { limit: 10 })) as {
        entries: { entity: string }[];
      };
      return result.entries.some((entry) => entry.entity === "/work/app/src/<hidden>");
    });
    const result = (await harness.behavior.callRpc("recentActivity", { limit: 10 })) as {
      entries: { entity: string }[];
    };
    expect(result.entries.every((entry) => !entry.entity.includes("a.ts"))).toBe(true);
  });
});

describe("wakatime backfill", () => {
  const WINDOW_START = Date.UTC(2026, 8, 20, 9);
  const editAt = (seq: number, at: number) => ({
    seq,
    createdAt: at,
    type: "item/completed",
    data: {
      item: {
        type: "fileChange",
        status: "completed",
        approvalStatus: null,
        changes: [{ path: "/work/app/src/gone.ts", kind: "update", diff: "--- a/x\n+++ b/x\n+one\n" }],
      },
    },
  });

  async function setup() {
    const host = fakeHost({ settings: { apiKey: "k" } });
    host.harness.sdk.stub("threads.list", async ({ offset = 0 }: { offset?: number }) =>
      offset === 0 ? [makeThreadResponse({ id: "thr_old", projectId: "proj_1", environmentId: "env_1", status: "idle" })] : []);
    host.harness.sdk.stub("threads.events.list", async ({ types, limit }: { types?: string[]; limit?: string }) => {
      if (Number(limit) > 100) throw new Error("HTTP 400: Thread event limit cannot exceed 100");
      return types?.includes("item/completed")
        ? [editAt(1, WINDOW_START - 60_000), editAt(2, WINDOW_START + 60_000), editAt(3, WINDOW_START + 10 * 60_000)]
        : [];
    });
    await plugin(host.bb);
    const run = (argv: string[]) => host.harness.behavior.runCli(["backfill-wakatime", ...argv]);
    const waitDone = () => waitFor(async () => /: (done|failed)/.test((await run(["--status"])).stdout), 10_000);
    return { ...host, run, waitDone };
  }

  const window = ["--from", new Date(WINDOW_START).toISOString(), "--to", new Date(WINDOW_START + 5 * 60_000).toISOString()];
  const sends = (harness: ReturnType<typeof fakeHost>["harness"]) =>
    harness.experimental_hostRpcCalls.filter((call) => call.method === "sendHeartbeats").map((call) => call.input as HeartbeatCallInput);

  it("plans without sending on a dry run", async () => {
    const { harness, run, waitDone } = await setup();
    expect((await run([...window, "--dry-run"])).exitCode).toBe(0);
    await waitDone();
    const status = (await run(["--status"])).stdout;
    expect(status).toContain("Dry run");
    expect(status).toContain("heartbeats: 1 planned");
    expect(sends(harness)).toHaveLength(0);
  });

  it("sends only the window, flagged so a removed worktree does not drop it, and refuses a repeat", async () => {
    const { harness, run, waitDone } = await setup();
    expect((await run(window)).exitCode).toBe(0);
    await waitDone();
    const heartbeats = sends(harness).flatMap((input) => input.groups.flatMap((group) => group.heartbeats));
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]).toMatchObject({ entity: "/work/app/src/gone.ts", time: (WINDOW_START + 60_000) / 1000, is_unsaved_entity: true });
    expect((await run(["--status"])).stdout).toContain("1 handed to wakatime-cli, 0 failed");

    const repeat = await run(window);
    expect(repeat.exitCode).toBe(1);
    expect(repeat.stderr).toContain("--force");
  }, 20_000);

  it("rejects a window that is missing or ends in the future", async () => {
    const { run } = await setup();
    expect((await run(["--from", "2026-09-20T00:00:00Z"])).exitCode).toBe(1);
    expect((await run(["--from", "2026-09-20T00:00:00Z", "--to", "2999-01-01T00:00:00Z"])).exitCode).toBe(1);
  });
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
