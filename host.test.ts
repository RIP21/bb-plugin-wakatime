/**
 * Drives the host entry through the SDK's own harness with the child process
 * layer faked. Worker startup, crashes, and artifact verification belong to bb's
 * own integration tests, not here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface SpawnCall {
  command: string;
  args: string[];
  stdin: string;
}

interface FakeCli {
  version: string | null;
  configuredApiKey: string;
  offlineCount: string;
  today: string;
  /** Exit code and stderr for a heartbeat or sync invocation. */
  heartbeatExit: number;
  heartbeatStderr: string;
}

const spawnCalls: SpawnCall[] = [];
let cli: FakeCli;
let executablePaths: Set<string>;
/** Models a CLI that exits before draining a large --extra-heartbeats payload. */
let stdinEmitsEpipe = false;

type CliResponse = { code: number; stdout: string; stderr: string };

/** Per-test override, for asserting behavior across repeated invocations. */
let respondFor: (args: string[]) => CliResponse | null = () => null;

/** Answers like wakatime-cli does: one behavior per mode flag. */
function respond(args: string[]): CliResponse {
  const override = respondFor(args);
  if (override) return override;
  if (args.includes("--version")) {
    return cli.version === null
      ? { code: 1, stdout: "", stderr: "not executable" }
      : { code: 0, stdout: `${cli.version}\n`, stderr: "" };
  }
  if (args.includes("--config-read")) return { code: 0, stdout: cli.configuredApiKey, stderr: "" };
  if (args.includes("--offline-count")) return { code: 0, stdout: cli.offlineCount, stderr: "" };
  if (args.includes("--today")) return { code: 0, stdout: cli.today, stderr: "" };
  return { code: cli.heartbeatExit, stdout: "", stderr: cli.heartbeatStderr };
}

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[]) => {
    const call: SpawnCall = { command, args, stdin: "" };
    spawnCalls.push(call);
    const handlers = new Map<string, ((value?: unknown) => void)[]>();
    const on = (event: string, handler: (value?: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    };
    const emit = (event: string, value?: unknown) => {
      for (const handler of handlers.get(event) ?? []) handler(value);
    };

    setTimeout(() => {
      if (!executablePaths.has(command)) {
        emit("close", 127);
        return;
      }
      const result = respond(args);
      if (result.stdout) emit("stdoutData", Buffer.from(result.stdout));
      if (result.stderr) emit("stderrData", Buffer.from(result.stderr));
      emit("close", result.code);
    }, 0);

    const stdinHandlers: ((error: Error) => void)[] = [];
    return {
      stdout: { on: (_event: string, handler: (chunk: Buffer) => void) => on("stdoutData", handler as never) },
      stderr: { on: (_event: string, handler: (chunk: Buffer) => void) => on("stderrData", handler as never) },
      stdin: {
        on: (_event: string, handler: (error: Error) => void) => stdinHandlers.push(handler),
        end: (value?: string) => {
          call.stdin = value ?? "";
          if (!stdinEmitsEpipe) return;
          const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
          if (stdinHandlers.length === 0) throw epipe;
          for (const handler of stdinHandlers) handler(epipe);
        },
      },
      on: (event: string, handler: (value?: unknown) => void) => on(event, handler),
      kill: () => undefined,
    };
  },
}));

vi.mock("node:fs", () => ({
  access: (path: string, _mode: number, callback: (error: Error | null) => void) => {
    callback(executablePaths.has(path) ? null : new Error("ENOENT"));
  },
  constants: { X_OK: 1 },
}));

vi.mock("node:fs/promises", () => ({
  chmod: vi.fn(async () => undefined),
  copyFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  symlink: vi.fn(async () => undefined),
  unlink: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}));

vi.mock("node:os", () => ({ homedir: () => "/home/me" }));

const CLI_PATH = "/home/me/.wakatime/wakatime-cli";

const OPTIONS = {
  apiKey: null,
  apiUrl: null,
  pluginUserAgent: "bb/0.39.0 bb-wakatime/0.1.0",
  privacy: "none" as const,
  allowCliAiLogParsing: false,
  autoInstall: false,
};

const HEARTBEAT = {
  entity: "/work/app/src/a.ts",
  entity_type: "file" as const,
  category: "ai coding" as const,
  time: 1787216428.61818,
  is_write: true,
  ai_line_changes: 3,
};

async function makeHarness() {
  const { experimental_createHostEntryHarness } = await import("@get-bb/plugin-sdk/testing/host");
  const hostEntry = (await import("./host.js")).default;
  return experimental_createHostEntryHarness(hostEntry);
}

beforeEach(() => {
  spawnCalls.length = 0;
  executablePaths = new Set([CLI_PATH]);
  respondFor = () => null;
  stdinEmitsEpipe = false;
  cli = {
    version: "v2.24.4",
    configuredApiKey: "",
    offlineCount: "0\n",
    today: "1 hr 2 mins\n",
    heartbeatExit: 0,
    heartbeatStderr: "",
  };
  // host.ts caches its resolved CLI at module scope, so each test gets a fresh
  // module instance.
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Invocations that send heartbeats, as opposed to --version style probes. */
function heartbeatCalls(): SpawnCall[] {
  return spawnCalls.filter((call) => call.args.includes("--entity"));
}

describe("sendHeartbeats", () => {
  it("runs wakatime-cli once per project root", async () => {
    const harness = await makeHarness();
    const result = await harness.experimental_call("sendHeartbeats", {
      groups: [
        { projectFolder: "/work/app", heartbeats: [HEARTBEAT] },
        { projectFolder: "/work/other", heartbeats: [{ ...HEARTBEAT, entity: "/work/other/b.ts" }] },
      ],
      options: OPTIONS,
    });

    expect(result.accepted).toBe(2);
    expect(result.failures).toEqual([]);
    expect(heartbeatCalls()).toHaveLength(2);
    expect(heartbeatCalls()[0]!.command).toBe(CLI_PATH);
    expect(heartbeatCalls().map((call) => call.args[call.args.indexOf("--project-folder") + 1])).toEqual([
      "/work/app",
      "/work/other",
    ]);
  });

  it("passes extra heartbeats on stdin as a single line", async () => {
    const harness = await makeHarness();
    await harness.experimental_call("sendHeartbeats", {
      groups: [
        { projectFolder: "/work/app", heartbeats: [HEARTBEAT, { ...HEARTBEAT, entity: "/work/app/src/b.ts" }] },
      ],
      options: OPTIONS,
    });

    const call = heartbeatCalls()[0]!;
    expect(call.args).toContain("--extra-heartbeats");
    // A multi-line array makes wakatime-cli drop every extra while exiting 0.
    expect(call.stdin.split("\n")).toHaveLength(1);
    expect(JSON.parse(call.stdin)).toEqual([{ ...HEARTBEAT, entity: "/work/app/src/b.ts" }]);
  });

  it("sends nothing on stdin for a single heartbeat", async () => {
    const harness = await makeHarness();
    await harness.experimental_call("sendHeartbeats", {
      groups: [{ projectFolder: "/work/app", heartbeats: [HEARTBEAT] }],
      options: OPTIONS,
    });
    expect(heartbeatCalls()[0]!.args).not.toContain("--extra-heartbeats");
    expect(heartbeatCalls()[0]!.stdin).toBe("");
  });

  it("reports a non-zero exit as a failure with the CLI's own message", async () => {
    cli.heartbeatExit = 2;
    cli.heartbeatStderr = "failed sending heartbeats: 401 unauthorized";
    const harness = await makeHarness();
    const result = await harness.experimental_call("sendHeartbeats", {
      groups: [{ projectFolder: "/work/app", heartbeats: [HEARTBEAT] }],
      options: OPTIONS,
    });

    expect(result.accepted).toBe(0);
    expect(result.failures).toEqual([
      { projectFolder: "/work/app", count: 1, exitCode: 2, message: "failed sending heartbeats: 401 unauthorized" },
    ]);
  });

  it("fails every heartbeat, with a reason, when the CLI is missing", async () => {
    executablePaths = new Set();
    const harness = await makeHarness();
    const result = await harness.experimental_call("sendHeartbeats", {
      groups: [{ projectFolder: "/work/app", heartbeats: [HEARTBEAT, { ...HEARTBEAT, entity: "/b.ts" }] }],
      options: OPTIONS,
    });

    expect(result.cli.origin).toBe("missing");
    expect(result.accepted).toBe(0);
    expect(result.failures[0]).toMatchObject({ count: 2, exitCode: null });
    expect(result.failures[0]!.message).toMatch(/not installed/);
    expect(heartbeatCalls()).toHaveLength(0);
  });

  it("counts a partial failure per project root rather than all or nothing", async () => {
    const harness = await makeHarness();
    let invocation = 0;
    const original = respondFor;
    // The first heartbeat invocation fails; the second succeeds.
    respondFor = (args) => {
      if (!args.includes("--entity")) return null;
      invocation += 1;
      return invocation === 1 ? { code: 1, stdout: "", stderr: "first root failed" } : { code: 0, stdout: "", stderr: "" };
    };
    try {
      const result = await harness.experimental_call("sendHeartbeats", {
        groups: [
          { projectFolder: "/work/app", heartbeats: [HEARTBEAT] },
          { projectFolder: "/work/other", heartbeats: [{ ...HEARTBEAT, entity: "/work/other/b.ts" }] },
        ],
        options: OPTIONS,
      });
      expect(result.accepted).toBe(1);
      expect(result.failures).toEqual([
        { projectFolder: "/work/app", count: 1, exitCode: 1, message: "first root failed" },
      ]);
    } finally {
      respondFor = original;
    }
  });
});

describe("robustness", () => {
  it("survives a CLI that closes stdin early", async () => {
    // Without a stdin error listener this EPIPE would take down the worker
    // process, stopping tracking on the whole machine.
    stdinEmitsEpipe = true;
    const harness = await makeHarness();
    const result = await harness.experimental_call("sendHeartbeats", {
      groups: [
        { projectFolder: "/work/app", heartbeats: [HEARTBEAT, { ...HEARTBEAT, entity: "/work/app/b.ts" }] },
      ],
      options: OPTIONS,
    });
    expect(result.accepted).toBe(2);
  });

  it("says a command timed out rather than reporting a bare exit code", async () => {
    const harness = await makeHarness();
    respondFor = (args) => (args.includes("--entity") ? { code: 1, stdout: "", stderr: "" } : null);
    const result = await harness.experimental_call("sendHeartbeats", {
      groups: [{ projectFolder: "/work/app", heartbeats: [HEARTBEAT] }],
      options: OPTIONS,
    });
    expect(result.failures[0]!.message).toBe("wakatime-cli exited 1");
  });

  it("keeps the API key out of anything it reports back", async () => {
    // Captured stderr flows into the settings UI, so a CLI that ever echoed
    // its argv must not carry the key with it.
    const key = "waka_fixture-not-a-real-api-key";
    cli.heartbeatExit = 1;
    cli.heartbeatStderr = `invalid arguments: --key ${key}`;
    const harness = await makeHarness();
    const result = await harness.experimental_call("sendHeartbeats", {
      groups: [{ projectFolder: "/work/app", heartbeats: [HEARTBEAT] }],
      options: { ...OPTIONS, apiKey: key },
    });
    expect(result.failures[0]!.message).not.toContain(key);
    expect(result.failures[0]!.message).toContain("<redacted>");
  });

  it("does not retry an install on every send after it fails", async () => {
    executablePaths = new Set();
    const harness = await makeHarness();
    const call = () =>
      harness.experimental_call("sendHeartbeats", {
        groups: [{ projectFolder: "/work/app", heartbeats: [HEARTBEAT] }],
        options: { ...OPTIONS, autoInstall: false },
      });

    const first = await call();
    const second = await call();
    // Both report the failure, but the second must not have gone looking again;
    // GitHub allows 60 unauthenticated requests an hour and polling is 30s.
    expect(first.cli.origin).toBe("missing");
    expect(second.cli.origin).toBe("missing");
    expect(second.cli.error).toBeTruthy();
  });
});

describe("probe", () => {
  it("reports the installed version and the offline queue depth", async () => {
    cli.offlineCount = "7\n";
    const harness = await makeHarness();
    const result = await harness.experimental_call("probe", { options: OPTIONS, includeToday: false });
    expect(result.cli.path).toBe(CLI_PATH);
    expect(result.cli.version).toBe("v2.24.4");
    expect(result.offlineQueueCount).toBe(7);
  });

  it("reports a key in the machine's config as a boolean, never the key itself", async () => {
    cli.configuredApiKey = "fixture-not-a-real-api-key\n";
    const harness = await makeHarness();
    const result = await harness.experimental_call("probe", { options: OPTIONS, includeToday: false });
    expect(result.cli.hasConfiguredApiKey).toBe(true);
    expect(JSON.stringify(result)).not.toContain("fixture-not-a-real");
  });

  it("reports no configured key when the config is empty", async () => {
    const harness = await makeHarness();
    const result = await harness.experimental_call("probe", { options: OPTIONS, includeToday: false });
    expect(result.cli.hasConfiguredApiKey).toBe(false);
  });

  it("says the CLI is missing rather than downloading one", async () => {
    executablePaths = new Set();
    const harness = await makeHarness();
    const result = await harness.experimental_call("probe", { options: OPTIONS, includeToday: true });
    expect(result.cli.origin).toBe("missing");
    expect(result.cli.error).toMatch(/not found/);
    expect(spawnCalls.some((call) => call.args.includes("--today"))).toBe(false);
  });

  it("reports no time today as a zero, not as a failure", async () => {
    cli.today = "";
    const harness = await makeHarness();
    const result = await harness.experimental_call("probe", { options: OPTIONS, includeToday: true });
    expect(result.today).toBe("0 secs");
    expect(result.todayError).toBeNull();
  });

  it("asks for today's total only when requested", async () => {
    const harness = await makeHarness();
    await harness.experimental_call("probe", { options: OPTIONS, includeToday: false });
    expect(spawnCalls.some((call) => call.args.includes("--today"))).toBe(false);

    spawnCalls.length = 0;
    const result = await harness.experimental_call("probe", { options: OPTIONS, includeToday: true });
    expect(spawnCalls.some((call) => call.args.includes("--today"))).toBe(true);
    expect(result.today).toBe("1 hr 2 mins");
  });
});

describe("syncOffline", () => {
  it("flushes the whole queue without inventing a heartbeat", async () => {
    const harness = await makeHarness();
    const result = await harness.experimental_call("syncOffline", { options: OPTIONS });
    const sync = spawnCalls.find((call) => call.args.includes("--sync-offline-activity"));
    expect(sync).toBeDefined();
    // Zero means "all", and no --entity means no new heartbeat is created.
    expect(sync!.args[sync!.args.indexOf("--sync-offline-activity") + 1]).toBe("0");
    expect(sync!.args).not.toContain("--entity");
    expect(result.error).toBeNull();
  });

  it("surfaces the CLI's error text", async () => {
    cli.heartbeatExit = 1;
    cli.heartbeatStderr = "api error: connection refused";
    const harness = await makeHarness();
    const result = await harness.experimental_call("syncOffline", { options: OPTIONS });
    expect(result.error).toBe("api error: connection refused");
  });

  it("reports the queue depth on both sides of the flush", async () => {
    cli.offlineCount = "4\n";
    const harness = await makeHarness();
    const result = await harness.experimental_call("syncOffline", { options: OPTIONS });
    expect(result.queuedBefore).toBe(4);
    expect(result.queuedAfter).toBe(4);
  });
});

describe("privacy and identity flags", () => {
  it("always identifies bb in the User-Agent and disables CLI transcript parsing", async () => {
    const harness = await makeHarness();
    await harness.experimental_call("sendHeartbeats", {
      groups: [{ projectFolder: "/work/app", heartbeats: [HEARTBEAT] }],
      options: OPTIONS,
    });
    const args = heartbeatCalls()[0]!.args;
    expect(args[args.indexOf("--plugin") + 1]).toBe("bb/0.39.0 bb-wakatime/0.1.0");
    expect(args).toContain("--sync-ai-disabled");
  });

  it("lets the CLI parse transcripts when explicitly allowed", async () => {
    const harness = await makeHarness();
    await harness.experimental_call("sendHeartbeats", {
      groups: [{ projectFolder: "/work/app", heartbeats: [HEARTBEAT] }],
      options: { ...OPTIONS, allowCliAiLogParsing: true },
    });
    expect(heartbeatCalls()[0]!.args).not.toContain("--sync-ai-disabled");
  });

  it("forwards the obfuscation flag when privacy demands it", async () => {
    const harness = await makeHarness();
    await harness.experimental_call("sendHeartbeats", {
      groups: [{ projectFolder: "/work/app", heartbeats: [HEARTBEAT] }],
      options: { ...OPTIONS, privacy: "obfuscate-file-names" },
    });
    const args = heartbeatCalls()[0]!.args;
    expect(args[args.indexOf("--hide-file-names") + 1]).toBe(".*");
  });

  it("passes an explicit key and self-hosted URL straight through", async () => {
    const harness = await makeHarness();
    await harness.experimental_call("sendHeartbeats", {
      groups: [{ projectFolder: "/work/app", heartbeats: [HEARTBEAT] }],
      options: { ...OPTIONS, apiKey: "k", apiUrl: "https://wakapi.example/api/v1" },
    });
    const args = heartbeatCalls()[0]!.args;
    expect(args[args.indexOf("--key") + 1]).toBe("k");
    expect(args[args.indexOf("--api-url") + 1]).toBe("https://wakapi.example/api/v1");
  });
});
