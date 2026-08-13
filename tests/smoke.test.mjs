// Cordis runtime smoke test: registers the 5 Nocturne tools.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyMemory } from '../src/index.ts'

function makeCtx() {
  const ctx = new Context()
  const registered = []
  ctx.provide('tools', {
    register(tool) {
      registered.push(tool)
    },
  })
  ctx.provide('credentials', {
    async resolve() {
      return { value: 'test-auth', source: 'env' }
    },
  })
  ctx.provide('systemPrompt', { section() {} })
  return { ctx, registered }
}

describe('dsh-memory smoke', () => {
  it('registers the 5 nocturne tools', () => {
    const { ctx, registered } = makeCtx()
    applyMemory(ctx, { mcp_url: 'http://localhost:9999/mcp', mcp_auth: 'x' })
    const names = registered.map((t) => t.name).sort()
    assert.deepEqual(names, [
      'nocturne_boot',
      'nocturne_create',
      'nocturne_read',
      'nocturne_search',
      'nocturne_update',
    ])
  })
})
