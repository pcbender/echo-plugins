# Echo Plugins

Windows-aware tools for keeping noisy command output out of model context.

## Quiet Output

`plugins/quiet-output` contains a dependency-free Node.js runner, a Codex command hook, three local MCP tools, and a short usage skill. Requires **Node.js 22+** on PATH. No npm installation, API key, Ollama model, or build step is required.

The runner stores complete combined stdout/stderr locally. Successful commands return a compact status. Failed commands return their actual exit code, selected distinct error lines, a short tail, and the complete log location. Metadata records raw and summary byte counts; these are **bytes, not measured tokens or billing savings**.

```text
FAIL exit=7 950ms 1002 lines 15240 bytes
cmd: npm run build
shell: powershell
run: 1790000000000-00000000-0000-0000-0000-000000000000
--- errors (up to 20 distinct) ---
error BUILD42: missing dependency
--- last 15 lines ---
...
full log: C:\Users\you\AppData\Local\Temp\echo-quiet-output\<run-id>.log
```

### Run directly

From this repository in PowerShell:

```powershell
node .\plugins\quiet-output\scripts\quiet-run.mjs run --command 'npm run build' --cwd 'D:\Dev\my-project'
node .\plugins\quiet-output\scripts\quiet-run.mjs read --run-id '<run-id>' --max-bytes 8192
node .\plugins\quiet-output\scripts\quiet-run.mjs search --run-id '<run-id>' --query 'BUILD42'
```

The command is passed intact to a fresh shell. Windows defaults to Windows PowerShell, other platforms to Bash. Select `--shell pwsh` or `--shell bash` explicitly as needed. Direct runs use a profile-free shell; hooked runs preserve the input's `login` setting. Shell aliases and session-local functions/variables are not transferred from an already-running terminal.

PowerShell native process failures retain their exit codes. Timeouts return `124`, cancellation returns `130`, and unavailable shells return `127`. Timeout and cancellation stop the process tree. Commands are noninteractive (stdin is closed); use a normal terminal for prompts and watch mode. Full logs preserve output bytes in stream-arrival order, not an ordering guarantee between stdout and stderr.

### Install in local Codex

The repo marketplace is at `.agents/plugins/marketplace.json`. In a terminal:

```powershell
codex plugin marketplace add 'D:\Dev\echo-plugins'
```

Open the plugin browser in the desktop app or CLI, choose **Echo Plugins**, and install **Quiet Output**. Start a new chat. Review and trust the plugin's hook using **Settings > Hooks**, **Review hooks**, or `/hooks` as supported by the client. Hook trust is controlled by Codex; this repository does not change global settings or trust hooks automatically. A plugin containing lifecycle hooks is intended for local/manual installation, not submission to the public plugin directory.

The hook wraps supported plain install/build/test/lint commands. It preserves other tool arguments, including working directory, timeout and permission settings. It skips shell programs containing pipes, redirects, command chaining, variable expansion or multiline input, and skips interactive terminals and watch flags. Set `QUIET_OUTPUT_OFF=1` in the host's environment to bypass the hook, or run the command through the ordinary terminal. Explicit `quiet_run`/CLI calls still work when the hook is off.

Canonical Codex `Bash` hook events use `tool_input.command`; `exec_command`/`shell_command` inputs with `cmd` or `command` are also handled when the host emits those events. The Windows default is PowerShell; use `QUIET_OUTPUT_SHELL=pwsh` when the host omits shell metadata and actually uses PowerShell 7. Explicit Windows-host Bash events pass through because Git Bash and WSL require different path translation. Running this plugin **inside WSL** supports Bash normally. A Windows PowerShell command such as `wsl.exe -d Ubuntu-24.04 -- npm test` can also be wrapped intact.

### MCP tools for Codex and ChatGPT desktop

The plugin's `mcp.json` declares a stdio server. The `.mcp.json` and `.codex-plugin/plugin.json` files support hosts using the compatibility layout. The server implements MCP initialization, tool discovery/calls, ping and cancellation over stdio with protocol negotiation up to `2025-11-25`. It exposes:

| Tool         | Purpose                                                                             |
| ------------ | ----------------------------------------------------------------------------------- |
| `quiet_run`  | Execute an authorized noninteractive command and return compact status/errors.      |
| `read_log`   | Read up to 16 KiB at a byte offset; paginate using `nextOffset`.                    |
| `search_log` | Search the complete log for a literal, returning bounded excerpts and line numbers. |

Set `QUIET_OUTPUT_ROOT` to your workspace directory when launching the MCP server. Otherwise, its launch working directory is the root. The tools resolve directory symlinks and reject a `cwd` outside that root. This is a **working-directory restriction, not a command sandbox**: commands run with the server's OS permissions and can access other files and the network. Approve and use the command tool accordingly. Log retrieval accepts only generated run IDs, not arbitrary file paths.

For clients that require an explicit local MCP entry, launch `node` with the absolute path `D:\Dev\echo-plugins\plugins\quiet-output\scripts\mcp-server.mjs` and environment `QUIET_OUTPUT_ROOT=D:\Dev\your-project`. Keep the server on stdio; it does not expose a network endpoint. Cloud-only ChatGPT cannot directly launch a local stdio process. A desktop/local MCP connection is required, and plugin hooks are not supported in cloud-orchestrated ChatGPT Work. Commands routed through the MCP tool can still return compact results on compatible connected clients.

### Configuration

Configure these environment variables on the parent Codex/MCP process:

| Variable                  | Default                                     | Meaning                                                                        |
| ------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| `QUIET_OUTPUT_LOG_DIR`    | The OS temp directory's `echo-quiet-output` | Full logs and per-run JSON metrics. Use the same setting when retrieving logs. |
| `QUIET_OUTPUT_ROOT`       | MCP server launch directory                 | MCP working-directory boundary.                                                |
| `QUIET_OUTPUT_MAX_ERRORS` | `20`                                        | Distinct error previews, from 0 to 100.                                        |
| `QUIET_OUTPUT_TAIL`       | `15`                                        | Failure tail lines, from 0 to 100.                                             |
| `QUIET_OUTPUT_SHELL`      | Platform default                            | Hook fallback when shell metadata is absent.                                   |
| `QUIET_OUTPUT_OFF`        | Unset                                       | `1` bypasses automatic rewriting.                                              |

`quiet_run.timeoutMs` / CLI `--timeout-ms` defaults to ten minutes and accepts up to one hour. The host's own execution timeout still applies to hooked commands.

Logs can contain credentials, proprietary output and personal data. They remain local and are not automatically uploaded, summarized by an LLM, rotated or deleted. Remove old `.log`/`.json` pairs from the configured log directory when no longer needed. POSIX log files are created with owner-only mode; Windows access follows the containing directory's ACLs.

Summaries use keyword heuristics, so unusual failure messages may appear only in the tail or full log. Previews are bounded and ANSI-stripped; very long lines are marked as truncated. Use byte-range reads to retrieve their complete contents. Retrieval can split a UTF-8 character at a byte boundary; overlap the range when inspecting non-ASCII text. Successful runs omit the tail to keep the result small; warnings remain in the saved log. Use either an existing context-mode executor or this runner for an operation, avoiding unnecessary double wrapping.

## Development and validation

```powershell
npm run check
npm test
# Optional live WSL integration test (uses an existing Ubuntu-24.04):
$env:QUIET_OUTPUT_TEST_WSL = '1'
# Optional PowerShell 7 check when pwsh is on PATH:
$env:QUIET_OUTPUT_TEST_PWSH = '1'
npm test
```

Tests exercise real child processes, native exit codes, large logs, Unicode, paths with spaces/apostrophes, timeouts/cancellation, hook rewriting, workspace boundaries and MCP requests. WSL testing is opt-in. The automated suite does not prove integration with every Codex/ChatGPT release; verify installation and a real build in a fresh host session.

Inspired by [pcbender/claude-plugins quiet-output](https://github.com/pcbender/claude-plugins). This implementation is written independently for PowerShell, Bash and local MCP use. Existing repository licensing is preserved.

Host documentation: [plugins](https://learn.chatgpt.com/docs/plugins), [hooks](https://learn.chatgpt.com/docs/hooks), [plugin packaging](https://developers.openai.com/plugins/build/plugins).
