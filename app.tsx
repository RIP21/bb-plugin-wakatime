/**
 * WakaTime UI: a live total in the sidebar, a panel with today's breakdown, and
 * a settings section for connection state.
 *
 * On placement: bb's `sidebarFooterAction` next to Settings is host-rendered
 * chrome with deliberately empty props, so it can only be an icon button with a
 * static tooltip. The one place a plugin may paint a live value in the sidebar
 * is a nav row's `experimental_sidebarAccessory`, so today's total lives there
 * and the footer button is a shortcut to the full numbers.
 */

import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { rpcContract } from "./server";

interface TodayStats {
  total: string | null;
  compact: string | null;
  refreshedAt: number | null;
  error: string | null;
  activeThreads: number;
  heartbeats: { sent: number; failed: number };
  categories: { category: string; heartbeats: number }[];
  projects: { project: string; heartbeats: number; lineChanges: number }[];
}

interface Status {
  apiKeySource: "settings" | "host-config" | "missing" | "unknown";
  tracking: { threads: number; activeThreads: number };
  stats: { sentToday: number; failedToday: number; lastSentAt: number | null; lastError: string | null };
  hosts: {
    hostId: string;
    name: string;
    connected: boolean;
    cli: {
      path: string | null;
      version: string | null;
      origin: string;
      hasConfiguredApiKey: boolean;
      error: string | null;
    } | null;
    offlineQueueCount: number | null;
    today: string | null;
    error: string | null;
  }[];
}

const KEY_SOURCE_LABEL: Record<Status["apiKeySource"], string> = {
  settings: "Using the key from plugin settings",
  "host-config": "Using the key in ~/.wakatime.cfg on your machine",
  missing: "No API key found, so nothing is being reported",
  unknown: "Could not check for a key on any machine",
};

/** Loads today's stats and refetches when the server says they changed. */
function useTodayStats() {
  const rpc = useRpc<typeof rpcContract>();
  const [stats, setStats] = useState<TodayStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStats((await rpc.call("todayStats", null)) as TodayStats);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  // The signal carries no state worth trusting; it just means "ask again".
  useRealtime("today", () => {
    void load();
  });

  return { stats, error, reload: load };
}

/**
 * The trailing edge of the WakaTime sidebar row. The host clips this to a
 * single short line, so it shows only today's total and nothing else.
 */
function TodayAccessory() {
  const { stats } = useTodayStats();
  if (!stats?.compact) return null;
  return (
    <span
      className="text-xs text-muted-foreground tabular-nums"
      title={stats.total ? `WakaTime today: ${stats.total}` : undefined}
    >
      {stats.compact}
    </span>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

/** The panel page: today's total plus where the heartbeats went. */
function TodayPanel() {
  const { stats, error, reload } = useTodayStats();

  if (error) return <div className="p-4 text-sm text-destructive">{error}</div>;
  if (!stats) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;

  const noneYet = stats.heartbeats.sent === 0 && stats.heartbeats.failed === 0;

  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-3xl space-y-5">
        <div>
          <p className="text-3xl tabular-nums">{stats.total ?? "not available yet"}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Coding time today, as WakaTime counts it
            {stats.refreshedAt ? `, read ${formatAge(stats.refreshedAt)}` : ""}
          </p>
          {stats.error ? <p className="mt-1 text-sm text-destructive">{stats.error}</p> : null}
        </div>

        <div className="space-y-1 rounded-lg border border-border p-3">
          <StatRow label="Threads running" value={String(stats.activeThreads)} />
          <StatRow label="Heartbeats reported" value={String(stats.heartbeats.sent)} />
          {stats.heartbeats.failed > 0 ? (
            <StatRow label="Heartbeats failed" value={String(stats.heartbeats.failed)} />
          ) : null}
        </div>

        {noneYet ? (
          <p className="text-sm text-muted-foreground">
            Nothing reported yet today. Time is counted while a thread is running.
          </p>
        ) : null}

        {stats.projects.length > 0 ? (
          <section className="space-y-2">
            <h2 className="text-sm font-medium">Projects</h2>
            <div className="space-y-1 rounded-lg border border-border p-3">
              {stats.projects.map((project) => (
                <StatRow
                  key={project.project}
                  label={project.project}
                  value={
                    project.lineChanges > 0
                      ? `${project.heartbeats} beats, ${project.lineChanges} lines`
                      : `${project.heartbeats} beats`
                  }
                />
              ))}
            </div>
          </section>
        ) : null}

        {stats.categories.length > 0 ? (
          <section className="space-y-2">
            <h2 className="text-sm font-medium">Categories</h2>
            <div className="space-y-1 rounded-lg border border-border p-3">
              {stats.categories.map((category) => (
                <StatRow
                  key={category.category}
                  label={category.category}
                  value={`${category.heartbeats} beats`}
                />
              ))}
            </div>
          </section>
        ) : null}

        <p className="text-xs text-muted-foreground">
          Beats are heartbeats this plugin sent, counted locally. The time at the top comes from
          WakaTime itself, which derives it from the gaps between them.
        </p>

        <Button size="sm" variant="outline" onClick={() => void reload()}>
          Refresh
        </Button>
      </div>
    </div>
  );
}

function ConnectionSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);

  const load = useCallback(
    async (includeToday: boolean) => {
      setIsLoading(true);
      try {
        const result = (await rpc.call("status", { includeToday })) as Status;
        setStatus(result);
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setIsLoading(false);
      }
    },
    [rpc],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  const sync = useCallback(async () => {
    setIsSyncing(true);
    try {
      const { results } = await rpc.call("syncNow", null);
      const failed = results.filter((entry) => entry.error !== null);
      if (failed.length > 0) toast.error(`Sync failed on ${failed.map((entry) => entry.name).join(", ")}`);
      else toast.success("Queued heartbeats flushed");
      await load(true);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsSyncing(false);
    }
  }, [load, rpc]);

  if (error) {
    return <p className="text-sm text-destructive">{error}</p>;
  }
  if (!status) {
    return <p className="text-sm text-muted-foreground">{isLoading ? "Checking…" : "No status available."}</p>;
  }

  const keyMissing = status.apiKeySource === "missing";

  return (
    <div className="space-y-4">
      <p className={keyMissing ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
        {KEY_SOURCE_LABEL[status.apiKeySource]}
      </p>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Watching</dt>
        <dd>
          {status.tracking.activeThreads} active of {status.tracking.threads} thread
          {status.tracking.threads === 1 ? "" : "s"}
        </dd>
        <dt className="text-muted-foreground">Reported today</dt>
        <dd>
          {status.stats.sentToday} heartbeat{status.stats.sentToday === 1 ? "" : "s"}
          {status.stats.failedToday > 0 ? `, ${status.stats.failedToday} failed` : ""}
        </dd>
      </dl>

      <div className="space-y-2">
        {status.hosts.map((host) => (
          <div key={host.hostId} className="rounded-lg border border-border p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{host.name}</span>
              <span className="text-muted-foreground">
                {!host.connected ? "disconnected" : (host.cli?.version ?? "wakatime-cli not installed")}
              </span>
            </div>
            {host.today ? <p className="mt-1 text-muted-foreground">Today: {host.today}</p> : null}
            {host.offlineQueueCount !== null && host.offlineQueueCount > 0 ? (
              <p className="mt-1 text-muted-foreground">{host.offlineQueueCount} heartbeat(s) queued offline</p>
            ) : null}
            {host.error ? <p className="mt-1 text-destructive">{host.error}</p> : null}
          </div>
        ))}
      </div>

      {status.stats.lastError ? <p className="text-sm text-destructive">Last error: {status.stats.lastError}</p> : null}

      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={isLoading} onClick={() => void load(true)}>
          Refresh
        </Button>
        <Button size="sm" variant="outline" disabled={isSyncing} onClick={() => void sync()}>
          {isSyncing ? "Flushing…" : "Flush offline queue"}
        </Button>
      </div>
    </div>
  );
}

function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "a minute ago" : `${minutes} minutes ago`;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "today",
    title: "WakaTime",
    icon: "Clock",
    path: "today",
    component: TodayPanel,
    experimental_sidebarAccessory: TodayAccessory,
  });

  app.slots.sidebarFooterAction({
    id: "wakatime",
    title: "WakaTime time tracking",
    icon: "Clock",
    run: ({ openSettings }) => {
      openSettings();
    },
  });

  app.slots.settingsSection({
    id: "connection",
    title: "Connection",
    description: "Where heartbeats go and whether wakatime-cli can send them.",
    component: ConnectionSection,
  });
});
