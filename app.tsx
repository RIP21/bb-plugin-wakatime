/**
 * WakaTime UI: a live total in the sidebar, the activity dashboard with what
 * was sent to WakaTime today, and a settings section for connection state.
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
import { ActiveThreadIndicator, Caption, Dashboard, Panel, Rows } from "./activity/dashboard";

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

/**
 * What reached WakaTime today, shown inside the dashboard. The dashboard's
 * figures are measured locally; this card is the account's own total.
 */
export function WakaTimeToday() {
  const { stats, error } = useTodayStats();
  const failed = stats?.heartbeats.failed ?? 0;
  const top = stats?.projects[0];

  return (
    <Panel
      index={1}
      title="WakaTime"
      note="Heartbeats this plugin sent today, and the total WakaTime derives from them"
      icon="clock"
      action={stats?.refreshedAt ? <Caption>read {formatAge(stats.refreshedAt)}</Caption> : null}
    >
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {!error && !stats ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {stats ? (
        <>
          <Rows
            items={[
              { label: "Today on WakaTime", value: stats.total ?? "not available yet" },
              {
                label: "Heartbeats sent",
                value: String(stats.heartbeats.sent),
                hint: failed > 0 ? `${failed} failed` : undefined,
              },
              { label: "Threads running", value: String(stats.activeThreads) },
              {
                label: "Busiest project",
                value: top?.project ?? "none yet",
                hint: top ? `${top.heartbeats} beats` : undefined,
              },
            ]}
          />
          {stats.error ? <p className="mt-4 text-sm text-destructive">{stats.error}</p> : null}
          {stats.heartbeats.sent === 0 && failed === 0 ? (
            <p className="mt-4 text-xs text-muted-foreground">
              Nothing reported yet today. Time is counted while a thread is running.
            </p>
          ) : null}
        </>
      ) : null}
    </Panel>
  );
}

function WakaTimePage() {
  return (
    <Dashboard>
      <WakaTimeToday />
    </Dashboard>
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
    component: WakaTimePage,
    headerContent: ActiveThreadIndicator,
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
