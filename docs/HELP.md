# HIVV — the short help

**This file is the fallback.** `hivv.org` serves the CLI, the wrapper, the
installer, the rescue script *and* the online help. If hivv.org is down — or
worse, compromised — every one of those entry points dies with it, and the
hub is the very thing you need to fix.

This file lives in the git repository, so it is reachable when the site is
not. **Read it, bookmark it, and keep it somewhere the site cannot touch.**

---

## What HIVV is

A distributed AI network. Your computer runs the model, other people's
computers run the model too, and the hub (hivv.org) is a phone book and a
relay broker — not a bottleneck. Traffic goes node → node directly.

- **The hive** — the collective. **HIVV** — the brand, the thing itself.
- The hub is a *registry*, not a landlord. If hivv.org dies, the bees keep
  talking to each other.

---

## Install

```bash
curl -sSL https://hivv.org/install-hivv.sh | bash
```

No sudo needed if you use the user-local prefix (`--prefix=$HOME/.local`).
On Windows (PowerShell):

```powershell
iwr -useb https://hivv.org/install-hivv.ps1 | iex
```

---

## IF HIVV.ORG IS DOWN

Everything below comes from the git repository, which is a different host
with a different owner. The layout is identical (`public_html/` mirrors what
the site serves).

| What you want | Command |
|---|---|
| install | `curl -sSL https://raw.githubusercontent.com/htmlfarmer/hivv/main/public_html/install-hivv.sh \| bash` |
| repair a broken install | `curl -sSL https://raw.githubusercontent.com/htmlfarmer/hivv/main/public_html/rescue \| bash` |
| update an existing CLI | `hivv update --from-github` |
| this help | `https://github.com/htmlfarmer/hivv/blob/main/docs/HELP.md` |
| report a problem | `https://github.com/htmlfarmer/hivv/issues` — **not** the hub; the hub is the thing that is down |

`hivv fallback` prints all of this from the machine itself, with no network
at all. If you have the CLI installed, run that first.

### What still works when the hub is down

- Your local model (`hivv chat --local`, `hivv llm status`).
- The local tool server (`hivv tools test`).
- Peer-to-peer traffic between bees that can already reach each other.
- `hivv watch status` — the local supervisor keeps the local services alive.

### What does not

- Registration, heartbeat, relay, the shared tool catalog, `hivv support`.

---

## IF YOU SUSPECT HIVV.ORG IS COMPROMISED

**Do not use your installed `hivv` binary to fix it.** If the hub served a
backdoored CLI, your binary may be the thing that is compromised, and it can
lie to you about what it is doing.

Fetch a known-good copy **by hand**, from the repository, at a **commit SHA**
(a SHA is immutable — GitHub serves those bytes forever).

**Step 1 — stop the bleeding.** The agent polls the hub every 5 minutes. If
the hub is serving a backdoored CLI it will pull it straight back over your
fix. Block the auto-update first:

```bash
hivv dev on        # blocks the auto-update (a marker file, not a setting)
```

**Step 2 — fetch a known-good copy.**

```bash
# find the current commit (one request)
git ls-remote https://github.com/htmlfarmer/hivv main

# fetch the CLI at that SHA — NOT at main, which moves
curl -fsSL https://raw.githubusercontent.com/htmlfarmer/hivv/<COMMIT-SHA>/public_html/hivv-cli.py \
  -o ~/.local/lib/hivv/hivv-cli.py
```

**Step 3 — verify it.**

```bash
python3 ~/.local/lib/hivv/hivv-cli.py --version     # -> 0.2.<sha256[:8]>
sha256sum ~/.local/lib/hivv/hivv-cli.py             # must start with that hash
```

When you trust the hub again: `hivv dev off`.

The version string is a content hash of the file, so you can check a
download **without trusting hivv.org for a checksum**. The same trick works
for the wrapper and the installer.

Then say so: open an issue at the repository, and — if you run a hive — tell
the other bees (`hivv fallback` prints the report command).

---

## The commands that matter

### Talking
| Command | What it does |
|---|---|
| `hivv chat "msg"` | ask the hive (any bee answers) |
| `hivv chat --local "msg"` | ask THIS machine's model only — no network at all |
| `hivv ask <bee> "msg"` | ask ONE bee by name |
| `hivv completions "msg"` | OpenAI-compatible endpoint |

### Running a bee
| Command | What it does |
|---|---|
| `hivv start` / `stop` / `restart` | the background agent (registers + heartbeats) |
| `hivv status` | pid, uptime, last heartbeat, hub health |
| `hivv boot on\|off` | start the agent at login |
| `hivv nodes` | the live roster, with a hive total |
| `hivv free` / `pct` | host memory, disk, live CPU |

### Keeping it alive
| Command | What it does |
|---|---|
| `hivv watch status` | the watchdog: what it watches, what is healthy, what it restarted |
| `hivv watch on\|off` | install / remove the dedicated watchdog service |
| `hivv watch reset <svc>` | clear a quarantine (a human looked at it) |
| `hivv tools on\|off\|status` | the local tool server (and its health) |
| `hivv doctor --fix` | repair a broken install |

### Tools
| Command | What it does |
|---|---|
| `hivv tools list` | the whole catalog, and who shares what |
| `hivv tools test` | the diagnostic — real tool calls, both ways |
| `hivv call <tool> --json '{...}'` | invoke any tool directly |
| `hivv exec '<code>'` | run code in the isolated sandbox |

### Keeping up to date
| Command | What it does |
|---|---|
| `hivv update` | pull the latest CLI (LLM-reviewed before it is applied) |
| `hivv update --from-github` | pull it from the repository instead of the hub |
| `hivv update --show-review` | the last review verdict and its findings |
| `hivv fallback` | where to get the CLI if the hub is gone |
| `hivv upgrades` | every update the hive applied, and who blocked what |

---

## The one rule that keeps GitHub safe

The agent checks for updates every 5 minutes on every bee. If that check
ever fell back to GitHub, a hive of N bees would make N requests every 5
minutes against a third party's CDN. **That is a flood**, and GitHub would
rightly answer with a rate limit or an IP ban — taking every bee behind that
address down with it.

So: **GitHub is a place a human goes on purpose.** The automatic path never
touches it. Every deliberate GitHub fetch passes a guard that allows one
per minute per machine, so even a mistaken loop cannot hammer it.

This is a law, not a habit — it is pinned by a test.

---

## Reporting a problem

- The hub is down or broken → `https://github.com/htmlfarmer/hivv/issues`
- The hub is UP → `hivv submit "what went wrong"` (a human reads the queue)
- `hivv support "question"` — asks the support AI and attaches your bee's
  context (hub, version, agent status, metrics, the last 10 log lines).
  It needs the hub, so it is no use when the hub is down.
