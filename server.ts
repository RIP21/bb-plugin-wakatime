/**
 * bb WakaTime plugin: reports the time bb agents and their humans spend on code.
 *
 * The server watches thread events, turns them into heartbeats, and hands them
 * to a host worker that runs wakatime-cli on the machine holding the worktree.
 */

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { categorySchema, hostContract, privacyModeSchema, type HeartbeatPayload } from "./contract.js";
import type { WakatimeCategory } from "./lib/heartbeat.js";
import { describe as describeError, isNotFound } from "./lib/errors.js";
import { compactDuration } from "./lib/duration.js";
import {
  Tracker,
  type HeartbeatGroup,
  type SendOutcome,
  type TrackerDeps,
  type TrackerOptions,
} from "./lib/tracker.js";
import type { ThreadEventRowLike } from "./lib/activity.js";

const PLUGIN_VERSION = "0.1.0";

/** How often the tracker reads new thread events. */
const POLL_INTERVAL_MS = 30_000;
/** WakaTime's own repeat-heartbeat window, and the keepalive cadence. */
const HEARTBEAT_WINDOW_MS = 120_000;
/** Events older than this are not backfilled after a long outage. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_EVENTS_PER_POLL = 400;
/** Upper bound on one host round-trip, so a stuck worker cannot stall polling. */
const SEND_TIMEOUT_MS = 180_000;
/** How often WakaTime is asked for today's total, at most. */
const TODAY_REFRESH_MS = 5 * 60 * 1000;
/** Channel the sidebar accessory listens on. */
const TODAY_CHANNEL = "today";
/** Rows kept in the local activity log. */
const LOG_RETENTION_DAYS = 14;
const RECENT_LOG_LIMIT = 200;

const cliStatusOutput = z.object({
  path: z.string().nullable(),
  version: z.string().nullable(),
  origin: z.enum(["existing", "downloaded", "missing"]),
  hasConfiguredApiKey: z.boolean(),
  error: z.string().nullable(),
});

const hostStatusOutput = z.object({
  hostId: z.string(),
  name: z.string(),
  connected: z.boolean(),
  cli: cliStatusOutput.nullable(),
  offlineQueueCount: z.number().nullable(),
  today: z.string().nullable(),
  error: z.string().nullable(),
});

export const rpcContract = defineRpcContract({
  status: {
    input: z.object({ includeToday: z.boolean().default(false) }).strict(),
    output: z
      .object({
        apiKeySource: z.enum(["settings", "host-config", "missing", "unknown"]),
        tracking: z.object({ threads: z.number(), activeThreads: z.number() }),
        stats: z.object({
          sentToday: z.number(),
          failedToday: z.number(),
          lastSentAt: z.number().nullable(),
          lastError: z.string().nullable(),
        }),
        hosts: z.array(hostStatusOutput),
      })
      .strict(),
  },
  syncNow: {
    input: z.null(),
    output: z
      .object({
        results: z.array(
          z.object({
            hostId: z.string(),
            name: z.string(),
            queuedBefore: z.number().nullable(),
            queuedAfter: z.number().nullable(),
            error: z.string().nullable(),
          }),
        ),
      })
      .strict(),
  },
  todayStats: {
    input: z.null(),
    output: z
      .object({
        /** WakaTime's own total for today, e.g. "1 hr 2 mins". */
        total: z.string().nullable(),
        /** Same value squeezed for the sidebar, e.g. "1h 2m". */
        compact: z.string().nullable(),
        refreshedAt: z.number().nullable(),
        error: z.string().nullable(),
        activeThreads: z.number(),
        heartbeats: z.object({ sent: z.number(), failed: z.number() }),
        /** Local heartbeat counts per category, busiest first. */
        categories: z.array(z.object({ category: z.string(), heartbeats: z.number() })),
        /** Local heartbeat counts and line churn per project, busiest first. */
        projects: z.array(
          z.object({ project: z.string(), heartbeats: z.number(), lineChanges: z.number() }),
        ),
      })
      .strict(),
  },
  recentActivity: {
    input: z.object({ limit: z.number().int().min(1).max(RECENT_LOG_LIMIT).default(50) }).strict(),
    output: z
      .object({
        entries: z.array(
          z.object({
            sentAt: z.number(),
            entity: z.string(),
            category: z.string(),
            isWrite: z.boolean(),
            lineChanges: z.number().nullable(),
            ok: z.boolean(),
            error: z.string().nullable(),
          }),
        ),
      })
      .strict(),
  },
});

interface ActivityRow {
  sent_at: number;
  entity: string;
  category: string;
  is_write: number;
  line_changes: number | null;
  ok: number;
  error: string | null;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    apiKey: {
      type: "string",
      label: "API key",
      description:
        "Your WakaTime API key. Leave empty to use the ~/.wakatime.cfg already on each machine, shared with your other editors.",
      secret: true,
    },
    apiUrl: {
      type: "string",
      label: "API URL",
      description: "Override for a self-hosted WakaTime-compatible server such as Wakapi. Empty uses wakatime.com.",
      default: "",
    },
    agentCategory: {
      type: "select",
      label: "Category for agent work",
      description:
        "How agent activity is filed on your dashboard. Choosing 'coding' merges it with your own time instead of splitting it out.",
      options: ["ai coding", "coding"],
      default: "ai coding",
    },
    trackHumanActivity: {
      type: "boolean",
      label: "Track my own activity",
      description: "Count time when you send a prompt, filed as 'coding'.",
      default: true,
    },
    trackFileReads: {
      type: "boolean",
      label: "Track file reads",
      description: "Count files the agent read or searched, not only the ones it changed.",
      default: true,
    },
    classifyCommands: {
      type: "boolean",
      label: "Categorize shell commands",
      description: "Report test and build commands as 'running tests' and 'building' instead of coding.",
      default: true,
    },
    trackOutsideWorkspace: {
      type: "boolean",
      label: "Track files outside the worktree",
      description: "Report files the agent touched outside the thread's workspace. Off keeps time attributed to real projects.",
      default: false,
    },
    privacy: {
      type: "select",
      label: "Privacy",
      description:
        "'hide-project-folder' sends paths relative to the project root. 'obfuscate-file-names' sends no filenames at all.",
      options: ["none", "hide-project-folder", "obfuscate-file-names"],
      default: "none",
    },
    autoInstallCli: {
      type: "boolean",
      label: "Install wakatime-cli automatically",
      description: "Download wakatime-cli into ~/.wakatime on a machine that has none. An existing install is never modified.",
      default: true,
    },
    allowCliAiLogParsing: {
      type: "boolean",
      label: "Also let wakatime-cli read AI transcripts",
      description:
        "wakatime-cli can parse Claude and Codex transcript logs itself. Leave off so this plugin is the single source for bb activity.",
      default: false,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS activity (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       sent_at INTEGER NOT NULL,
       host_id TEXT NOT NULL,
       thread_id TEXT NOT NULL,
       entity TEXT NOT NULL,
       category TEXT NOT NULL,
       is_write INTEGER NOT NULL,
       line_changes INTEGER,
       ok INTEGER NOT NULL,
       error TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS activity_sent_at ON activity (sent_at DESC)`,
    // Appended, never edited: migration ids are statement indexes.
    `ALTER TABLE activity ADD COLUMN project TEXT`,
  ]);

  const insertActivity = db.prepare(
    `INSERT INTO activity (sent_at, host_id, thread_id, entity, category, is_write, line_changes, ok, error, project)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const host = bb.hosts.experimental_client({ contract: hostContract });

  let bbVersion: string | null = null;
  let lastError: string | null = null;

  /**
   * Today's total as WakaTime itself reports it. `--today` spawns a process and
   * calls the API, so it is cached rather than asked for on every render, and
   * the UI is nudged over realtime when it changes.
   */
  let today: { text: string | null; error: string | null; refreshedAt: number } = {
    text: null,
    error: null,
    refreshedAt: 0,
  };
  /** Heartbeats sent since the last refresh; zero means nothing can have changed. */
  let sentSinceTodayRefresh = 0;

  async function pluginUserAgent(): Promise<string> {
    if (!bbVersion) {
      try {
        bbVersion = (await bb.sdk.system.version()).currentVersion;
      } catch {
        bbVersion = "unknown";
      }
    }
    // WakaTime's convention is "<editor>/<version> <editor>-wakatime/<version>".
    return `bb/${bbVersion} bb-wakatime/${PLUGIN_VERSION}`;
  }

  async function cliOptions() {
    const values = await settings.get();
    const apiKey = values.apiKey?.trim();
    const apiUrl = values.apiUrl.trim();
    return {
      apiKey: apiKey && apiKey.length > 0 ? apiKey : null,
      apiUrl: apiUrl.length > 0 ? apiUrl : null,
      pluginUserAgent: await pluginUserAgent(),
      privacy: privacyModeSchema.parse(values.privacy),
      allowCliAiLogParsing: values.allowCliAiLogParsing,
      autoInstall: values.autoInstallCli,
    };
  }

  async function trackerOptions(): Promise<TrackerOptions> {
    const values = await settings.get();
    // Validated, not cast: an out-of-range value here would otherwise fail the
    // host contract's enum and lose the whole batch instead of one field.
    const parsed = categorySchema.safeParse(values.agentCategory);
    if (!parsed.success) {
      bb.log.warn(`ignoring unknown agent category ${JSON.stringify(values.agentCategory)}; using "ai coding"`);
    }
    const agentCategory: WakatimeCategory = parsed.success ? parsed.data : "ai coding";
    return {
      agentCategory,
      humanCategory: values.trackHumanActivity ? "coding" : null,
      classifyCommands: values.classifyCommands,
      trackFileReads: values.trackFileReads,
      trackOutsideWorkspace: values.trackOutsideWorkspace,
      keepaliveMs: HEARTBEAT_WINDOW_MS,
      throttleMs: HEARTBEAT_WINDOW_MS,
      staleAfterMs: STALE_AFTER_MS,
      maxEventsPerPoll: MAX_EVENTS_PER_POLL,
    };
  }

  const projectNames = new Map<string, string | null>();

  const deps: TrackerDeps = {
    now: () => Date.now(),
    options: trackerOptions,
    log: (level, message) => bb.log[level](message),

    async listEvents({ threadId, afterSeq, limit }) {
      const events = await bb.sdk.threads.events.list({
        threadId,
        order: "asc",
        limit: String(limit),
        types: ["item/completed"],
        ...(afterSeq !== null ? { afterSeq: String(afterSeq) } : {}),
      });
      return events as unknown as ThreadEventRowLike[];
    },

    async recentEvents({ threadId, limit }) {
      const events = await bb.sdk.threads.events.list({
        threadId,
        order: "desc",
        limit: String(limit),
        types: ["item/completed"],
      });
      return events as unknown as ThreadEventRowLike[];
    },

    async listActiveThreadIds() {
      // threads.list has no status filter, so the newest page is scanned. The
      // lifecycle events cover the normal path; this only repairs missed ones.
      const threads = await bb.sdk.threads.list({ limit: 200, includeHidden: true });
      return threads.filter((thread) => thread.status === "active").map((thread) => thread.id);
    },

    async getThread(threadId) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        return {
          kind: "found" as const,
          thread: {
            id: thread.id,
            projectId: thread.projectId,
            environmentId: thread.environmentId,
            status: thread.status,
          },
        };
      } catch (error) {
        // Only a genuine not-found means the thread is gone. Anything else is
        // a transient failure, and treating it as deletion would drop a live
        // thread or delete its cursor.
        return isNotFound(error) ? { kind: "missing" as const } : { kind: "error" as const, message: describeError(error) };
      }
    },

    async getEnvironment(environmentId) {
      try {
        const environment = await bb.sdk.environments.get({ environmentId });
        return {
          hostId: environment.hostId,
          path: environment.path,
          branchName: environment.branchName,
        };
      } catch {
        return null;
      }
    },

    async getProjectName(projectId) {
      const cached = projectNames.get(projectId);
      if (cached !== undefined) return cached;
      try {
        const project = await bb.sdk.projects.get({ projectId });
        // The personal project is not a real repository, so it names nothing.
        const name = project.kind === "personal" ? null : project.name;
        projectNames.set(projectId, name);
        return name;
      } catch {
        projectNames.set(projectId, null);
        return null;
      }
    },

    readCursor: async (threadId) => (await bb.storage.kv.get<number>(`cursor:${threadId}`)) ?? null,
    writeCursor: (threadId, seq) => bb.storage.kv.set(`cursor:${threadId}`, seq),
    clearCursor: (threadId) => bb.storage.kv.delete(`cursor:${threadId}`),

    async send(hostId: string, groups: HeartbeatGroup[]): Promise<SendOutcome> {
      const options = await cliOptions();
      // A send that hangs would stall the whole poll loop, so it gets a bound
      // of its own on top of the host worker's per-command timeout.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), SEND_TIMEOUT_MS);
      try {
        const result = await host.call(
          "sendHeartbeats",
          {
            groups: groups.map((group) => ({
              projectFolder: group.projectFolder,
              heartbeats: group.heartbeats as HeartbeatPayload[],
            })),
            options,
          },
          { hostId, signal: abort.signal },
        );
        if (result.cli.error) lastError = result.cli.error;
        else if (result.failures.length === 0) lastError = null;
        return {
          accepted: result.accepted,
          failures: result.failures.map((failure) => ({ message: failure.message, count: failure.count })),
        };
      } finally {
        clearTimeout(timer);
      }
    },

    record(entries, outcome) {
      const failure = outcome.failures[0]?.message ?? null;
      if (failure) lastError = failure;
      const ok = outcome.failures.length === 0;
      const sentAt = Date.now();
      void (async () => {
        // One settings read for the batch, not one per heartbeat.
        const redact = (await settings.get()).privacy === "obfuscate-file-names";
        for (const entry of entries) {
          insertActivity.run(
            sentAt,
            entry.hostId,
            entry.threadId,
            redact ? hideFileName(entry.heartbeat.entity) : entry.heartbeat.entity,
            entry.heartbeat.category,
            entry.heartbeat.is_write ? 1 : 0,
            entry.heartbeat.ai_line_changes ?? null,
            ok ? 1 : 0,
            failure,
            entry.heartbeat.alternate_project ?? null,
          );
        }
      })().catch((error: unknown) => {
        // A reload can close the database mid-batch. The log handle may be
        // stale too, so this must never rethrow into an unhandled rejection.
        try {
          bb.log.warn(`could not record activity: ${describeError(error)}`);
        } catch {
          // Nothing left to report to.
        }
      });
    },
  };

  const tracker = new Tracker(deps);

  bb.events.on("thread.active", ({ thread }) => {
    tracker.markActive(thread.id);
  });
  bb.events.on("thread.idle", ({ thread }) => {
    tracker.markIdle(thread.id);
  });
  bb.events.on("thread.failed", ({ thread }) => {
    tracker.markIdle(thread.id);
  });
  bb.events.on("thread.archived", ({ thread }) => {
    void tracker.forget(thread.id);
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    void tracker.forget(thread.id);
  });

  /**
   * Asks one connected machine for today's total. `--today` reports the
   * account's dashboard total, not that machine's, so the first answer is the
   * answer; the others would repeat it.
   */
  async function refreshToday(): Promise<void> {
    const options = await cliOptions();
    let hosts: { id: string; name: string }[];
    try {
      hosts = await connectedHosts();
    } catch (error) {
      today = { text: today.text, error: describeError(error), refreshedAt: Date.now() };
      return;
    }

    for (const entry of hosts) {
      try {
        const probe = await host.call("probe", { options, includeToday: true }, { hostId: entry.id });
        if (probe.today !== null) {
          publishToday({ text: probe.today, error: null, refreshedAt: Date.now() });
          return;
        }
        if (probe.todayError) {
          publishToday({ text: today.text, error: probe.todayError, refreshedAt: Date.now() });
          return;
        }
      } catch (error) {
        bb.log.debug(`could not read today's total from ${entry.name}: ${describeError(error)}`);
      }
    }
    today = { ...today, refreshedAt: Date.now() };
  }

  function publishToday(next: typeof today): void {
    const changed = next.text !== today.text || next.error !== today.error;
    today = next;
    sentSinceTodayRefresh = 0;
    // Ephemeral nudge; the UI refetches the real value over rpc.
    if (changed) bb.realtime.publish(TODAY_CHANNEL, { total: next.text });
  }

  async function connectedHosts(): Promise<{ id: string; name: string }[]> {
    const hosts = await bb.sdk.hosts.list();
    return hosts.filter((entry) => entry.status === "connected").map((entry) => ({ id: entry.id, name: entry.name }));
  }

  bb.background.service("tracker", {
    async start(signal) {
      await verifyApiKeyReachable();
      while (!signal.aborted) {
        try {
          const { collected, sent } = await tracker.poll();
          sentSinceTodayRefresh += sent;
          if (collected > 0) bb.log.debug(`collected ${collected} heartbeat(s), sent ${sent}`);
        } catch (error) {
          lastError = describeError(error);
          bb.log.warn(`tracker poll failed: ${lastError}`);
        }

        // Only ask WakaTime for a new total when something could have changed,
        // and never more than once per refresh window.
        const stale = Date.now() - today.refreshedAt >= TODAY_REFRESH_MS;
        if (stale && (sentSinceTodayRefresh > 0 || today.refreshedAt === 0)) {
          try {
            await refreshToday();
          } catch (error) {
            bb.log.debug(`refreshing today's total failed: ${describeError(error)}`);
          }
        }
        await sleep(POLL_INTERVAL_MS, signal);
      }
    },
  });

  /**
   * Reports `needs-configuration` when a probe proves no key is reachable.
   * A probe that fails outright is inconclusive, so it is left alone.
   */
  async function verifyApiKeyReachable(): Promise<void> {
    const options = await cliOptions();
    if (options.apiKey) return;
    let hosts: { id: string; name: string }[];
    try {
      hosts = await connectedHosts();
    } catch {
      return;
    }
    let probed = 0;
    for (const entry of hosts) {
      try {
        const probe = await host.call("probe", { options, includeToday: false }, { hostId: entry.id });
        probed += 1;
        if (probe.cli.hasConfiguredApiKey) return;
      } catch (error) {
        // Inconclusive for this machine; keep asking the others.
        bb.log.debug(`could not probe ${entry.name} for an API key: ${describeError(error)}`);
      }
    }
    // Only a machine that answered can prove a key is missing.
    if (probed > 0) {
      throw Object.assign(
        new Error(
          "No WakaTime API key found. Set one in the plugin settings, or run `wakatime-cli --config-write api_key <key>` on your machine, then reload the plugin.",
        ),
        { name: "NeedsConfigurationError" },
      );
    }
  }

  bb.background.schedule("sync-offline", "23 * * * *", async () => {
    // wakatime-cli queues heartbeats it could not send. Flush them hourly so a
    // network blip does not sit in the queue until the next agent run.
    const options = await cliOptions();
    for (const entry of await connectedHosts()) {
      try {
        await host.call("syncOffline", { options }, { hostId: entry.id });
      } catch (error) {
        bb.log.warn(`offline sync on ${entry.name} failed: ${describeError(error)}`);
      }
    }
  });

  bb.background.schedule("prune", "41 4 * * *", async () => {
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    db.prepare(`DELETE FROM activity WHERE sent_at < ?`).run(cutoff);
    // Cursors for threads that no longer exist would otherwise accumulate.
    for (const key of await bb.storage.kv.list("cursor:")) {
      const threadId = key.slice("cursor:".length);
      // Only a confirmed deletion removes a cursor. A transient lookup failure
      // here would reset a live thread to its tip and lose its place.
      const lookup = await deps.getThread(threadId);
      if (lookup.kind === "missing") await bb.storage.kv.delete(key);
    }
  });

  async function collectHostStatus(includeToday: boolean) {
    const options = await cliOptions();
    const hosts = await bb.sdk.hosts.list();
    const results = [] as {
      hostId: string;
      name: string;
      connected: boolean;
      cli: z.infer<typeof cliStatusOutput> | null;
      offlineQueueCount: number | null;
      today: string | null;
      error: string | null;
    }[];

    for (const entry of hosts) {
      if (entry.status !== "connected") {
        results.push({
          hostId: entry.id,
          name: entry.name,
          connected: false,
          cli: null,
          offlineQueueCount: null,
          today: null,
          error: null,
        });
        continue;
      }
      try {
        const probe = await host.call("probe", { options, includeToday }, { hostId: entry.id });
        results.push({
          hostId: entry.id,
          name: entry.name,
          connected: true,
          cli: probe.cli,
          offlineQueueCount: probe.offlineQueueCount,
          today: probe.today,
          error: probe.cli.error ?? probe.todayError,
        });
      } catch (error) {
        results.push({
          hostId: entry.id,
          name: entry.name,
          connected: true,
          cli: null,
          offlineQueueCount: null,
          today: null,
          error: describeError(error),
        });
      }
    }
    return results;
  }

  function dayStart(): number {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }

  function statsToday() {
    const since = dayStart();
    const row = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END), 0) AS sent,
           COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS failed,
           MAX(sent_at) AS last_sent_at
         FROM activity WHERE sent_at >= ?`,
      )
      .get(since) as { sent: number; failed: number; last_sent_at: number | null };
    return {
      sentToday: row.sent,
      failedToday: row.failed,
      lastSentAt: row.last_sent_at ?? null,
      lastError: lastError,
    };
  }

  async function apiKeySource(
    hosts: Awaited<ReturnType<typeof collectHostStatus>>,
  ): Promise<"settings" | "host-config" | "missing" | "unknown"> {
    const options = await cliOptions();
    if (options.apiKey) return "settings";
    const probed = hosts.filter((entry) => entry.cli !== null);
    if (probed.length === 0) return "unknown";
    return probed.some((entry) => entry.cli?.hasConfiguredApiKey) ? "host-config" : "missing";
  }

  bb.rpc.register(rpcContract, {
    async status({ includeToday }) {
      const hosts = await collectHostStatus(includeToday);
      return {
        apiKeySource: await apiKeySource(hosts),
        tracking: { threads: tracker.trackedCount, activeThreads: tracker.activeCount },
        stats: statsToday(),
        hosts,
      };
    },

    async syncNow() {
      const options = await cliOptions();
      const results = [];
      for (const entry of await connectedHosts()) {
        try {
          const result = await host.call("syncOffline", { options }, { hostId: entry.id });
          results.push({
            hostId: entry.id,
            name: entry.name,
            queuedBefore: result.queuedBefore,
            queuedAfter: result.queuedAfter,
            error: result.error,
          });
        } catch (error) {
          results.push({
            hostId: entry.id,
            name: entry.name,
            queuedBefore: null,
            queuedAfter: null,
            error: describeError(error),
          });
        }
      }
      return { results };
    },

    todayStats() {
      const since = dayStart();
      const stats = statsToday();
      const categories = db
        .prepare(
          `SELECT category, COUNT(*) AS heartbeats
             FROM activity WHERE sent_at >= ? AND ok = 1
             GROUP BY category ORDER BY heartbeats DESC`,
        )
        .all(since) as { category: string; heartbeats: number }[];
      const projects = db
        .prepare(
          // Files outside a worktree carry no bb project by design, and rows
          // written before this column existed have none either.
          `SELECT COALESCE(project, '(no project)') AS project,
                  COUNT(*) AS heartbeats,
                  COALESCE(SUM(line_changes), 0) AS line_changes
             FROM activity WHERE sent_at >= ? AND ok = 1
             GROUP BY COALESCE(project, '(no project)') ORDER BY heartbeats DESC`,
        )
        .all(since) as { project: string; heartbeats: number; line_changes: number }[];

      return {
        total: today.text,
        compact: compactDuration(today.text),
        refreshedAt: today.refreshedAt === 0 ? null : today.refreshedAt,
        error: today.error,
        activeThreads: tracker.activeCount,
        heartbeats: { sent: stats.sentToday, failed: stats.failedToday },
        categories,
        projects: projects.map((row) => ({
          project: row.project,
          heartbeats: row.heartbeats,
          lineChanges: row.line_changes,
        })),
      };
    },

    recentActivity({ limit }) {
      const rows = db
        .prepare(
          `SELECT sent_at, entity, category, is_write, line_changes, ok, error
             FROM activity ORDER BY sent_at DESC, id DESC LIMIT ?`,
        )
        .all(limit) as ActivityRow[];
      return {
        entries: rows.map((row) => ({
          sentAt: row.sent_at,
          entity: row.entity,
          category: row.category,
          isWrite: row.is_write === 1,
          lineChanges: row.line_changes,
          ok: row.ok === 1,
          error: row.error,
        })),
      };
    },
  });

  bb.cli.register({
    name: "wakatime",
    summary: "Inspect and control WakaTime time tracking for bb threads.",
    commands: [
      { name: "status", summary: "Show tracking state, wakatime-cli status, and today's totals", usage: "bb wakatime status" },
      { name: "today", summary: "Print today's WakaTime coding time per machine", usage: "bb wakatime today" },
      { name: "sync", summary: "Flush heartbeats wakatime-cli queued offline", usage: "bb wakatime sync" },
      { name: "doctor", summary: "Diagnose setup problems (missing CLI, missing API key)", usage: "bb wakatime doctor" },
      { name: "log", summary: "Show recently reported activity", usage: "bb wakatime log [-n <count>]" },
    ],
    async run(argv) {
      const [command = "status", ...rest] = argv;
      switch (command) {
        case "status":
          return { exitCode: 0, stdout: await renderStatus(true) };
        case "today":
          return { exitCode: 0, stdout: await renderToday() };
        case "sync":
          return renderSync();
        case "doctor":
          return renderDoctor();
        case "log":
          return { exitCode: 0, stdout: renderLog(parseCount(rest)) };
        default:
          return {
            exitCode: 1,
            stderr: `Unknown command '${command}'. Try status, today, sync, doctor, or log.\n`,
          };
      }
    },
  });

  async function renderStatus(
    includeToday: boolean,
    collected?: Awaited<ReturnType<typeof collectHostStatus>>,
  ): Promise<string> {
    // `doctor` passes its own probe results so each machine is asked once and
    // `--today` does not hit the WakaTime API twice per command.
    const hosts = collected ?? (await collectHostStatus(includeToday));
    const stats = statsToday();
    const source = await apiKeySource(hosts);
    const lines = [
      `Tracking:  ${tracker.activeCount} active of ${tracker.trackedCount} watched thread(s)`,
      `API key:   ${describeKeySource(source)}`,
      `Today:     ${stats.sentToday} heartbeat(s) sent, ${stats.failedToday} failed`,
    ];
    if (stats.lastError) lines.push(`Last error: ${stats.lastError}`);
    lines.push("", "Machines:");
    for (const entry of hosts) {
      if (!entry.connected) {
        lines.push(`  ${entry.name}: disconnected`);
        continue;
      }
      const version = entry.cli?.version ?? "not installed";
      const queue = entry.offlineQueueCount === null ? "" : `, ${entry.offlineQueueCount} queued`;
      const today = entry.today ? `, today ${entry.today}` : "";
      lines.push(`  ${entry.name}: ${version}${queue}${today}`);
      if (entry.error) lines.push(`    ${entry.error}`);
    }
    return `${lines.join("\n")}\n`;
  }

  async function renderToday(): Promise<string> {
    const hosts = await collectHostStatus(true);
    const lines = hosts
      .filter((entry) => entry.connected)
      .map((entry) => `${entry.name}: ${entry.today ?? entry.error ?? "unavailable"}`);
    return lines.length > 0 ? `${lines.join("\n")}\n` : "No connected machines.\n";
  }

  async function renderSync(): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
    const options = await cliOptions();
    const lines: string[] = [];
    let failed = false;
    for (const entry of await connectedHosts()) {
      try {
        const result = await host.call("syncOffline", { options }, { hostId: entry.id });
        if (result.error) {
          failed = true;
          lines.push(`${entry.name}: ${result.error}`);
        } else {
          const before = result.queuedBefore ?? 0;
          const after = result.queuedAfter ?? 0;
          lines.push(`${entry.name}: flushed ${Math.max(before - after, 0)}, ${after} still queued`);
        }
      } catch (error) {
        failed = true;
        lines.push(`${entry.name}: ${describeError(error)}`);
      }
    }
    const text = lines.length > 0 ? `${lines.join("\n")}\n` : "No connected machines.\n";
    return failed ? { exitCode: 1, stdout: text } : { exitCode: 0, stdout: text };
  }

  async function renderDoctor(): Promise<{ exitCode: number; stdout: string }> {
    const values = await settings.get();
    const hosts = await collectHostStatus(true);
    const source = await apiKeySource(hosts);
    const problems: string[] = [];

    if (source === "missing") {
      problems.push(
        "No API key. Set it in the plugin settings, or run `wakatime-cli --config-write api_key <key>` on the machine.",
      );
    }
    for (const entry of hosts) {
      if (!entry.connected) continue;
      if (!entry.cli) {
        problems.push(`${entry.name}: wakatime-cli is not installed and could not be probed.`);
      } else if (entry.error) {
        problems.push(`${entry.name}: ${entry.error}`);
      }
    }

    const lines = [
      "Settings:",
      `  agent category:        ${values.agentCategory}`,
      `  track my activity:     ${values.trackHumanActivity}`,
      `  track file reads:      ${values.trackFileReads}`,
      `  categorize commands:   ${values.classifyCommands}`,
      `  outside worktree:      ${values.trackOutsideWorkspace}`,
      `  privacy:               ${values.privacy}`,
      `  auto-install CLI:      ${values.autoInstallCli}`,
      `  CLI AI log parsing:    ${values.allowCliAiLogParsing}`,
      `  API URL:               ${values.apiUrl || "https://api.wakatime.com/api/v1/"}`,
      "",
      await renderStatus(true, hosts),
    ];
    if (tracker.trackedCount === 0) {
      // Not a problem: nothing is running right now, which is the normal state
      // of a fresh install, so it must not fail the exit code.
      lines.push("No threads are being watched right now; time is reported while a thread runs.", "");
    }
    if (problems.length > 0) {
      lines.push("Problems:");
      for (const problem of problems) lines.push(`  - ${problem}`);
      lines.push("");
    } else {
      lines.push("No problems found.", "");
    }
    return { exitCode: problems.length > 0 ? 1 : 0, stdout: lines.join("\n") };
  }

  function renderLog(count: number): string {
    const rows = db
      .prepare(
        `SELECT sent_at, entity, category, is_write, line_changes, ok, error
           FROM activity ORDER BY sent_at DESC, id DESC LIMIT ?`,
      )
      .all(count) as ActivityRow[];
    if (rows.length === 0) return "No activity reported yet.\n";
    const lines = rows.map((row) => {
      const when = new Date(row.sent_at).toISOString().slice(11, 19);
      const mark = row.ok === 1 ? " " : "!";
      const write = row.is_write === 1 ? "write" : "read ";
      const churn = row.line_changes === null ? "" : ` (${row.line_changes} lines)`;
      return `${mark} ${when} ${write} ${row.category.padEnd(14)} ${row.entity}${churn}${row.error ? ` -- ${row.error}` : ""}`;
    });
    return `${lines.join("\n")}\n`;
  }

  bb.log.info("WakaTime tracking registered");
}

/** Keeps a directory for context but drops the filename from the local log. */
function hideFileName(entity: string): string {
  const index = Math.max(entity.lastIndexOf("/"), entity.lastIndexOf("\\"));
  return index === -1 ? "<hidden>" : `${entity.slice(0, index)}/<hidden>`;
}

function describeKeySource(source: "settings" | "host-config" | "missing" | "unknown"): string {
  switch (source) {
    case "settings":
      return "from plugin settings";
    case "host-config":
      return "from ~/.wakatime.cfg on the machine";
    case "missing":
      return "MISSING -- nothing will be reported";
    default:
      return "unknown (no machine could be probed)";
  }
}

function parseCount(argv: readonly string[]): number {
  const index = argv.findIndex((arg) => arg === "-n" || arg === "--count");
  const raw = index >= 0 ? argv[index + 1] : undefined;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return 20;
  return Math.min(parsed, RECENT_LOG_LIMIT);
}

/** Resolves after `ms`, or as soon as the service is asked to stop. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
