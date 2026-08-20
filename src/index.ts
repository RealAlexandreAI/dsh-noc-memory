// dsh-memory — DeepSeek Harness (Cordis) plugin.
//
// Noc Memory client: automated long-term memory for the agent,
// backed by YOUR OWN Noc MCP server (mcp_url). Ported from
// pi-noc-memory — same MCP protocol, same boot protocol, same tools.
//
// Tools: noc_boot (session-start memory load), noc_read,
// noc_search, noc_create, noc_update.
//
// Privacy: memories live on your own MCP server; the plugin is a thin
// client. The auth token comes from the plugin config (mcp_auth) — never logged.

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'noc-memory'
export const inject = ['tools', 'systemPrompt']

export interface Config {
  /** Noc MCP server URL, e.g. http://localhost:PORT/mcp. Optional at load
   *  time — a missing server surfaces as a setup hint on tool calls so the
   *  plugin still loads in a bare profile. */
  mcp_url?: string
  /** MCP auth token (Authorization header value, e.g. "Bearer xxx"). */
  mcp_auth?: string
  /** MCP protocol version. */
  protocol_version?: string
}

export const Config: z<Config> = z.object({
  mcp_url: z.string().description('Noc MCP server URL, e.g. http://localhost:PORT/mcp'),
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

/** MCP 2.0 (2026-07-28) is stateless: no initialize handshake, no session. */
function isMissingSession(parsed: any): boolean {
  const code = parsed?.error?.code
  const message = String(parsed?.error?.message ?? '').toLowerCase()
  return code === -32600 || message.includes('session')
}

class NocClient {
  private sessionId: string | null = null
  private initPromise: Promise<string | null> | null = null
  // Probe once: MCP 2.0 servers answer without a session; legacy servers
  // (2025-era) demand initialize + Mcp-Session-Id. Never assume which.
  private mode: 'unknown' | 'stateless' | 'legacy' = 'unknown'

  constructor(
    private readonly url: string,
    private readonly auth: string,
    private readonly protocolVersion: string,
  ) {}

  private async fetchRaw(method: string, params: Record<string, unknown>, sessionId?: string | null): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: this.auth,
    }
    if (sessionId)
      headers['Mcp-Session-Id'] = sessionId

    return fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: method + Date.now(), method, params }),
      // A dead MCP server must not stall a dsh turn forever.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  }

  private async initialize(): Promise<string | null> {
    // Concurrent first calls share one handshake instead of racing sessions.
    if (this.initPromise) return this.initPromise
    this.initPromise = (async () => {
      const resp = await this.fetchRaw('initialize', {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: { name: 'dsh-memory', version: '0.1.0' },
      })
      if (!resp.ok) return null
      return resp.headers.get('mcp-session-id')
    })()
    return this.initPromise
  }

  async call(method: string, params: Record<string, unknown>): Promise<any> {
    // MCP 2.0 stateless path: try without a session first (no initialize).
    if (this.mode !== 'legacy') {
      const resp = await this.fetchRaw(method, params)
      if (resp.ok) {
        const parsed = parseStreamResponse(await resp.text())
        if (!isMissingSession(parsed)) {
          this.mode = 'stateless'
          const newSid = resp.headers.get('mcp-session-id')
          if (newSid)
            this.sessionId = newSid
          return parsed
        }
        // Legacy server demands a session — fall through to handshake.
      }
    }

    this.mode = 'legacy'
    if (!this.sessionId) {
      this.sessionId = await this.initialize()
      if (!this.sessionId) return { error: { code: -1, message: 'Failed to initialize MCP session' } }
    }
    const resp = await this.fetchRaw(method, params, this.sessionId)
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
    name: 'tool:noc-memory',
    order: 114,
    text:
      'You have long-term memory via the Noc MCP server. At the start of ' +
      'substantial work call noc_boot to load core memories and recent ' +
      'context; use noc_search before answering from memory; persist ' +
      'valuable outcomes with noc_create. ' +
      'Periodically (after many new memories or when you repeat a mistake) ' +
      'run a memory audit: noc_read system://diagnostic/noc, then fix what it ' +
      'flags — never-reaccessed high-priority memories (disclosure/placement), ' +
      'stale or cold candidates (delete if dead, demote if niche), crowded ' +
      'parents (regroup), contradictions (merge via noc_update). Always ' +
      'noc_read a node in full before changing it.',
  })

  const resolveAuth = async (): Promise<string> => config.mcp_auth ?? ''

  // One client per plugin instance: the MCP session (initialize handshake +
  // session id) is reused across tool calls instead of re-handshaking on every
  // call.
  let cachedClient: Promise<NocClient> | null = null
  const client = (): Promise<NocClient> => {
    if (!cachedClient) {
      cachedClient = (async () => {
        if (!config.mcp_url) {
          throw new Error('Noc MCP server not configured — set mcp_url in the plugin config (e.g. http://localhost:PORT/mcp)')
        }
        return new NocClient(config.mcp_url, await resolveAuth(), config.protocol_version ?? '2024-11-05')
      })()
    }
    return cachedClient
  }

  const register = (tool: Record<string, unknown>): void => {
    ctx.tools.register(defineTool(tool as never))
  }

  register({
    name: 'noc_boot',
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
    name: 'noc_read',
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
    name: 'noc_search',
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
    name: 'noc_create',
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
    name: 'noc_update',
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
