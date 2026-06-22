# Codex Setup

Use the hosted 6DuckLearn MCP server:

```bash
npx github:kit18/6ducklearn-mcp setup-codex
```

Manual fallback:

```bash
codex mcp remove 6ducklearn # ignore if missing
codex mcp add 6ducklearn --url https://6ducklearn.com/mcp
codex mcp login 6ducklearn
```

If configuring manually, add the hosted OAuth compatibility header to `~/.codex/config.toml` before login:

```toml
[mcp_servers.6ducklearn.http_headers]
User-Agent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
```

Check registration:

```bash
codex mcp get 6ducklearn
```

The local Codex server key should be `6ducklearn`. The official MCP Registry name for the hosted server is `com.6ducklearn/mcp`.
