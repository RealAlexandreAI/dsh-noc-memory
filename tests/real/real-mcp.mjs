// Real integration: dsh-noc-memory — mount into cordis and run real
// Nocturne MCP calls (read a memory via boot URIs). Config comes from the pi
// extension's config file — no env vars.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../../src/index.ts'

let mcpUrl = ''
let mcpAuth = ''
try {
  const c = JSON.parse(readFileSync(join(homedir(), '.pi', 'agent', 'extensions', 'pi-noc-memory', 'config.json'), 'utf8'))
  mcpUrl = c.mcpUrl ?? ''
  mcpAuth = c.mcpAuth ?? ''
} catch {}

if (!mcpUrl || !mcpAuth) {
  console.log('SKIP: no Noc MCP config in ~/.pi/agent/extensions/pi-noc-memory/config.json')
  process.exit(0)
}

const ctx = new Context()
const registered = []
ctx.provide('tools', { register(t) { registered.push(t) } })
ctx.provide('systemPrompt', { section() {} })

apply(ctx, { mcp_url: mcpUrl, mcp_auth: mcpAuth })

const boot = registered.find((t) => t.name === 'noc_boot')
const res = await boot.execute({}, {})
const text = String(res)
console.log('noc_boot:', text.slice(0, 200))
console.log(text.length > 0 ? 'E2E PASS' : 'E2E FAIL: empty boot')
