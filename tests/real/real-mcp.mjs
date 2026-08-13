// Real integration: dsh-nocturne-memory — mount into cordis and run real
// Nocturne MCP calls (read a memory via boot URIs).
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

// Load the real Nocturne config the user already has for pi.
let mcpUrl = process.env.NOCTURNE_MCP_URL
let mcpAuth = process.env.NOCTURNE_MCP_AUTH
try {
  const c = JSON.parse(readFileSync(join(homedir(), '.pi', 'agent', 'extensions', 'pi-nocturne-memory', 'config.json'), 'utf8'))
  mcpUrl = mcpUrl ?? c.mcpUrl
  mcpAuth = mcpAuth ?? c.mcpAuth
} catch {}

if (!mcpUrl || !mcpAuth) {
  console.log('SKIP: no Nocturne MCP config')
  process.exit(0)
}

const ctx = new Context()
const registered = []
ctx.provide('tools', { register(t) { registered.push(t) } })
ctx.provide('credentials', { async resolve() { return { value: '', source: 'env' } } })
ctx.provide('systemPrompt', { section() {} })

apply(ctx, { mcp_url: mcpUrl, mcp_auth: mcpAuth })

const boot = registered.find((t) => t.name === 'nocturne_boot')
const res = await boot.execute({}, {})
const text = String(res)
console.log('nocturne_boot:', text.slice(0, 200))
console.log(text.length > 0 ? 'E2E PASS' : 'E2E FAIL: empty boot')
