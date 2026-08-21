// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const STATUS = {
  apiKeySource: "host-config",
  tracking: { threads: 2, activeThreads: 1 },
  stats: { sentToday: 14, failedToday: 0, lastSentAt: 1_700_000_000_000, lastError: null },
  hosts: [
    {
      hostId: "host_1",
      name: "laptop",
      connected: true,
      cli: { path: "/home/me/.wakatime/wakatime-cli", version: "v2.24.4", origin: "existing", hasConfiguredApiKey: true, error: null },
      offlineQueueCount: 3,
      today: "1 hr 2 mins",
      error: null,
    },
  ],
};

const TODAY = {
  total: "1 hr 2 mins",
  compact: "1h 2m",
  refreshedAt: Date.now(),
  error: null,
  activeThreads: 2,
  heartbeats: { sent: 41, failed: 0 },
  categories: [{ category: "ai coding", heartbeats: 39 }],
  projects: [{ project: "app", heartbeats: 39, lineChanges: 128 }],
};

async function mountAccessory(today: unknown = TODAY) {
  const app = await loadPluginApp(() => import("./app"));
  const accessory = app.navPanels[0]!.experimental_sidebarAccessory!;
  return renderSlot({ component: accessory }, {}, { rpc: { todayStats: () => today } });
}

async function mountPanel(today: unknown = TODAY) {
  const app = await loadPluginApp(() => import("./app"));
  return renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { todayStats: () => today } });
}

async function mount(status: unknown = STATUS) {
  const app = await loadPluginApp(() => import("./app"));
  const section = app.settingsSections[0]!;
  return renderSlot(section, {}, { rpc: { status: () => status, syncNow: () => ({ results: [] }) } });
}

describe("registration", () => {
  it("registers one settings section", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.settingsSections.map((section) => section.id)).toEqual(["connection"]);
    expect(app.settingsSections[0]!.title).toBe("Connection");
  });

  it("registers the sidebar row, its live accessory, and the footer button", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.navPanels.map((panel) => panel.id)).toEqual(["today"]);
    // The accessory is the only place bb lets a plugin paint live text in the
    // sidebar; the footer action is host-rendered chrome with no component.
    expect(app.navPanels[0]!.experimental_sidebarAccessory).toBeTypeOf("function");
    expect(app.sidebarFooterActions.map((action) => action.id)).toEqual(["wakatime"]);
  });

  it("gives the footer button an accessible label, since it is icon-only", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.sidebarFooterActions[0]!.title).toBe("WakaTime time tracking");
    expect(app.sidebarFooterActions[0]!.icon).toBeTruthy();
  });

  it("opens the plugin's page when the footer button is used", async () => {
    const app = await loadPluginApp(() => import("./app"));
    let opened = false;
    await app.sidebarFooterActions[0]!.run({ openSettings: () => (opened = true) });
    expect(opened).toBe(true);
  });
});

describe("sidebar accessory", () => {
  it("shows today's total in its compact form", async () => {
    const slot = await mountAccessory();
    await slot.findByText("1h 2m");
    slot.lifecycle.unmount();
  });

  it("renders nothing when there is no total to show", async () => {
    // Better an empty slot than a placeholder that looks like a real number.
    const slot = await mountAccessory({ ...TODAY, total: null, compact: null });
    expect(slot.container.textContent).toBe("");
    slot.lifecycle.unmount();
  });

  it("refetches when the server signals a change", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const accessory = app.navPanels[0]!.experimental_sidebarAccessory!;
    let compact = "1h 2m";
    const slot = renderSlot(
      { component: accessory },
      {},
      { rpc: { todayStats: () => ({ ...TODAY, compact }) } },
    );
    await slot.findByText("1h 2m");

    compact = "1h 7m";
    await slot.behavior.emitRealtime("today", { total: "1 hr 7 mins" });
    await slot.findByText("1h 7m");
    slot.lifecycle.unmount();
  });
});

describe("today panel", () => {
  it("leads with the total and shows where the time went", async () => {
    const slot = await mountPanel();
    await slot.findByText("1 hr 2 mins");
    await slot.findByText("app");
    await slot.findByText("ai coding");
    await slot.findByText("39 beats, 128 lines");
    slot.lifecycle.unmount();
  });

  it("says nothing has been reported rather than showing empty tables", async () => {
    const slot = await mountPanel({
      ...TODAY,
      total: null,
      compact: null,
      heartbeats: { sent: 0, failed: 0 },
      categories: [],
      projects: [],
    });
    await slot.findByText(/Nothing reported yet today/);
    slot.lifecycle.unmount();
  });

  it("surfaces a failure from WakaTime instead of a blank total", async () => {
    const slot = await mountPanel({ ...TODAY, total: null, compact: null, error: "unauthorized" });
    await slot.findByText("unauthorized");
    slot.lifecycle.unmount();
  });
});

describe("connection section", () => {
  it("shows where the key came from, the machine, and today's total", async () => {
    const slot = await mount();
    await slot.findByText("Using the key in ~/.wakatime.cfg on your machine");
    await slot.findByText("laptop");
    await slot.findByText("v2.24.4");
    await slot.findByText("Today: 1 hr 2 mins");
    await slot.findByText("3 heartbeat(s) queued offline");
    slot.lifecycle.unmount();
  });

  it("calls out a missing key, which is the one state that breaks tracking", async () => {
    const slot = await mount({ ...STATUS, apiKeySource: "missing" });
    await slot.findByText("No API key found, so nothing is being reported");
    slot.lifecycle.unmount();
  });

  it("says a disconnected machine is disconnected rather than broken", async () => {
    const slot = await mount({
      ...STATUS,
      hosts: [{ ...STATUS.hosts[0]!, connected: false, cli: null, today: null, offlineQueueCount: null }],
    });
    await slot.findByText("disconnected");
    slot.lifecycle.unmount();
  });

  it("reports when wakatime-cli is absent on a connected machine", async () => {
    const slot = await mount({ ...STATUS, hosts: [{ ...STATUS.hosts[0]!, cli: null, today: null }] });
    await slot.findByText("wakatime-cli not installed");
    slot.lifecycle.unmount();
  });

  it("surfaces an rpc failure instead of rendering an empty panel", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          status: () => {
            throw new Error("server unreachable");
          },
        },
      },
    );
    await slot.findByText("server unreachable");
    slot.lifecycle.unmount();
  });
});
