<p align="center">
  <img src="assets/readme/hero.svg" alt="dsh-noc-memory — long-term memory for DeepSeek Harness" width="100%">
</p>

# dsh-noc-memory

Connects DeepSeek Harness to **Noc Memory**: session-start boot + daily briefing, plus memory read / search / create / update, backed by your own Noc Memory MCP server on Cloudflare.

> Port of [pi-noc-memory](https://github.com/RealAlexandreAI/pi-noc-memory) — same protocol, same tool names.

[English](README.md) · [中文](README.zh.md)

## Tools

| tool | what it does |
|---|---|
| `noc_boot` | load at session start: core memories + recent context + glossary |
| `noc_briefing` | today's working-memory briefing (`system://briefing`) — recent activity, expiring, cold candidates |
| `noc_read` | read a memory by URI (`system://…`, `noc://agent`, …) |
| `noc_search` | search memories by keywords (trigger recall first, then FTS) |
| `noc_create` | create a memory node (`[Baseline]/[Deviation]/[Result]/[Reusable judgment]`) |
| `noc_update` | patch (old_string/new_string) or append to a memory; optional `relation` evolution marker |

## Quick start

```sh
dsh plugin --profile web add dsh-noc-memory
```

Requires your own Noc Memory server — deploy it to Cloudflare in minutes: [cf-noc-mem](https://github.com/RealAlexandreAI/cf-noc-mem).

```yaml
- id: noc-memory
  name: dsh-noc-memory
  config:
    mcp_url: https://mem.example.com/mcp
    mcp_auth: Bearer <your token>
```

| key | required | meaning |
|---|---|---|
| `mcp_url` | yes | your Noc Memory MCP endpoint (Streamable HTTP) |
| `mcp_auth` | no | `Bearer <token>` if the server requires it |

> **Upgrading from dsh-nocturne-memory (≤0.1.x):** renamed to `dsh-noc-memory`, tools renamed `nocturne_*` → `noc_*`. Remove the old plugin and re-add the new package; update any prompt text referencing `nocturne_*` tools.

## Why noc_* (not nocturne_*)?

Some agents probe `read_mcp_resource` before reaching for a memory tool, wasting a round trip ([upstream issue #32](https://github.com/Dataojitori/nocturne_memory/issues/32)). Explicit `noc_boot` / `noc_read` naming in the tool list and boot-protocol prompt steers models straight to the right tool — no resource shim required.

## License

MIT

## Related

- [cf-noc-mem](https://github.com/RealAlexandreAI/cf-noc-mem) — the Cloudflare MCP memory server this plugin talks to
- [pi-noc-memory](https://github.com/RealAlexandreAI/pi-noc-memory) — same memory tools for Pi
- [nocturne_memory](https://github.com/Dataojitori/nocturne_memory) — upstream project
