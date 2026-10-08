import assert from 'node:assert/strict'
import process from 'node:process'

export function required(name: string): string {
  const value = process.env[name]
  assert(value !== undefined && value !== '', `${name} is required`)
  return value
}
export async function json(url: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { 'content-type': 'application/json', 'x-api-key': 'synthetic-test-key', 'anthropic-version': '2023-06-01' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
  assert(response.ok, `${url}: ${response.status} ${await response.clone().text()}`)
  return await response.json() as Record<string, unknown>
}
export function exchange(label: string, marker: string, block: Record<string, unknown>, stop: string, template: Record<string, unknown>) {
  const delta = block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text }
  return { label, request: { method: 'POST', path: '/v1/messages', bodyTextIncludes: [marker] }, response: { kind: 'stream', steps: [
    { kind: 'event', event: { type: 'message_start', message: { ...template, id: `msg_${label.replaceAll(' ', '_')}`, content: [], stop_reason: null } } },
    { kind: 'event', event: { type: 'content_block_start', index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { ...block, text: '' } } },
    { kind: 'event', event: { type: 'content_block_delta', index: 0, delta } },
    { kind: 'event', event: { type: 'content_block_stop', index: 0 } },
    { kind: 'event', event: { type: 'message_delta', context_management: null, delta: { stop_reason: stop, stop_sequence: null, stop_details: null, container: null }, usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, fallback_credit: null, input_tokens: 1, iterations: null, output_tokens: 12, output_tokens_details: null, server_tool_use: null } } },
    { kind: 'event', event: { type: 'message_stop' } },
    { kind: 'close' },
  ] } }
}
