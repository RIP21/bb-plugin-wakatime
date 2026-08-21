---
name: wakatime
description: Inspect or troubleshoot WakaTime time tracking for bb threads. Use when the user asks how much time was tracked or coded today, whether WakaTime is recording, why their WakaTime dashboard is missing bb activity, or mentions heartbeats, wakatime-cli, or a WakaTime API key.
---

# WakaTime tracking in bb

This plugin reports the time bb threads spend on code to WakaTime. It watches
thread events, turns them into heartbeats, and runs `wakatime-cli` on the
machine that owns the worktree.

## Where the user sees it

Today's total shows beside the WakaTime row in the sidebar, and that row opens a
page with the per-project and per-category breakdown. A footer button next to
Settings jumps to the plugin's settings page.

The sidebar total comes from `wakatime-cli --today`, cached and refreshed at
most every 5 minutes and only when new heartbeats went out, so it can lag real
activity by a few minutes. `bb wakatime today` asks for it fresh.

## Commands

```
bb wakatime status    # tracking state, wakatime-cli version, today's totals
bb wakatime today     # today's coding time per machine
bb wakatime sync      # flush heartbeats wakatime-cli queued offline
bb wakatime doctor    # diagnose a missing CLI or API key; exits 1 on a problem
bb wakatime log -n 20 # the last heartbeats this plugin sent
```

Start with `bb wakatime doctor` for any "it isn't tracking" question. It prints
the effective settings and names the problem.

## What counts as tracked time

| bb activity | Heartbeat |
| --- | --- |
| Agent edits or writes a file | that file, `is_write`, with the diff's line count as `ai_line_changes` |
| Agent reads or searches a file | that file, no write flag |
| Agent runs a shell command | the working directory, categorized `building` or `running tests` where the command says so |
| You send a prompt | the worktree root, category `coding` |
| Thread running but touching nothing | the last file it touched, every 2 minutes, so thinking time counts |

Agent work is filed under the `ai coding` category and human work under
`coding`, so the dashboard can separate them. Setting the agent category to
`coding` merges both.

## Things that surprise people

- **Nothing is reported for an idle thread.** Time accrues while a thread runs.
- **A newly watched thread counts from when the plugin first saw it.** Enabling
  the plugin does not backfill history, but it does not discard the start of a
  thread either.
- **Files outside the worktree are skipped by default**, so time is not
  misfiled under the wrong project.
- **Extra heartbeats do not inflate a project's time.** WakaTime derives
  duration from the gaps between heartbeats, so a denser stream adds detail,
  not minutes. But durations are computed per project and then summed, so N
  threads running in parallel across N worktrees can total more than
  wall-clock time for the day. That is real parallel work, not a bug.
- **`wakatime-cli` also parses Claude and Codex transcripts on its own.** This
  plugin disables that on its own runs so bb activity has one source. If the
  user sees duplicate-looking attribution, check the
  "Also let wakatime-cli read AI transcripts" setting.
- **The API key can live in two places**: the plugin's secret setting, or
  `~/.wakatime.cfg` on the machine. `bb wakatime status` says which is in use.

## Changing settings

Settings live in Extensions → Plugins → WakaTime, or:

```
bb plugin config wakatime set trackFileReads false
bb plugin reload wakatime
```

Most settings take effect on the next poll. The exception is recovery from
`needs-configuration`, which the plugin enters when no API key is reachable:
that check runs at service start, so after setting a key run
`bb plugin reload wakatime`.
