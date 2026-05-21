# Contributing

Thanks for helping make 6DuckLearn MCP easier to use.

## Good Contributions

- clearer setup docs for MCP clients
- connector bug fixes
- runtime compatibility notes for Codex, Claude Code, OpenClaw, and Hermes
- tests that improve token handling, OAuth login, or connector resilience
- safer examples that reduce copy-paste mistakes

## Out Of Scope

- private 6DuckLearn SaaS backend code
- service-role database examples
- production Supabase edge functions or migrations
- scraping private user content
- bypassing approval, billing, or policy controls

## Local Checks

Run before opening a pull request:

```bash
npm install
npm run validate
```

