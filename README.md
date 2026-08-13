# @alex/dsh-memory

DeepSeek Harness plugin: **Nocturne Memory client** — automated long-term
memory for the agent, backed by **your own**
[Nocturne Memory](https://github.com/martin22/Nocturne-Memory) MCP server.

Port of [pi-nocturne-memory](https://github.com/RealAlexandreAI/pi-nocturne-memory)
to the dsh (Cordis) plugin model — same MCP protocol, same boot protocol,
same tools.

## Tools

| tool | what it does |
|---|---|
| `nocturne_boot` | session-start memory load: core memories + recent context + glossary |
| `nocturne_read` | read a memory by URI (`system://…`, `core://agent`, …) |
| `nocturne_search` | search memories by keywords (optional domain filter) |
| `nocturne_create` | create a memory node (supports `[Baseline]/[Deviation]/[Result]/[Reusable judgment]` records) |
| `nocturne_update` | patch (old_string/new_string) or append to an existing memory |

## Install

```sh
dsh plugin add @alex/dsh-memory
```

Requires a reachable Nocturne MCP server (your own instance — see the
Nocturne Memory project for the server).

## Configuration

```yaml
- id: memory
  name: '@alex/dsh-memory'
  config:
    mcp_url: http://localhost:PORT/mcp
    mcp_auth_ref: NOCTURNE_MCP_AUTH   # env var name — recommended
    # mcp_auth: <direct value>        # fallback when no ref is set
```

| key | required | meaning |
|---|---|---|
| `mcp_url` | ✅ | your Nocturne MCP server URL |
| `mcp_auth_ref` | * | env-var name of the MCP auth token (via `ctx.credentials`) |
| `mcp_auth` | * | direct auth token value (fallback) |
| `protocol_version` | – | MCP protocol version (default `2024-11-05`) |

\* one of `mcp_auth_ref` / `mcp_auth` is required.

## Privacy

- Memories live on **your own MCP server**; this plugin is a thin client
  and stores nothing locally.
- The auth token is resolved per operation via `ctx.credentials` — never
  logged, never written by the plugin.
- Only the memory URIs/queries/content you explicitly ask about cross the
  wire to your server.

## Development

```bash
npm install
npm run typecheck
npm test          # SSE parsing, text extraction
npm run build
```

## License

MIT
