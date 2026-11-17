# Wiring your GUI tools to HIVV

`hivv setup` detects what you have and points it at HIVV. One command, no
manual JSON editing.

```bash
hivv setup              # show everything, change nothing
hivv setup --dry-run    # show what WOULD be written
hivv setup --gui        # actually write the GUI tool configs
```

---

## The four profiles

| Profile | What it does |
|---|---|
| `--profile hybrid` **(default)** | **Your local model first, the HIVV hive as fallback** |
| `--profile local` | Your model only — nothing leaves this machine |
| `--profile hive` | The global HIVV network (hivv.org and its peers) |
| `--profile cloud` | A cloud provider key you supplied |

### Why hybrid is the default

When your IDE asks a question:

1. The request goes to **your** model — free, private, instant.
2. If your model is busy, asleep, or does not know the answer, it falls
   through to the **hive** (a peer, or a donated cloud key) instead of failing.
3. Meanwhile, because your box is already running a model, the hive may use
   your **idle** capacity — that is the donation.

Nothing you type ever gets donated. Donation shares **compute**, never
prompts or files.

---

## What it can wire up

### VS Code family (VS Code, Cursor, Windsurf, VSCodium)

| Tool | Config written |
|---|---|
| **Continue** | `settings.json` (detects array vs object shape) + `.continue/config.yaml` |
| **Cline / Roo Code** | `globalStorage/…/settings/…json` — the OpenAI-compatible base URL |
| **OpenCode extension** | `opencode.jsonc` (the `hivv` provider with `auto/smart/fast/cheap/private`) |
| **VS Code ACP** | prints the `vscode-acp.agentPaths` line to add |

### JetBrains (IntelliJ, PyCharm, GoLand, WebStorm, RustRover)

| Tool | Config written |
|---|---|
| **AI Assistant** | `~/.mcp/llms.xml` — an OpenAI-compatible community provider |
| **MCP** | `~/.mcp/mcp.json` — the HIVV MCP server |

### Other editors

| Tool | Config written |
|---|---|
| **Zed** | `settings.json` — a custom context server |
| **Windsurf** | `settings.json` — the OpenAI-compatible endpoint |

### Chat front-ends

| Tool | Config written |
|---|---|
| **LM Studio** | `llm-studio-settings.json` — the remote endpoint |
| **Open WebUI** | `.env` — `OPENAI_API_BASE_URL` / `OPENAI_API_KEY` |
| **LibreChat** | `librechat.yaml` — a custom endpoint |
| **LobeChat** | `local-storage/config.json` |
| **Jan** | `settings.json` — a llama.cpp-compatible endpoint |
| **GPT4All** | `settings.json` |
| **AnythingLLM** | `settings.json` |

### CLI tools

| Tool | Config written |
|---|---|
| **Aider** | `.aider.conf.yml` — `openai-api-base` |
| **Crush (Charm)** | `crush.json` — a custom model |

### MCP hosts

| Tool | Config written |
|---|---|
| **Claude Desktop, Cursor, …** | `claude_desktop_config.json` — the HIVV MCP server |

---

## Safety rules

These are enforced in code, not just documented:

1. **Your settings always win.** A merge only fills gaps; an existing value is
   never overwritten.
2. **The shape is preserved.** Continue's `models` can be an array or an
   object — `hivv setup` detects which one you have and matches it.
3. **A backup is written first.** Every modified file gets a
   `<name>.bak-<timestamp>` sibling.
4. **Nothing is executed.** No installer is run, no extension is downloaded.
5. **Only detected tools are touched** (unless you name them with `--tools`).

---

## Usage examples

```bash
# see everything (no writes)
hivv setup --dry-run

# wire the tools up, local-first with hive fallback
hivv setup --gui --profile hybrid

# only VS Code, and pin a specific local model
hivv setup --gui --tools vscode-continue,vscode-cline --backend gemma-4-E2B

# privacy: everything stays on this machine
hivv setup --gui --profile local

# point at your own gateway instead of the public hive
hivv setup --gui --hub http://127.0.0.1:3011

# machine-readable
hivv setup --json --dry-run | jq .gui
```

---

## Donating your idle capacity

`hivv setup` shows your volunteer state and explains it:

```bash
hivv drone              # current state
hivv volunteer on       # let the hive use your idle CPU/GPU
hivv volunteer off      # your machine serves you only
```

When you donate, your box earns **honey** — ranking, streaks, and a place on
the leaderboard (`hivv honey --board`).

**Your IDE traffic is private either way.** Donation shares compute, never
prompts or files.

---

## Testing

```bash
python3 tests/test_gui_setup.py    # 106 checks — registry, profiles, merges
python3 tests/test_gui_e2e.py      # 16 checks — a real gateway, real answers
```

The end-to-end test starts a gateway with no database, writes a Continue
config at it, makes a real OpenAI-compatible request, and checks the response
carries content plus the `X-Hivv-Answered-By` and `X-Hivv-Policy` receipts.
