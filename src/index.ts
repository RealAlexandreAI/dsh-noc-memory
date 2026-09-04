// dsh-memory — DeepSeek Harness (Cordis) plugin.
//
// Noc Memory client: automated long-term memory for the agent,
// backed by YOUR OWN Noc MCP server (mcp_url). Ported from
// pi-noc-memory — same MCP protocol, same boot protocol, same tools.
//
// Tools: noc_boot (session-start memory load), noc_read,
// noc_search, noc_create, noc_update, noc_delete.
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
  /** Extra headers merged into every MCP request — e.g. a Cloudflare Access
   *  service token ("CF-Access-Client-Id" / "CF-Access-Client-Secret"). */
  mcp_headers?: Record<string, string>
  /** MCP protocol version. */
  protocol_version?: string
}

export const Config: z<Config> = z.object({
  mcp_url: z.string().description('Noc MCP server URL, e.g. http://localhost:PORT/mcp'),
  mcp_auth: z.string().description('MCP auth token (Authorization header value, e.g. "Bearer xxx")'),
  mcp_headers: z.dict(z.string()).description('Extra headers merged into every MCP request (e.g. Cloudflare Access service token)'),
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

/** Boot resources read via read_memory (boot + recent + triggers). */
export const BOOT_URIS = ['system://boot', 'system://recent/5', 'system://triggers'] as const

/** MCP tool names as exposed by cf-noc-mem (must stay in sync with the server). */
export const MCP_TOOLS = {
  read: 'read_memory',
  search: 'search_memory', // not search_memories
  create: 'create_memory',
  update: 'update_memory',
  delete: 'delete_memory',
} as const


// UI presentation helpers — dsh web UI renders pending/settled tool calls as
// cards; declaring them gives memory ops readable titles instead of raw args.
function presentCallFor(label: string, pick: (args: any) => string): (args: any) => unknown {
  return (args) => {
    const what = String(pick(args) ?? '').trim()
    return { card: 'generic', title: what ? `${label} ${what}` : label, rawInput: what || undefined }
  }
}

function presentResultFor(label: string): (
  args: any,
  result: { content: Array<{ type?: string; text?: string }>; isError: boolean },
) => unknown {
  return (_args, result) => {
    const text = result.content.map((b) => (b.type === 'text' && b.text) || '').join('').trim()
    if (result.isError) {
      return { card: 'generic', title: `${label} failed`, content: [{ type: 'text', text: text || 'unknown error' }] }
    }
    return { card: 'generic', title: `${label} ok`, content: text ? [{ type: 'text', text }] : undefined }
  }
}

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
    private readonly extraHeaders: Record<string, string> = {},
  ) {}

  private async fetchRaw(method: string, params: Record<string, unknown>, sessionId?: string | null): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: this.auth,
      ...this.extraHeaders,
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
    order: 2960,
    text:
      'You have long-term memory via the Noc MCP server. At the start of ' +
      'substantial work call noc_boot to load core memories, recent context, ' +
      'triggers (system://triggers), and today\'s briefing; then ' +
      'read system://focus to resume active working trees; use noc_search before ' +
      'answering from memory — describe what you need in natural language, not ' +
      'just keywords (semantic recall finds memories with no shared words); ' +
      'persist valuable outcomes with noc_create; revise with noc_update; remove ' +
      'dead nodes with noc_delete. ' +
      'Periodically (after many new memories or when you repeat a mistake) ' +
      'run a memory audit: noc_read system://diagnostic/noc, then fix what it ' +
      'flags — never-reaccessed high-priority memories (disclosure/placement), ' +
      'stale or cold candidates (noc_delete if dead, demote if niche), crowded ' +
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
        return new NocClient(config.mcp_url, await resolveAuth(), config.protocol_version ?? '2024-11-05', config.mcp_headers ?? {})
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
      'Call at session start. Loads core memories, recent context, triggers ' +
      '(system://triggers), and today\'s working-memory briefing. Self-discipline startup protocol.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_a, v) => [{ type: 'text', text: String(v) }],
      presentationMeta: () => ({ action: 'boot' }),
    },
    isConcurrencySafe: () => true,
    presentCall: presentCallFor('noc_boot', () => 'load core + recent + triggers + briefing'),
    presentResult: presentResultFor('noc_boot'),
    async execute(_args, _exec) {
      const c = await client()
      const out: string[] = []
      for (const uri of BOOT_URIS) {
        const data = await c.call('tools/call', { name: MCP_TOOLS.read, arguments: { uri } })
        const text = extractText(data)
        if (!text) continue
        out.push(`[${uri}]\n${text}`)
      }
      // Daily briefing: best-effort — boot still succeeds if server lacks it.
      try {
        const data = await c.call('tools/call', { name: MCP_TOOLS.read, arguments: { uri: 'system://briefing' } })
        const text = extractText(data)
        if (text && !/^Unknown system URI/i.test(text.trim()) && !text.startsWith('Error:')) {
          out.push(`[system://briefing]\n${text}`)
        }
      } catch {
        // ignore
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
    output: {
      schema: { type: 'string' },
      render: (_a, v) => [{ type: 'text', text: String(v) }],
      presentationMeta: (args: any) => ({ action: 'read', uri: args.uri ?? '' }),
    },
    isConcurrencySafe: () => true,
    presentCall: presentCallFor('noc_read', (args) => args.uri),
    presentResult: presentResultFor('noc_read'),
    async execute(args, _exec) {
      const c = await client()
      const data = await c.call('tools/call', { name: MCP_TOOLS.read, arguments: { uri: args.uri } })
      return extractText(data)
    },
  })

  register({
    name: 'noc_search',
    description:
      'Search memories with semantic + keyword recall (multilingual, CJK-capable). ' +
      'Describe what you are looking for in natural language — semantic search finds ' +
      'memories that share no keywords (e.g. query "部署失败" recalls a note about a broken release pipeline).',
    parameters: {
      query: { type: 'string', required: true, description: 'Concept or keywords to search for' },
      limit: { type: 'number', description: 'Max results (1-50, default 20)' },
      domain: { type: 'string', description: 'Domain filter (e.g., core, writer); ignored by current cf-noc-mem' },
    },
    output: {
      schema: { type: 'string' },
      render: (_a, v) => [{ type: 'text', text: String(v) }],
      presentationMeta: (args: any) => ({ action: 'search', query: args.query ?? '' }),
    },
    isConcurrencySafe: () => true,
    presentCall: presentCallFor('noc_search', (args) => args.query),
    presentResult: presentResultFor('noc_search'),
    async execute(args, _exec) {
      const c = await client()
      const arguments_: Record<string, unknown> = { query: args.query }
      if (args.limit !== undefined) arguments_.limit = args.limit
      if (args.domain) arguments_.domain = args.domain
      const data = await c.call('tools/call', {
        name: MCP_TOOLS.search,
        arguments: arguments_,
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
    output: {
      schema: { type: 'string' },
      render: (_a, v) => [{ type: 'text', text: String(v) }],
      presentationMeta: (args: any) => ({ action: 'create', parent_uri: args.parent_uri ?? '', title: args.title ?? '' }),
    },
    isConcurrencySafe: () => true,
    presentCall: presentCallFor('noc_create', (args) => args.title ?? args.parent_uri),
    presentResult: presentResultFor('noc_create'),
    async execute(args, _exec) {
      const c = await client()
      const data = await c.call('tools/call', {
        name: MCP_TOOLS.create,
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
    description:
      'Update existing memory. Supports full content replace, old_string/new_string patch, or append. ' +
      'Must noc_read the URI first. Optional relation marks knowledge evolution: replace|enrich|confirm|challenge.',
    parameters: {
      uri: { type: 'string', required: true, description: 'Memory URI to update' },
      content: { type: 'string', description: 'Full replacement content' },
      old_string: { type: 'string', description: 'Exact text to replace (patch)' },
      new_string: { type: 'string', description: 'Replacement text (patch)' },
      append: { type: 'string', description: 'Text to append' },
      priority: { type: 'number', description: 'New priority (lower = more important)' },
      disclosure: { type: 'string', description: 'New disclosure condition' },
      expires_at: { type: 'string', description: 'ISO datetime to expire, or "" to clear' },
      relation: {
        type: 'string',
        enum: ['replace', 'enrich', 'confirm', 'challenge'],
        description: 'Knowledge-evolution relation to previous version',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_a, v) => [{ type: 'text', text: String(v) }],
      presentationMeta: (args: any) => ({ action: 'update', uri: args.uri ?? '' }),
    },
    isConcurrencySafe: () => true,
    presentCall: presentCallFor('noc_update', (args) => args.uri),
    presentResult: presentResultFor('noc_update'),
    async execute(args, _exec) {
      const c = await client()
      const arguments_: Record<string, unknown> = { uri: args.uri }
      if (args.content !== undefined) arguments_.content = args.content
      if (args.old_string) arguments_.old_string = args.old_string
      if (args.new_string !== undefined) arguments_.new_string = args.new_string
      if (args.append) arguments_.append = args.append
      if (args.priority !== undefined) arguments_.priority = args.priority
      if (args.disclosure) arguments_.disclosure = args.disclosure
      if (args.expires_at !== undefined) arguments_.expires_at = args.expires_at
      if (args.relation) arguments_.relation = args.relation
      const data = await c.call('tools/call', {
        name: MCP_TOOLS.update,
        arguments: arguments_,
      })
      return extractText(data)
    },
  })

  register({
    name: 'noc_delete',
    description:
      'Delete a memory by URI (cuts its path). Always noc_read the full node first. ' +
      'If the node has children, the server may return orphans to handle first.',
    parameters: {
      uri: { type: 'string', required: true, description: 'Memory URI to delete' },
    },
    output: {
      schema: { type: 'string' },
      render: (_a, v) => [{ type: 'text', text: String(v) }],
      presentationMeta: (args: any) => ({ action: 'delete', uri: args.uri ?? '' }),
    },
    isConcurrencySafe: () => true,
    presentCall: presentCallFor('noc_delete', (args) => args.uri),
    presentResult: presentResultFor('noc_delete'),
    async execute(args, _exec) {
      const c = await client()
      const data = await c.call('tools/call', {
        name: MCP_TOOLS.delete,
        arguments: { uri: args.uri },
      })
      return extractText(data)
    },
  })
}
