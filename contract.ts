/**
 * The RPC contract shared by the server entry and the host worker.
 *
 * The server decides *what* to report; the host worker owns wakatime-cli and is
 * the only side that touches a machine's files, config, or network.
 */

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { WAKATIME_CATEGORIES } from "./lib/heartbeat.js";

export const categorySchema = z.enum(WAKATIME_CATEGORIES);

export const heartbeatSchema = z
  .object({
    entity: z.string().min(1),
    entity_type: z.enum(["file", "app", "domain", "url"]),
    category: categorySchema,
    time: z.number().positive(),
    is_write: z.boolean().optional(),
    is_unsaved_entity: z.boolean().optional(),
    ai_line_changes: z.number().int().nonnegative().optional(),
    human_line_changes: z.number().int().nonnegative().optional(),
    lines: z.number().int().nonnegative().optional(),
    alternate_project: z.string().optional(),
    alternate_branch: z.string().optional(),
    alternate_language: z.string().optional(),
  })
  .strict();

export type HeartbeatPayload = z.infer<typeof heartbeatSchema>;

/**
 * One wakatime-cli invocation. `--project-folder` is a process-wide flag with
 * no per-heartbeat equivalent, so heartbeats are grouped by their project root.
 */
export const heartbeatGroupSchema = z
  .object({
    projectFolder: z.string().nullable(),
    heartbeats: z.array(heartbeatSchema).min(1).max(500),
  })
  .strict();

export const privacyModeSchema = z.enum(["none", "hide-project-folder", "obfuscate-file-names"]);

export const cliOptionsSchema = z
  .object({
    /** API key from plugin settings; null falls back to the host's own config. */
    apiKey: z.string().nullable(),
    /** Override for a self-hosted WakaTime-compatible server. */
    apiUrl: z.string().nullable(),
    /** The `--plugin` User-Agent fragment, e.g. `bb/0.39.0 bb-wakatime/0.1.0`. */
    pluginUserAgent: z.string().min(1),
    privacy: privacyModeSchema,
    /** Let wakatime-cli also parse local AI transcript logs on this run. */
    allowCliAiLogParsing: z.boolean(),
    /** Download wakatime-cli when the host has none. */
    autoInstall: z.boolean(),
  })
  .strict();

export const cliStatusSchema = z
  .object({
    path: z.string().nullable(),
    version: z.string().nullable(),
    /** How the binary was found: an existing install, or one we downloaded. */
    origin: z.enum(["existing", "downloaded", "missing"]),
    hasConfiguredApiKey: z.boolean(),
    error: z.string().nullable(),
  })
  .strict();

export const hostContract = defineRpcContract({
  /** Sends grouped heartbeats through wakatime-cli, installing it if needed. */
  sendHeartbeats: {
    input: z
      .object({
        groups: z.array(heartbeatGroupSchema).min(1).max(64),
        options: cliOptionsSchema,
      })
      .strict(),
    output: z
      .object({
        cli: cliStatusSchema,
        accepted: z.number().int().nonnegative(),
        failures: z.array(
          z
            .object({
              projectFolder: z.string().nullable(),
              count: z.number().int().positive(),
              exitCode: z.number().int().nullable(),
              message: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
  },

  /** Reports what this host can do, for the settings page and `bb wakatime`. */
  probe: {
    input: z.object({ options: cliOptionsSchema, includeToday: z.boolean() }).strict(),
    output: z
      .object({
        cli: cliStatusSchema,
        offlineQueueCount: z.number().int().nonnegative().nullable(),
        /** wakatime-cli's own `--today` summary, e.g. "2 hrs 14 mins". */
        today: z.string().nullable(),
        todayError: z.string().nullable(),
      })
      .strict(),
  },

  /** Flushes heartbeats wakatime-cli queued while offline or rate limited. */
  syncOffline: {
    input: z.object({ options: cliOptionsSchema }).strict(),
    output: z
      .object({
        cli: cliStatusSchema,
        /** Queue depth before the flush; null when the CLI could not report it. */
        queuedBefore: z.number().int().nonnegative().nullable(),
        queuedAfter: z.number().int().nonnegative().nullable(),
        error: z.string().nullable(),
      })
      .strict(),
  },
});

export type HostContract = typeof hostContract;
