/**
 * Watches bb threads and turns their activity into WakaTime heartbeats.
 *
 * Every bb and wakatime-cli interaction arrives through `TrackerDeps`, so the
 * cursor, throttle, keepalive, and grouping rules are testable on their own.
 */

import {
  extractHeartbeats,
  keepaliveHeartbeat,
  lastFileEntityOf,
  type ThreadContext,
  type ThreadEventRowLike,
} from "./activity.js";
import { describe } from "./errors.js";
import {
  HeartbeatThrottle,
  throttleKey,
  type PendingHeartbeat,
  type WakatimeCategory,
  type WakatimeHeartbeat,
} from "./heartbeat.js";

export interface TrackerOptions {
  agentCategory: WakatimeCategory;
  humanCategory: WakatimeCategory | null;
  classifyCommands: boolean;
  trackFileReads: boolean;
  trackOutsideWorkspace: boolean;
  /** How often an otherwise silent active thread still reports time. */
  keepaliveMs: number;
  /** WakaTime's repeat-heartbeat suppression window. */
  throttleMs: number;
  /** Heartbeats older than this are dropped instead of backfilled. */
  staleAfterMs: number;
  maxEventsPerPoll: number;
}

export interface ThreadSummary {
  id: string;
  projectId: string;
  environmentId: string | null;
  status: string;
}

/**
 * A thread lookup. `missing` means bb is sure the thread is gone; `error`
 * means the lookup itself failed, which must not be mistaken for deletion.
 */
export type ThreadLookup =
  | { kind: "found"; thread: ThreadSummary }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export interface EnvironmentSummary {
  hostId: string;
  path: string | null;
  branchName: string | null;
}

export interface HeartbeatGroup {
  projectFolder: string | null;
  heartbeats: WakatimeHeartbeat[];
}

export interface SendOutcome {
  accepted: number;
  failures: { message: string; count: number }[];
}

export interface TrackerDeps {
  now(): number;
  options(): Promise<TrackerOptions>;
  log(level: "debug" | "info" | "warn" | "error", message: string): void;

  listEvents(args: { threadId: string; afterSeq: number | null; limit: number }): Promise<ThreadEventRowLike[]>;
  /** A thread's newest events, newest first. Used to place a fresh cursor. */
  recentEvents(args: { threadId: string; limit: number }): Promise<ThreadEventRowLike[]>;
  listActiveThreadIds(): Promise<string[]>;
  getThread(threadId: string): Promise<ThreadLookup>;
  getEnvironment(environmentId: string): Promise<EnvironmentSummary | null>;
  getProjectName(projectId: string): Promise<string | null>;

  readCursor(threadId: string): Promise<number | null>;
  writeCursor(threadId: string, seq: number): Promise<void>;
  clearCursor(threadId: string): Promise<void>;

  send(hostId: string, groups: HeartbeatGroup[]): Promise<SendOutcome>;
  /** Called once per batch with what was sent, for stats and the local log. */
  record(entries: readonly PendingHeartbeat[], outcome: SendOutcome): void;
}

/** Contract limits from the host RPC schema. */
const MAX_HEARTBEATS_PER_GROUP = 500;
const MAX_GROUPS_PER_CALL = 64;
/** Total heartbeats in one RPC call, so a busy server cannot build a huge payload. */
const MAX_HEARTBEATS_PER_CALL = 1000;
/** Re-resolve a thread's worktree, branch, and status at most this often. */
const CONTEXT_TTL_MS = 60_000;
/** Rediscover running threads every N polls, in case an event was missed. */
const RECONCILE_EVERY_POLLS = 10;
/** Events scanned backwards when placing a cursor for a newly seen thread. */
const CURSOR_LOOKBACK_EVENTS = 100;
/**
 * Polls a thread's cursor may stay blocked by send failures before it advances
 * anyway. Without a cap, one unreachable host would re-read the same events
 * forever.
 */
const MAX_BLOCKED_POLLS = 20;

interface TrackedThread {
  threadId: string;
  active: boolean;
  cursor: number | null;
  /** When this plugin first saw the thread running, for cursor placement. */
  firstSeenAt: number;
  context: ThreadContext | null;
  contextResolvedAt: number;
  lastEmittedAt: number;
  /** Most recent real file, reused as the keepalive target. */
  lastFileEntity: string | null;
  /** Consecutive polls whose cursor advance was held back by a failed send. */
  blockedPolls: number;
  /** Poll once more after a thread goes idle to pick up trailing events. */
  needsFinalDrain: boolean;
}

interface Collected {
  pending: PendingHeartbeat[];
  /** Cursor to commit, but only once the heartbeats are safely sent. */
  candidateCursor: number | null;
}

export class Tracker {
  private readonly threads = new Map<string, TrackedThread>();
  private throttle = new HeartbeatThrottle();
  private throttleMs: number | null = null;
  private pollCount = 0;
  private reconciled = false;

  constructor(private readonly deps: TrackerDeps) {}

  /** Threads currently being watched, for status output. */
  get trackedCount(): number {
    return this.threads.size;
  }

  get activeCount(): number {
    let count = 0;
    for (const thread of this.threads.values()) if (thread.active) count += 1;
    return count;
  }

  markActive(threadId: string): void {
    const existing = this.threads.get(threadId);
    if (existing) {
      existing.active = true;
      existing.needsFinalDrain = false;
      return;
    }
    this.threads.set(threadId, {
      threadId,
      active: true,
      cursor: null,
      firstSeenAt: this.deps.now(),
      context: null,
      contextResolvedAt: 0,
      lastEmittedAt: 0,
      lastFileEntity: null,
      blockedPolls: 0,
      needsFinalDrain: false,
    });
  }

  markIdle(threadId: string): void {
    const existing = this.threads.get(threadId);
    if (!existing || !existing.active) return;
    existing.active = false;
    existing.needsFinalDrain = true;
  }

  /** Drops a thread entirely, for archive and delete. */
  async forget(threadId: string): Promise<void> {
    this.threads.delete(threadId);
    await this.deps.clearCursor(threadId).catch(() => undefined);
  }

  /**
   * Runs one cycle: read new events for every tracked thread, add keepalives
   * for threads that are busy but quiet, then flush.
   */
  async poll(): Promise<{ collected: number; sent: number }> {
    const options = await this.deps.options();
    this.syncThrottle(options.throttleMs);
    this.pollCount += 1;

    if (!this.reconciled || this.pollCount % RECONCILE_EVERY_POLLS === 0) {
      await this.reconcileActiveThreads();
    }

    const now = this.deps.now();
    const pending: PendingHeartbeat[] = [];
    const collectedByThread = new Map<string, Collected>();
    const finished: string[] = [];

    for (const thread of [...this.threads.values()]) {
      try {
        const collected = await this.collectThread(thread, options, now);
        collectedByThread.set(thread.threadId, collected);
        pending.push(...collected.pending);
      } catch (error) {
        this.deps.log("warn", `failed reading thread ${thread.threadId}: ${describe(error)}`);
      }
      // An idle thread stays only long enough for one trailing drain.
      if (!thread.active) {
        if (thread.needsFinalDrain) thread.needsFinalDrain = false;
        else finished.push(thread.threadId);
      }
    }

    const { sent, failedThreadIds } = await this.flush(pending);
    await this.commitCursors(collectedByThread, failedThreadIds);

    for (const threadId of finished) this.threads.delete(threadId);
    return { collected: pending.length, sent };
  }

  /**
   * Advances a thread's cursor only once its heartbeats are through, so a
   * disconnected host means a retry next poll instead of lost time.
   */
  private async commitCursors(collected: Map<string, Collected>, failedThreadIds: ReadonlySet<string>): Promise<void> {
    for (const [threadId, result] of collected) {
      if (result.candidateCursor === null) continue;
      const thread = this.threads.get(threadId);
      if (!thread) continue;

      if (failedThreadIds.has(threadId)) {
        thread.blockedPolls += 1;
        if (thread.blockedPolls < MAX_BLOCKED_POLLS) {
          this.deps.log("debug", `holding cursor for ${threadId} after a failed send; will retry`);
          continue;
        }
        this.deps.log(
          "warn",
          `giving up on ${result.pending.length} heartbeat(s) for ${threadId} after ${thread.blockedPolls} failed sends`,
        );
      }

      thread.blockedPolls = 0;
      // The in-memory cursor moves only after the durable one, so a failed
      // write cannot silently skip a batch.
      try {
        await this.deps.writeCursor(threadId, result.candidateCursor);
        thread.cursor = result.candidateCursor;
      } catch (error) {
        this.deps.log("warn", `could not persist cursor for ${threadId}: ${describe(error)}`);
      }
    }
  }

  private syncThrottle(throttleMs: number): void {
    if (this.throttleMs === throttleMs) return;
    // A settings change resets the window rather than mixing two policies.
    this.throttle = new HeartbeatThrottle(throttleMs);
    this.throttleMs = throttleMs;
  }

  /**
   * Repairs tracking state from bb's own view. This is the safety net for a
   * missed lifecycle event in either direction: a thread that started without
   * its `thread.active` reaching us, and more importantly one that stopped
   * without its `thread.idle` doing so, which would otherwise keep emitting
   * keepalive heartbeats for work that ended.
   */
  private async reconcileActiveThreads(): Promise<void> {
    let ids: string[];
    try {
      ids = await this.deps.listActiveThreadIds();
    } catch (error) {
      this.deps.log("warn", `could not list active threads: ${describe(error)}`);
      return;
    }

    const active = new Set(ids);
    for (const id of active) this.markActive(id);
    for (const thread of this.threads.values()) {
      if (thread.active && !active.has(thread.threadId)) {
        this.deps.log("debug", `thread ${thread.threadId} is no longer active; stopping keepalives`);
        this.markIdle(thread.threadId);
      }
    }
    this.reconciled = true;
  }

  private async collectThread(thread: TrackedThread, options: TrackerOptions, now: number): Promise<Collected> {
    const empty: Collected = { pending: [], candidateCursor: null };
    const context = await this.resolveContext(thread, now);
    if (!context) return empty;

    if (thread.cursor === null) {
      const placed = await this.initialCursor(thread);
      if (placed === null) return empty;
      thread.cursor = placed;
    }

    const rows = await this.deps.listEvents({
      threadId: thread.threadId,
      afterSeq: thread.cursor,
      limit: options.maxEventsPerPoll,
    });

    const pending: PendingHeartbeat[] = [];
    let candidateCursor: number | null = null;
    if (rows.length > 0) {
      let maxSeq = thread.cursor ?? 0;
      for (const row of rows) if (row.seq > maxSeq) maxSeq = row.seq;
      const collected = extractHeartbeats(rows, context, options);
      pending.push(...collected);
      thread.lastFileEntity = lastFileEntityOf(collected) ?? thread.lastFileEntity;
      candidateCursor = maxSeq;
    }

    // Thinking, streaming, and waiting on a provider are still working time.
    if (thread.active && pending.length === 0 && now - thread.lastEmittedAt >= options.keepaliveMs) {
      const keepalive = keepaliveHeartbeat(context, now, options.agentCategory, thread.lastFileEntity);
      if (keepalive) pending.push(keepalive);
    }

    const fresh = pending.filter((entry) => now - entry.heartbeat.time * 1000 <= options.staleAfterMs);
    if (fresh.length !== pending.length) {
      this.deps.log("debug", `dropped ${pending.length - fresh.length} stale heartbeat(s) for ${thread.threadId}`);
    }
    if (fresh.length > 0) thread.lastEmittedAt = now;
    return { pending: fresh, candidateCursor };
  }

  /**
   * Places the cursor for a thread with no stored one.
   *
   * Installing the plugin must not backfill a thread's whole history, but
   * starting at the current tip would also throw away the work done between
   * the thread starting and this first poll. So the cursor lands just before
   * the oldest event that arrived after this plugin first saw the thread.
   */
  private async initialCursor(thread: TrackedThread): Promise<number | null> {
    const stored = await this.deps.readCursor(thread.threadId);
    if (stored !== null) return stored;

    const recent = await this.deps.recentEvents({
      threadId: thread.threadId,
      limit: CURSOR_LOOKBACK_EVENTS,
    });

    const placed = placeCursor(recent, thread.firstSeenAt);
    // Persisting the placement is safe and is what lets a restart resume:
    // it records where this thread's history stops being ours, not which
    // heartbeats were sent.
    await this.deps.writeCursor(thread.threadId, placed);
    return placed;
  }

  private async resolveContext(thread: TrackedThread, now: number): Promise<ThreadContext | null> {
    if (thread.context && now - thread.contextResolvedAt < CONTEXT_TTL_MS) return thread.context;

    const lookup = await this.deps.getThread(thread.threadId);
    if (lookup.kind === "missing") {
      this.threads.delete(thread.threadId);
      return null;
    }
    if (lookup.kind === "error") {
      // A failed lookup is not a deleted thread. Keep the last known context
      // rather than dropping a live thread on a transient error.
      this.deps.log("debug", `thread lookup failed for ${thread.threadId}: ${lookup.message}`);
      return thread.context;
    }

    const summary = lookup.thread;
    // bb's own status is the authority. A missed `thread.idle` event would
    // otherwise leave this thread emitting keepalives indefinitely.
    if (thread.active && summary.status !== "active" && summary.status !== "starting") {
      this.markIdle(thread.threadId);
    }
    if (!summary.environmentId) return null;

    const environment = await this.deps.getEnvironment(summary.environmentId);
    if (!environment) return null;

    const projectName = await this.deps.getProjectName(summary.projectId);
    const context: ThreadContext = {
      threadId: thread.threadId,
      hostId: environment.hostId,
      worktreePath: environment.path,
      branchName: environment.branchName,
      projectName,
    };
    thread.context = context;
    thread.contextResolvedAt = now;
    return context;
  }

  private async flush(
    pending: readonly PendingHeartbeat[],
  ): Promise<{ sent: number; failedThreadIds: ReadonlySet<string> }> {
    const failedThreadIds = new Set<string>();
    if (pending.length === 0) return { sent: 0, failedThreadIds };

    const admitted = pending.filter((entry) =>
      this.throttle.admit(throttleKey(entry), entry.heartbeat.time * 1000, entry.heartbeat.is_write === true),
    );
    if (admitted.length === 0) return { sent: 0, failedThreadIds };

    let sent = 0;
    for (const [hostId, entries] of groupByHost(admitted)) {
      for (const batch of chunkGroups(entries)) {
        try {
          const outcome = await this.deps.send(hostId, batch.groups);
          sent += outcome.accepted;
          if (outcome.failures.length > 0) {
            for (const entry of batch.entries) failedThreadIds.add(entry.threadId);
          }
          this.deps.record(batch.entries, outcome);
        } catch (error) {
          const message = describe(error);
          this.deps.log("warn", `sending ${batch.entries.length} heartbeat(s) to ${hostId} failed: ${message}`);
          for (const entry of batch.entries) failedThreadIds.add(entry.threadId);
          this.deps.record(batch.entries, { accepted: 0, failures: [{ message, count: batch.entries.length }] });
        }
      }
    }
    return { sent, failedThreadIds };
  }
}

/**
 * Chooses the starting sequence for a thread with no stored cursor.
 *
 * Anything already in the thread when this plugin first saw it is history and
 * is skipped. Anything that arrived since belongs to us, even if the first
 * poll is up to one interval late, which is what stops every thread from
 * losing its opening prompt and first few edits.
 */
export function placeCursor(recent: readonly ThreadEventRowLike[], firstSeenAt: number): number {
  if (recent.length === 0) return 0;
  const own = recent.filter((row) => row.createdAt >= firstSeenAt);
  if (own.length === 0) return Math.max(...recent.map((row) => row.seq));
  return Math.max(Math.min(...own.map((row) => row.seq)) - 1, 0);
}

export function groupByHost(entries: readonly PendingHeartbeat[]): Map<string, PendingHeartbeat[]> {
  const byHost = new Map<string, PendingHeartbeat[]>();
  for (const entry of entries) {
    const bucket = byHost.get(entry.hostId);
    if (bucket) bucket.push(entry);
    else byHost.set(entry.hostId, [entry]);
  }
  return byHost;
}

/**
 * Splits one host's heartbeats into RPC-sized batches, keeping each project
 * root in its own group because `--project-folder` is per invocation.
 */
export function chunkGroups(
  entries: readonly PendingHeartbeat[],
): { groups: HeartbeatGroup[]; entries: PendingHeartbeat[] }[] {
  const byFolder = new Map<string, PendingHeartbeat[]>();
  for (const entry of entries) {
    const key = entry.projectFolder ?? "";
    const bucket = byFolder.get(key);
    if (bucket) bucket.push(entry);
    else byFolder.set(key, [entry]);
  }

  const batches: { groups: HeartbeatGroup[]; entries: PendingHeartbeat[] }[] = [];
  let current: { groups: HeartbeatGroup[]; entries: PendingHeartbeat[] } = { groups: [], entries: [] };

  for (const bucket of byFolder.values()) {
    for (let index = 0; index < bucket.length; index += MAX_HEARTBEATS_PER_GROUP) {
      const slice = bucket.slice(index, index + MAX_HEARTBEATS_PER_GROUP);
      const wouldExceed = current.entries.length + slice.length > MAX_HEARTBEATS_PER_CALL;
      if (current.groups.length >= MAX_GROUPS_PER_CALL || (wouldExceed && current.groups.length > 0)) {
        batches.push(current);
        current = { groups: [], entries: [] };
      }
      current.groups.push({
        projectFolder: slice[0]!.projectFolder,
        heartbeats: slice.map((entry) => entry.heartbeat),
      });
      current.entries.push(...slice);
    }
  }

  if (current.groups.length > 0) batches.push(current);
  return batches;
}
