<div align="center">

# Pi Hermes Memory (adv)

*Your Pi agent forgets everything when the session ends. This fixes that.*

[![License: MIT](https://img.shields.io/badge/License-MIT-3fb950?style=flat-square&labelColor=black)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Finn763/pi-hermes-memory-adv?style=flat-square&logo=github&labelColor=black)](https://github.com/Finn763/pi-hermes-memory-adv/stargazers)
[![Tests](https://img.shields.io/badge/tests-732-8957e5?style=flat-square&labelColor=black)]

[中文](README.zh-CN.md) | English

</div>

> Most "memory" means dumping everything into the prompt. This one keeps it on
> disk, searchable, and out of your context until it is needed.

Pi agents wake up with amnesia — your stack, your conventions, the correction you
made yesterday, all gone with the session. Pi Hermes Memory gives the agent a
durable memory layer: global facts, your profile, per-project conventions and past
failures, stored as Markdown, mirrored into SQLite, and injected as a small
token-aware policy instead of a dump.

This is the **adv** fork of [chandra447/pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory)
(MIT), itself a port of the Hermes agent's memory design. On top of the upstream
engine it adds **staged background skill proposals** and **Hermes-aligned review
notifications**.

```bash
pi install git:github.com/Finn763/pi-hermes-memory-adv
```

One line. Restart Pi and it is already remembering — no setup, no per-session
configuration, no memory files to babysit.

---

## Why it exists

Four failure modes every long-running agent owner has met:

- **#1: Every session starts at zero.** You re-explain the project, the stack, the
  conventions, your preferences — every single time. **Fix:** four persistent stores
  (global facts, user profile, project conventions, failures) written to disk and
  searchable, so the agent only has to be told once.
- **#2: "Unlimited memory" that eats your context.** Dump-everything designs get
  more expensive every week. **Fix:** policy-only injection by default — the agent
  gets a small stable policy plus memory tools, not the whole store in every
  prompt; stores are capped and auto-consolidate instead of growing forever.
- **#3: Corrections and mistakes evaporate.** The thing you fixed on Monday bites
  again on Thursday. **Fix:** corrections are detected and saved immediately,
  failures are stored with the reason they failed, and a background review picks
  up what matters every 10 turns.
- **#4: Secrets get "helpfully" remembered.** API keys and tokens do not belong in
  memory. **Fix:** every memory and skill write passes a scanner first — keys,
  tokens and SSH keys are blocked from persistence.

---

## How it runs

![Pi Hermes Memory architecture](docs/architecture.svg)

Every path has the same shape: scan, then Markdown, then the mirror. The review
clock only wakes when there is something worth keeping.

[▶ Interactive version](https://finn763.github.io/pi-hermes-memory-adv/architecture.html)

1. **Session start** — a small memory policy (pinned instructions + pointers) is
   injected. The stores themselves stay one tool call away.
2. **While you work** — the agent writes with `memory_add` / `memory_replace` /
   `memory_remove`; corrections are detected and saved on the spot.
3. **Every 10 turns** (or 15 tool calls, once you have sent 3 messages) — a
   background review reads recent messages through a side-channel completion and
   saves what matters: `💾 Memory updated`.
4. **Skills** — procedures are captured with `skill_manage`; new proposals from a
   review are **staged for approval** (`/memory-skills pending`) instead of being
   written silently.
5. **When a store fills up** — auto-consolidation merges entries under a model pass
   instead of erroring. Nothing is dropped on the floor.
6. **Anytime** — `session_search` queries every past conversation via SQLite FTS5.

> The cadence follows the original Hermes design: `nudge_interval = 10` user turns,
> a hard gate of 3 user turns, one review in flight at a time. Silence means there
> was nothing worth keeping — not that the loop is broken.

---

## What it pins down

| Area | What's pinned down |
|---|---|
| Stores | `MEMORY.md` (facts, env, quirks) · `USER.md` (who you are) · project memory (per-repo conventions) · `failures.md` (what did not work, and why) |
| Injection | Policy-only by default — searchable, not dumped. Full context injection is opt-in |
| Review cadence | Every 10 turns / 15 tool calls, hard gate ≥3 user turns, never two reviews at once |
| Notifications | `off` / `on` / `verbose`, default `on` — same semantics as Hermes `display.memory_notifications` |
| Skills | Pi-native `SKILL.md`, written by the agent, staged for your approval by default |
| Secrets | Every write is scanned; API keys, tokens and SSH keys are blocked from persistence |
| Caps | 5,000 chars per store by default; auto-consolidation when full |

---

## Commands & tools

| Command | What it does |
|---|---|
| `/memory-review` *(alias `/refine`)* | Run a background review right now — bypasses the nudge gates |
| `/memory-skills` | Manage skills; `pending` lists staged proposals |
| `/memory-skill-approve` · `/memory-skill-reject` | Apply or discard a staged proposal by id — or `all` |
| `/memory-pin` | Pin a standing instruction injected into every session |
| `/memory-insights` | Show what is currently stored |
| `/memory-consolidate` | Consolidate the stores manually to free space |
| `/memory-index-sessions` | One-time import of past Pi sessions into search |
| `/memory-sync-markdown` | Reconcile the SQLite mirror with the Markdown stores |
| `/memory-preview-context` | Preview the memory policy injected this session |
| `/memory-interview` | Answer a few questions to pre-fill your profile |
| `/memory-switch-project` | Switch the active project for project-scoped memory |
| `/learn-memory-tool` | Guided tour of the memory tools |

Tools the agent calls on its own:
`memory_add` · `memory_replace` · `memory_remove` · `memory_search` · `session_search` · `skill_manage`.

---

## Installation

```bash
pi install git:github.com/Finn763/pi-hermes-memory-adv
```

Restart Pi (or run `/reload`), then optionally:

```bash
/memory-index-sessions    # one-time: make past sessions searchable
/memory-interview         # optional: pre-fill your profile
/memory-preview-context   # see what is being injected
```

Requires Pi ≥ 0.80.6. Config lives in `~/.pi/agent/hermes-memory-config.json` and
is read when the extension starts — edit it, then restart Pi or `/reload`.

<details>
<summary><strong>Other ways in</strong></summary>

| Source | Command |
|---|---|
| Git (this repo) | `pi install git:github.com/Finn763/pi-hermes-memory-adv` |
| Local checkout | `pi install ./pi-hermes-memory-adv` |
| One-shot trial | `pi -e git:github.com/Finn763/pi-hermes-memory-adv` |
| Uninstall | `pi remove git:github.com/Finn763/pi-hermes-memory-adv` |

</details>

---

## Where it lives

```
~/.pi/agent/
├── hermes-memory-config.json       # configuration
├── pi-hermes-memory/
│   ├── MEMORY.md                   # global facts (env, conventions, quirks)
│   ├── USER.md                     # who you are: preferences, style
│   ├── failures.md                 # what did not work, and why
│   ├── sessions.db                 # SQLite: memory mirror + full-text session search
│   ├── skills/                     # self-managed skills (SKILL.md)
│   └── pending/                    # staged skill proposals awaiting approval
└── projects-memory/<project>/      # per-project memory + skills
```

<details>
<summary><strong>Configuration keys</strong></summary>

| Key | Default | Notes |
|---|---|---|
| `memoryMode` | `"policy-only"` | `legacy-inject` = full context injection |
| `lazyInitialization` | `false` | `true` + `policy-only` = initialize on first use |
| `nudgeInterval` | `10` | user turns between background reviews |
| `nudgeToolCalls` | `15` | …or this many tool calls |
| `reviewEnabled` | `true` | master switch for the background loop |
| `reviewNotifications` | `"on"` | `off` / `on` / `verbose` |
| `reviewTransport` | `"direct"` | side-channel completion, falls back to a `pi -p` subprocess |
| `skillReviewMode` | `"stage"` | `stage` / `apply` / `off` for background skill proposals |
| `memoryCharLimit` · `userCharLimit` · `projectCharLimit` | `5000` | per-store caps before consolidation |
| `correctionDetection` | `true` | save corrections immediately |
| `failureInjectionEnabled` | `true` | surface relevant past failures |
| `flushOnShutdown` · `flushOnCompact` | `true` | session-end flush |

Full set: [`src/config.ts`](src/config.ts) → `DEFAULT_CONFIG`.

</details>

<details>
<summary><strong>Upgrade notes</strong></summary>

Startup auto-migrates legacy data safely — no manual action needed:

- `~/.pi/agent/memory` → `~/.pi/agent/pi-hermes-memory`
- flat skills `skills/*.md` → `skills/<slug>/SKILL.md` (fixes Pi skill-index
  conflicts like `name "..." does not match parent directory "skills"`)

Launch Pi once after upgrading and the migration runs.

</details>

---

<details>
<summary><strong>Repo layout</strong></summary>

```
src/index.ts        # extension entry: stores, tools, commands, lifecycle
src/handlers/       # background review, skills, consolidation, session search, …
src/stores/         # Markdown + SQLite stores
tests/              # full test suite
docs/               # architecture diagrams, roadmap, publishing notes
docs/README-full.md # the full legacy manual
```

</details>

## Development

```bash
git clone https://github.com/Finn763/pi-hermes-memory-adv.git
cd pi-hermes-memory-adv
npm install
npm run check     # tsc --noEmit + dev checks
npm test          # full test suite
```

Works from a full checkout only; the packaged form omits tests and TypeScript.

## Credits

Ported from [chandra447/pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory) (MIT),
itself a port of the Hermes agent's memory design. This fork adds staged background
skill proposals and Hermes-aligned review notifications, and keeps upstream
attribution and the MIT licence.

## License

[MIT](LICENSE)

*Remember once. Never twice.*
