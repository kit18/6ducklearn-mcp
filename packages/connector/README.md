# 6DuckLearn Connector

Local runtime bridge for users connecting a local agent runtime to the hosted 6DuckLearn Agent Console.

Use the hosted MCP server first when your client supports HTTP MCP with OAuth:

```bash
codex mcp remove 6ducklearn # ignore if missing
codex mcp add 6ducklearn --url https://6ducklearn.com/mcp
codex mcp login 6ducklearn --scopes mcp:read,mcp:write,runtime:connect,control:read,control:write,policy:read,approval:request,approval:decide
```

If installing manually, add the hosted OAuth compatibility header to `~/.codex/config.toml` before login:

```toml
[mcp_servers.6ducklearn.http_headers]
User-Agent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
```

Use this connector only when you need 6DuckLearn to coordinate a local runtime such as Codex, OpenClaw, or Hermes. For normal hosted MCP setup from GitHub, run:

```bash
npx github:kit18/6ducklearn-mcp setup-codex
```

## Build

```bash
npm install
npm run build
```

## Login

```bash
SIXDUCK_PUBLIC_BASE_URL=https://6ducklearn.com node packages/connector/dist/index.js login
```

The login flow stores a local OAuth session in your home directory. Avoid committing generated session files or copied credentials.

## Local Profile Projection Sync

Create an independent local profile folder for a specific runtime:

```bash
node packages/connector/dist/index.js profile create research-analyst --runtime hermes
```

Sync the local profile with its 6DuckLearn Agent Profile:

```bash
SIXDUCK_SUPABASE_URL=<your-6ducklearn-supabase-functions-url> \
SIXDUCK_RUNTIME_TYPE=hermes \
SIXDUCK_AGENT_ID=<agent_id> \
node packages/connector/dist/index.js profile sync --profile research-analyst
```

Profile Sync binds the local profile key, pulls approved config and unlocked skill packs, writes `config.yaml`, `SYSTEM_PROMPT.md`, `skills/6ducklearn/*/SKILL.md`, and `.6ducklearn/profile-sync.json`, then acknowledges the sync hash back to 6DuckLearn. Canonical memory is not pulled into local files; local learning must return as reviewable memory proposals.

Fork a memory branch for a separate direction:

```bash
SIXDUCK_SUPABASE_URL=<your-6ducklearn-supabase-functions-url> \
SIXDUCK_RUNTIME_TYPE=hermes \
SIXDUCK_AGENT_ID=<agent_id> \
node packages/connector/dist/index.js profile branch \
  --profile research-analyst \
  --source-memory-branch <memory_branch_id> \
  --branch-name "Asia thesis" \
  --fork-note "Explore this direction independently."
```

`profile branch` creates a canonical memory fork in 6DuckLearn, binds the local
profile to the new branch, pulls the branch-aware projection, and acknowledges
the sync hash. Raw canonical memory is not copied into local files.

Submit a local learning as a reviewable memory proposal:

```bash
SIXDUCK_SUPABASE_URL=<your-6ducklearn-supabase-functions-url> \
SIXDUCK_RUNTIME_TYPE=hermes \
SIXDUCK_AGENT_ID=<agent_id> \
node packages/connector/dist/index.js profile propose \
  --profile research-analyst \
  --memory "Remember to separate facts from interpretation." \
  --reason "The user corrected a local analysis draft."
```

`profile propose` refreshes the runtime anchor and creates a pending review item in 6DuckLearn. It does not mutate canonical memory; the user must keep the proposal in the review queue before it is appended.

Switch the same profile name to another runtime:

```bash
SIXDUCK_SUPABASE_URL=<your-6ducklearn-supabase-functions-url> \
SIXDUCK_RUNTIME_TYPE=hermes \
SIXDUCK_AGENT_ID=<agent_id> \
node packages/connector/dist/index.js profile switch \
  --profile research-analyst \
  --from-runtime codex \
  --to-runtime hermes \
  --handoff-note "Continue the same durable profile in Hermes."
```

`profile switch` prepares a control-plane handoff, records an audit event, syncs the target runtime folder, and acknowledges the target projection hash. The target pull materializes the current canonical Agent Profile projection for the target runtime; device-local files, runtime transcripts, tool state, and credentials stay in the source runtime. For custom local folders, pass distinct `--source-base-dir` and `--target-base-dir` values.

## Run With Codex

```bash
SIXDUCK_RUNTIME_TYPE=codex \
SIXDUCK_CODEX_CWD=/absolute/path/to/your/workspace \
SIXDUCK_CODEX_QUIET_PROFILE=true \
node packages/connector/dist/index.js
```

## Runtime Notes

- Codex uses the Codex app-server bridge.
- OpenClaw support expects either a loopback gateway or an authenticated hosted gateway.
- Hermes support expects a local Hermes API server.

The connector is a client-side bridge only. 6DuckLearn remains the hosted control plane for memory, approvals, runtime health, and user-scoped tool execution.
