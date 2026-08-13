<p align="center">
  <img src="assets/readme/hero.svg" alt="dsh-nocturne-memory — long-term memory for DeepSeek Harness" width="100%">
</p>

# dsh-nocturne-memory

Connects DeepSeek Harness to **Nocturne Memory**: session-start boot protocol plus memory read / search / create / update, backed by your own Nocturne MCP server.

> Port of [pi-nocturne-memory](https://github.com/RealAlexandreAI/pi-nocturne-memory) — same protocol, same tool names.

[English](README.md) · [中文](README.zh.md)

## Tools

| tool | what it does |
|---|---|
| `nocturne_boot` | load at session start: core memories + recent context + glossary |
| `nocturne_read` | read a memory by URI (`system://…`, `core://agent`, …) |
| `nocturne_search` | search memories by keywords (optional domain filter) |
| `nocturne_create` | create a memory node (`[Baseline]/[Deviation]/[Result]/[Reusable judgment]`) |
| `nocturne_update` | patch (old_string/new_string) or append to a memory |

## Quick start

```sh
dsh plugin --profile web add dsh-nocturne-memory
```

Requires your own Nocturne MCP server (see the [Nocturne Memory](https://github.com/martin22/Nocturne-Memory) project).

```yaml
- id: nocturne-memory
  name: dsh-nocturne-memory
  config:
    mcp_url: http://localhost:PORT/mcp
    mcp_auth: Bearer <your token>
```

| key | required | meaning |
|---|---|---|
| `mcp_url` | ✅ | your Nocturne MCP server URL |
| `mcp_auth` | – | MCP auth token (Authorization header, e.g. `Bearer xxx`) |
| `protocol_version` | – | MCP protocol version (default `2024-11-05`) |



## Privacy

- Memories live on **your own MCP server**; this plugin is a thin client and stores nothing locally.
- The auth token lives only in your config file (`mcp_auth`) and the MCP session is reused across tool calls — no re-handshake per call, nothing logged.
- Only the memory URIs/queries/content you explicitly ask about cross the wire.

## Development

```bash
npm install
npm run typecheck
npm test          # SSE parsing / text extraction
npm run build
```

Live MCP test (reuses your pi Nocturne config):

```bash
node --import tsx tests/real/real-mcp.mjs
```

## License

MIT
