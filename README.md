# Agent Radar

A live, local dashboard of the AI agents running on this machine.

```sh
npm start            # → http://localhost:4747   (PORT=4848 npm start to change)
```

No dependencies — Node 18+ only.

## What it shows

- **Radar scope** — every Claude Code session is a blip. Working sessions sit at the
  centre; idle ones drift outward on a log scale by time since their last activity
  (rings at 1m / 10m / 1h / 6h). Sessions in the same project share a bearing.
  Running subagents orbit their parent. Hover for details, click to jump to the card.
- **The village (WebGL)** — a Clash-of-Clans-style village where every Claude Code
  session is a little builder and its building **rises as the agent actually works**:
  one level per 100k tokens the session holds in context, with the bricks of the level
  under construction filling in live as that number grows (it comes back down after
  `/clear`). Completing a level pops the roof up with a star burst and a "Level up!"
  banner. Each project is a paved district with its own roof colour and signpost.
  Builders hammer while their session runs tools, study blueprints while it reads,
  look up at the building while it thinks, point while subagents run (each running
  subagent is a teal-hatted apprentice working another wall), facepalm on a tool error,
  stand by when idle, and nap on a crate after 10 minutes. Click a builder to follow it
  (buildings in the way are cut away), click again for its card, Esc to zoom out.
  Rendering pauses when the section is off-screen or the tab is hidden.
  Buildings are saved: when a session closes, or `/clear` starts a new conversation, the
  builder packs up and the building stays where it stood, frozen at its level with the
  lights off. Every new conversation builds on the next plot of its district, and a
  resumed one gets its builder back. Hover a saved building for its title; click to fly to it.
- **Session cards** — status (working / idle / shell), AI-generated title, project and
  branch, what it is doing *right now* (current tool call, thinking, writing), model,
  context size, uptime, CPU and memory of the whole process tree, subagents from the
  last 6 hours, last prompt, and an expandable activity log.
- **The wire** — a merged, newest-first feed of prompts, tool calls, replies and errors
  across every session and subagent. Click an entry to jump to its session.
- **Also on this machine** — Claude Desktop, Codex, Cursor, ChatGPT, Windsurf, Gemini
  CLI, Aider, Ollama, Copilot and headless `claude -p` runs, found in the process table.
- **Presenter mode** — blurs prompts and tool details for screen sharing.
- **Themes** — Midnight (default), Control room, Phosphor and Daylight, picked from the
  swatches in the header and remembered per browser. Every colour lives in the theme
  blocks at the top of `public/styles.css`; the radar and the 3D floor read the same CSS
  variables, so adding a theme is one new block there plus a swatch.

## Where the data comes from

| Source | Used for |
| --- | --- |
| `~/.claude/sessions/<pid>.json` | live sessions, name, status, cwd, version |
| `~/.claude/projects/<cwd>/<session>.jsonl` (tail only) | title, model, context, activity |
| `…/<session>/subagents/*.jsonl` + `*.meta.json` | subagent type, task, state |
| `ps` | liveness, CPU, memory, uptime, other agent apps |

`~/.claude` is only ever read. `CLAUDE_CONFIG_DIR` is honoured if you've moved it.

The village's saved buildings live in `data/village.json` (one entry per conversation:
name, title, project, context size, start and close times). The server keeps it up to
date every 15s even with no page open; delete an entry or the whole file to demolish.

## Privacy

Transcripts contain your prompts and tool calls, so the server binds to `127.0.0.1`
only and rejects requests whose `Host` isn't a loopback name (DNS-rebinding guard).
Obvious secrets (URL credentials, `sk-…`/`ghp_…`/`AKIA…` keys, `token=…`) are masked
before they reach the page.
