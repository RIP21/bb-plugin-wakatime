/**
 * Rebuilds the heartbeats a stretch of bb activity should have sent, for a
 * window when reporting was down.
 *
 * It reuses the live path: `extractHeartbeats` for what the agent touched and
 * `keepaliveHeartbeat` for the time it spent thinking, which the live tracker
 * covers every 2 minutes while a thread runs. History has no "thread is
 * running" signal, so the dashboard's recorded turn intervals stand in for it.
 */

import {
  extractHeartbeats,
  keepaliveHeartbeat,
  type ExtractOptions,
  type ThreadContext,
  type ThreadEventRowLike,
} from "./activity.js";
import { HeartbeatThrottle, throttleKey, type PendingHeartbeat } from "./heartbeat.js";

export interface TurnSpan {
  start: number;
  end: number;
}

export interface ThreadBackfillInput {
  rows: readonly ThreadEventRowLike[];
  /** Completed agent turns for this thread, in any order. */
  turns: readonly TurnSpan[];
  context: ThreadContext;
  options: ExtractOptions & { keepaliveMs: number };
  /** Inclusive start and exclusive end of the window, in ms. */
  from: number;
  to: number;
}

/**
 * One thread's heartbeats for the window, oldest first.
 *
 * Every file heartbeat is marked unsaved. wakatime-cli silently drops a
 * heartbeat whose file is gone from disk, and most worktrees from weeks ago
 * have been removed since. The flag only skips that existence check; project
 * detection still falls back to the worktree folder and `alternate_project`.
 */
export function planThreadBackfill(input: ThreadBackfillInput): PendingHeartbeat[] {
  const { context, options, from, to } = input;
  const rows = input.rows.filter((row) => row.createdAt >= from && row.createdAt < to);
  const extracted = extractHeartbeats(rows, context, options).sort(byTime);

  const out = [...extracted];
  const spans = input.turns
    .map((turn) => ({ start: Math.max(turn.start, from), end: Math.min(turn.end, to) }))
    .filter((turn) => turn.end > turn.start)
    .sort((a, b) => a.start - b.start);

  for (const span of spans) {
    for (let at = span.start; at <= span.end; at += options.keepaliveMs) {
      // The live tracker only keepalives a thread that emitted nothing for a
      // full interval, so a real heartbeat in that interval stands in for it.
      if (hasHeartbeatWithin(extracted, at - options.keepaliveMs, at)) continue;
      const keepalive = keepaliveHeartbeat(context, at, options.agentCategory, lastFileBefore(extracted, at));
      if (keepalive) out.push(keepalive);
    }
  }

  for (const entry of out) {
    if (entry.heartbeat.entity_type === "file") entry.heartbeat.is_unsaved_entity = true;
  }
  return out.sort(byTime);
}

/**
 * Applies the live throttle across every thread at once, in time order, so a
 * backfill sends no more than the live tracker would have for the same work.
 */
export function throttleBackfill(pending: readonly PendingHeartbeat[], throttleMs: number): PendingHeartbeat[] {
  const throttle = new HeartbeatThrottle(throttleMs, Number.POSITIVE_INFINITY);
  return [...pending]
    .sort(byTime)
    .filter((entry) => throttle.admit(throttleKey(entry), entry.heartbeat.time * 1000, entry.heartbeat.is_write === true));
}

/**
 * The worktree a thread worked in, read back from its shell commands.
 *
 * bb drops an archived thread's environment, and with it the path, but every
 * command the agent ran still records its `cwd`. The most common one is the
 * worktree root: agents run from it far more than from any subdirectory.
 */
export function inferWorktreePath(rows: readonly ThreadEventRowLike[]): string | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const item = row.type === "item/completed" ? row.data?.item : undefined;
    if (item?.type !== "commandExecution" || !item.cwd) continue;
    counts.set(item.cwd, (counts.get(item.cwd) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [cwd, count] of counts) {
    if (count > bestCount) {
      best = cwd;
      bestCount = count;
    }
  }
  return best;
}

function byTime(a: PendingHeartbeat, b: PendingHeartbeat): number {
  return a.heartbeat.time - b.heartbeat.time;
}

/** True when a heartbeat in `sorted` falls in (after, until]. */
function hasHeartbeatWithin(sorted: readonly PendingHeartbeat[], after: number, until: number): boolean {
  const index = firstAfter(sorted, after);
  return index < sorted.length && sorted[index]!.heartbeat.time * 1000 <= until;
}

/** The latest real file touched at or before `at`, for a keepalive to reuse. */
function lastFileBefore(sorted: readonly PendingHeartbeat[], at: number): string | null {
  for (let index = firstAfter(sorted, at) - 1; index >= 0; index -= 1) {
    const entry = sorted[index]!;
    if (entry.entityKind === "file" && entry.heartbeat.entity_type === "file") return entry.heartbeat.entity;
  }
  return null;
}

/** Index of the first heartbeat strictly later than `at` ms. */
function firstAfter(sorted: readonly PendingHeartbeat[], at: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle]!.heartbeat.time * 1000 <= at) low = middle + 1;
    else high = middle;
  }
  return low;
}
