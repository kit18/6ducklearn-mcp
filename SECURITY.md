# Security Policy

Please do not open public issues for vulnerabilities, leaked credentials, OAuth bypasses, token handling problems, or data exposure risks.

Report privately to the repository owner through GitHub security advisories or a private contact channel listed on the 6DuckLearn site.

## Boundary

This repository is a public client and documentation surface for the hosted 6DuckLearn MCP server. It must not contain:

- service-role database keys or instructions
- production Supabase edge-function source
- hardcoded token hashes or user identifiers
- private user content
- private SaaS billing, memory, approval, or deployment implementation

## Supported Version

Security fixes are accepted for the latest tagged public release and `main`.

