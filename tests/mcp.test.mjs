/**
 * Tests for dsh-memory: SSE parsing and text extraction (pure logic,
 * no dsh runtime / MCP server needed).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractText, parseStreamResponse } from '../src/index.ts'

describe('parseStreamResponse', () => {
  it('parses a single SSE data block', () => {
    const out = parseStreamResponse('event: message\ndata: {"jsonrpc":"2.0","id":"1","result":{"content":[{"type":"text","text":"hi"}]}}\n\n')
    assert.equal(out.result.content[0].text, 'hi')
  })

  it('parses multiple blocks, returns the first with result/error', () => {
    const body =
      'data: {"jsonrpc":"2.0","id":"0","result":{"protocolVersion":"2024-11-05"}}\n\n' +
      'data: {"jsonrpc":"2.0","id":"1","result":{"content":[{"type":"text","text":"x"}]}}\n\n'
    const out = parseStreamResponse(body)
    assert.equal(out.result.protocolVersion, '2024-11-05')
  })

  it('returns null for empty body', () => {
    assert.equal(parseStreamResponse(''), null)
  })
})

describe('extractText', () => {
  it('extracts content text', () => {
    const data = { result: { content: [{ type: 'text', text: 'memory content' }] } }
    assert.equal(extractText(data), 'memory content')
  })

  it('returns error message on error', () => {
    const data = { error: { code: -1, message: 'boom' } }
    assert.equal(extractText(data), 'Error: boom')
  })

  it('returns empty for unknown shapes', () => {
    assert.equal(extractText(null), '')
    assert.equal(extractText({}), '')
  })
})
