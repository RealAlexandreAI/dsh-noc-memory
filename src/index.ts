// dsh-memory — DeepSeek Harness (Cordis) plugin.
//
// Nocturne Memory client: automated long-term memory for the agent,
// backed by YOUR OWN Nocturne MCP server (mcp_url). Ported from
// pi-nocturne-memory — same MCP protocol, same boot protocol, same tools.
//
// Tools: nocturne_boot (session-start memory load), nocturne_read,
// nocturne_search, nocturne_create, nocturne_update.
//
// Privacy: memories live on your own MCP server; the plugin is a thin
// client. The auth token comes from the plugin config (mcp_auth) — never logged.

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'nocturne-memory'
export const inject = ['tools', 'systemPrompt']

export interface Config {
  /** Nocturne MCP server URL, e.g. http://localhost:PORT/mcp. */
  mcp_url: string
  /** MCP auth token (Authorization header value, e.g. "Bearer xxx"). */
  mcp_auth?: string
  /** MCP protocol version. */
  protocol_version?: string
}

export const Config: z<Config> = z.object({
  mcp_url: z.string().required().description('Nocturne MCP server URL, e.g. http://localhost:PORT/mcp'),
  mcp_auth: z.string().description('MCP auth token (Authorization header value, e.g. "Bearer xxx")'),
  protocol_version: z.string().description('MCP protocol version (default 2024-11-05)'),
})

/** Parse an SSE body into the first JSON-RPC result/error object. Pure logic. */
export function parseStreamResponse(text: string): any {
  const lines = text.split(/\r?\n/)
  let currentData = ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('data: ')) {
      currentData = trimmed.slice(6)
    } else if (trimmed === '' && currentData) {
      try {
        const parsed = JSON.parse(currentData)
        if (parsed.result || parsed.error) return parsed
      } catch {
        // continue
      }
      currentData = ''
    }
  }
  if (currentData) {
    try {
      return JSON.parse(currentData)
    } catch {
      // ignore
    }
  }
  return null
}

export function extractText(data: any): string {
  if (data?.error) return `Error: ${data.error.message ?? JSON.stringify(data.error)}`
  return data?.result?.content?.[0]?.text ?? ''
}

const REQUEST_TIMEOUT_MS = 30_000

class NocturneClient {
  private sessionId: string | null = null
  private initPromise: Promise<string | null> | null = null

  constructor(
    private readonly url: string,
    private readonly auth: string,
    private readonly protocolVersion: string,
  ) {}

  private async initialize(): Promise<string | null> {
    // Concurrent first calls share one handshake instead of racing sessions.
    if (this.initPromise) return this.initPromise
    this.initPromise = (async () => {
      const resp = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: this.auth,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'init-' + Date.now(),
          method: 'initialize',
          params: {
            protocolVersion: this.protocolVersion,
            capabilities: {},
            clientInfo: { name: 'dsh-memory', version: '0.1.0' },
          },
        }),
        // A dead MCP server must not stall a dsh turn forever.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!resp.ok) return null
      return resp.headers.get('mcp-session-id')
    })()
    return this.initPromise
  }

  async call(method: string, params: Record<string, unknown>): Promise<any> {
    if (!this.sessionId) {
      this.sessionId = await this.initialize()
      if (!this.sessionId) return { error: { code: -1, message: 'Failed to initialize MCP session' } }
    }
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: this.auth,
        'Mcp-Session-Id': this.sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: method + Date.now(), method, params }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '<unreadable>')
      return { error: { code: resp.status, message: `HTTP ${resp.status}: ${body.slice(0, 200)}` } }
    }
    const newSid = resp.headers.get('mcp-session-id')
    if (newSid) this.sessionId = newSid
    return parseStreamResponse(await resp.text())
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.systemPrompt.section({
    name: 'tool:nocturne-memory',
    order: 114,
    text:
      'You have long-term memory via the Nocturne MCP server. At the start of ' +
      'substantial work call nocturne_boot to load core memories and recent ' +
      'context; use nocturne_search before answering from memory; persist ' +
      'valuable outcomes with nocturne_create.',
  })

  const resolveAuth = async (): Promise<string> => config.mcp_auth ?? ''

  // One client per plugin instance: the MCP session (initialize handshake +
  // session id) is reused across tool calls instead of re-handshaking on every
  // call.
  let cachedClient: Promise<NocturneClient> | null = null
  const client = (): Promise<NocturneClient> => {
    if (!cachedClient) {
      cachedClient = (async () => new NocturneClient(config.mcp_url, await resolveAuth(), config.protocol_version ?? '2024-11-05'))()
    }
    return cachedClient
  }

  const register = (tool: Record<string, unknown>): void => {
    ctx.tools.register(defineTool(tool as never))
  }

  register({
    name: 'nocturne_boot',
    description:
      'Call at session start. Loads core memories, recent context, and glossary. ' +
      'Self-discipline startup protocol.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    isConcurrencySafe: () => true,
    async execute(_args, _exec) {
      const c = await client()
      const out: string[] = []
      for (const uri of ['system://boot', 'system://recent/5', 'system://glossary']) {
        const data = await c.call('tools/call', { name: 'read_memory', arguments: { uri } })
        out.push(`[${uri}]\n${extractText(data)}`)
      }
      return out.join('\n\n')
    },
  })

  register({
    name: 'nocturne_read',
    description: 'Read a memory by URI. Use system:// URIs or memory paths like core://agent.',
    parameters: {
      uri: { type: 'string', required: true, description: 'Memory URI (e.g., core://agent, system://boot)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const c = await client()
      const data = await c.call('tools/call', { name: 'read_memory', arguments: { uri: args.uri } })
      return extractText(data)
    },
  })

  register({
    name: 'nocturne_search',
    description: 'Search memories by keywords in path and content.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search keywords' },
      domain: { type: 'string', description: 'Domain filter (e.g., core, writer)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const c = await client()
      const data = await c.call('tools/call', {
        name: 'search_memories',
        arguments: { query: args.query, domain: args.domain ?? undefined },
      })
      return extractText(data)
    },
  })

  register({
    name: 'nocturne_create',
    description:
      'Create a new memory node. Include [Baseline], [Deviation], [Result], [Reusable judgment] for behavior records.',
    parameters: {
      parent_uri: { type: 'string', required: true, description: 'Parent URI (e.g., core://)' },
      content: { type: 'string', required: true, description: 'Memory content (Markdown supported)' },
      priority: { type: 'number', description: 'Priority (0=highest, default 2)' },
      disclosure: { type: 'string', required: true, description: "When to recall this memory (e.g., 'When discussing X')" },
      title: { type: 'string', description: 'Path name (a-z, 0-9, _, -)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const c = await client()
      const data = await c.call('tools/call', {
        name: 'create_memory',
        arguments: {
          parent_uri: args.parent_uri,
          content: args.content,
          priority: args.priority ?? 2,
          disclosure: args.disclosure,
          title: args.title ?? undefined,
        },
      })
      return extractText(data)
    },
  })

  register({
    name: 'nocturne_update',
    description: 'Update existing memory. Use patch mode (old_string/new_string) or append mode.',
    parameters: {
      uri: { type: 'string', required: true, description: 'Memory URI to update' },
      mode: { type: 'string', enum: ['patch', 'append'], description: 'Update mode' },
      old_string: { type: 'string', description: 'Patch: text to replace' },
      new_string: { type: 'string', description: 'Patch/append: replacement or appended text' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const c = await client()
      const data = await c.call('tools/call', {
        name: 'update_memory',
        arguments: {
          uri: args.uri,
          mode: args.mode ?? 'patch',
          old_string: args.old_string ?? undefined,
          new_string: args.new_string ?? undefined,
        },
      })
      return extractText(data)
    },
  })
}
