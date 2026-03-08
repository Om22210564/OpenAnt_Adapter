# OpenAnt

A bidirectional session bridge between **OpenAI Codex CLI** and **Anthropic Claude Code CLI** . Resume a Codex session inside Claude Code — or vice versa — with full conversational context, tool calls, and reasoning preserved. No re-explaining anything manually.

```
openant list
openant inspect 019ca8d1
openant import claude 019ca8d1-eafb-71f2-8137-ed7539c38304
openant import codex  c86e2d30-d596-433c-8f0d-38aebe00f8fc
openant status
```

---

## How It Works

Both CLIs store sessions as local JSONL files. `openant` reads those files, converts them through a format-agnostic **CanonicalSession** intermediate, and writes a new file in the target CLI's format — ready to open.

```
Codex rollout JSONL  ──parse──▶  CanonicalSession  ──emit──▶  Claude Code JSONL
Claude Code JSONL    ──parse──▶  CanonicalSession  ──emit──▶  Codex rollout JSONL
```

All conversions are recorded in a local SQLite database (`~/.openant/state.sqlite`).

---

## Installation

**Requirements:** Node.js ≥ 18

```bash
git clone https://github.com/your-username/openant.git
cd openant
npm install
npm link          # installs `openant` as a global command
```

To uninstall:

```bash
npm unlink -g openant
```

---

## Commands

### `openant list`

Scans disk for all Claude Code and Codex sessions and prints a summary table.

```
openant list                # all sessions
openant list --claude       # only Claude Code sessions
openant list --codex        # only Codex sessions
openant list --json         # machine-readable JSON output
```

Example output:

```
SOURCE  ID                                    TURNS  MODEL               STARTED              CWD
------  ------------------------------------  -----  ------------------  -------------------  --------------------------------
codex   019ca8d1-eafb-71f2-8137-ed7539c38304  3      gpt-5.1-codex-mini  2026-03-01 09:54:15  C:\Users\you\Desktop\myproject
claude  c86e2d30-d596-433c-8f0d-38aebe00f8fc  89     claude-sonnet-4-6   2026-03-01 10:31:03  C:\Users\you\Desktop\myproject
```

---

### `openant inspect <session-id>`

Display the canonical (parsed) view of any session. Accepts full UUIDs or short prefixes.

```
openant inspect 019ca8d1              # Codex session (short prefix)
openant inspect c86e2d30             # Claude session (short prefix)
openant inspect c86e2d30-d596-...    # full UUID
openant inspect c86e2d30 --json      # full canonical JSON
```

Example output:

```
=== Session: 019ca8d1-eafb-71f2-8137-ed7539c38304 ===
Source:    codex
CWD:       C:\Users\you\Desktop\myproject
Model:     gpt-5.1-codex-mini
Turns:     22

Turn 1 [USER     ] ...
  [text] Fix the syntax error in test1.py

Turn 2 [ASSISTANT] ...
  [reasoning] **Seeking clarification and starting update** [encrypted]
  [tool_call:standard] shell_command callId=call_abc123
    input: {"command":"cat test1.py"}

Turn 3 [USER     ] ...
  [tool_result] callId=call_abc123
    output: from sklearn.metrics import ...
```

---

### `openant import <format> <session-id>`

Convert a session to the other CLI's format and write it to the correct location on disk.

| Format argument | Direction | Output location |
|---|---|---|
| `claude` | Codex → Claude Code | `~/.claude/projects/<cwd>/` |
| `codex` | Claude Code → Codex | `~/.codex/sessions/YYYY/MM/DD/` |

```bash
# Import a Codex session into Claude Code
openant import claude 019ca8d1-eafb-71f2-8137-ed7539c38304

# Import a Claude Code session into Codex
openant import codex c86e2d30-d596-433c-8f0d-38aebe00f8fc

# Preview without writing anything
openant import claude 019ca8d1-... --dry-run

# Overwrite an existing output file
openant import claude 019ca8d1-... --force

# Write to a custom path
openant import claude 019ca8d1-... --output /path/to/output.jsonl

# Compress a long session with claude-opus-4-6 before converting
# Requires ANTHROPIC_API_KEY to be set
openant import claude 019ca8d1-... --summarize
```

After running, the command prints the output file path. The filename contains the **target session ID** — this is the ID you pass to `claude --resume` or Codex, not the original source ID. Use `openant status` to look up the source → target mapping at any time.

---

### `openant status`

Show what has been indexed and converted.

```
openant status
```

```
=== OpenAnt Status ===
DB: C:\Users\you\.openant\state.sqlite

Indexed sessions: 5 total (4 Claude, 1 Codex)

Recent conversions (last 10):

  #1 codex → claude
    Source: 019ca8d1-eafb-71f2-8137-ed7539c38304
    Target: c8d03bff-5994-491e-9d63-e64c68fce540
    Output: C:\Users\you\.claude\projects\...\c8d03bff.jsonl
    At:     2026-03-01 11:37:22 (22 turns)
```

---

## Session File Locations

| CLI | Session files |
|---|---|
| Claude Code | `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<session-id>.jsonl` |

`openant` writes converted files to exactly these locations so each CLI can find them without any manual configuration.

---

## What Gets Preserved

| Element | Claude → Codex | Codex → Claude |
|---|---|---|
| User messages | ✓ | ✓ |
| Assistant text | ✓ | ✓ |
| Tool calls (standard) | ✓ as `function_call` | ✓ as `tool_use` |
| Tool calls (custom) | ✓ as `custom_tool_call` | ✓ as `tool_use` |
| Tool results | ✓ | ✓ |
| Thinking blocks | ✓ as `reasoning` | ✓ as `thinking` |
| Codex reasoning | preserved verbatim (encrypted_content kept) | shown as `[Codex reasoning: ...]` |
| System prompt / base instructions | ✓ | ✓ |
| Model metadata | ✓ | ✓ |
| Working directory | ✓ | ✓ |

---

## Summarization (optional)

For very long sessions, use `--summarize` to compress the entire history into 2 synthetic turns (a structured markdown summary) before converting. This uses `claude-opus-4-6` via the Anthropic API.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
openant import codex c86e2d30-... --summarize
```

Long sessions are automatically chunked to fit within token limits. The summary is structured to give the receiving AI full context: goals, decisions, files modified, errors resolved, and next steps.

---

## Session ID Changes After Conversion

**The original session ID is never reused in the target CLI.** A new ID is derived deterministically from the source ID using SHA-256, so the same conversion always produces the same target ID — but it will not match the original.

| Direction | Source ID (what you pass to `import`) | Target ID (what you use to resume) |
|---|---|---|
| Codex → Claude | Codex session UUID | `sha256(sourceId + ":claude")` formatted as UUID |
| Claude → Codex | Claude session UUID | `sha256(sourceId + ":codex")` formatted as UUID |

**How to find the target ID** after a conversion:

```bash
# Option 1 — openant status shows Source → Target for every conversion
openant status

# Option 2 — openant list re-scans disk and shows the new session
openant list --claude     # after a Codex→Claude import
openant list --codex      # after a Claude→Codex import
```

The `import` command also prints the output file path, which contains the target ID in its filename.

---

## Workflow Examples

**Continue a Codex session in Claude Code:**

```bash
# 1. Find the Codex session you want to continue
openant list --codex
# e.g. ID: 019ca8d1-eafb-71f2-8137-ed7539c38304

# 2. Convert it — openant prints the output file path
openant import claude 019ca8d1-eafb-71f2-8137-ed7539c38304
# Written 39 lines to:
#   C:\Users\you\.claude\projects\...\c8d03bff-5994-491e-9d63-e64c68fce540.jsonl

# 3. Find the new Claude session ID from status or the filename above
openant status
# Source: 019ca8d1-eafb-71f2-8137-ed7539c38304
# Target: c8d03bff-5994-491e-9d63-e64c68fce540  ← use THIS id

# 4. Resume in Claude Code with the TARGET id (not the original Codex id)
cd C:\Users\you\Desktop\myproject
claude --resume c8d03bff-5994-491e-9d63-e64c68fce540
```

**Continue a Claude Code session in Codex:**

```bash
# 1. Find the Claude session
openant list --claude
# e.g. ID: c86e2d30-d596-433c-8f0d-38aebe00f8fc

# 2. Convert it
openant import codex c86e2d30-d596-433c-8f0d-38aebe00f8fc
# Written 157 lines to:
#   C:\Users\you\.codex\sessions\2026\03\01\rollout-...-54673874-....jsonl

# 3. The target session ID is in the output filename and in openant status
openant status
# Target: 54673874-38ae-4826-b9ac-1084d771ce55  ← use THIS id

# 4. Resume in Codex — open it in the same working directory
cd C:\Users\you\Desktop\myproject
codex --session 54673874-38ae-4826-b9ac-1084d771ce55
```

**Round-trip verification:**

```bash
# Convert Codex → Claude
openant import claude 019ca8d1-eafb-71f2-8137-ed7539c38304

# Find the target id
openant status
# Target: c8d03bff-5994-491e-9d63-e64c68fce540

# Inspect with the TARGET id to verify turn count and content
openant inspect c8d03bff-5994-491e-9d63-e64c68fce540
```

---

## Project Structure

```
openant/
├── package.json
└── src/
    ├── cli.js                  Commander entry point
    ├── schema.js               CanonicalSession types, UUID utilities, OpenantError
    ├── db.js                   SQLite state (~/.openant/state.sqlite)
    ├── discovery.js            Session discovery from both CLI homes
    ├── summarizer.js           Optional claude-opus-4-6 compression
    ├── parsers/
    │   ├── codex.js            Codex rollout JSONL → CanonicalSession
    │   └── claude.js           Claude JSONL → CanonicalSession (DFS tree flatten)
    ├── emitters/
    │   ├── codex.js            CanonicalSession → Codex rollout JSONL
    │   └── claude.js           CanonicalSession → Claude JSONL
    └── commands/
        ├── list.js
        ├── import.js
        ├── status.js
        └── inspect.js
```

No build step. Plain Node.js CommonJS.

---

## Exit Codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | General error |
| 2 | Session not found |
| 3 | Summarization failed |
| 4 | Output path conflict (use `--force`) |

---

## Dependencies

| Package | Purpose |
|---|---|
| `commander` | CLI argument parsing |
| `better-sqlite3` | Local SQLite database for session index and conversion history |
| `@anthropic-ai/sdk` | Optional — only needed for `--summarize` |

---

## License

MIT
