import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openCodeConfig } from '../tools/producer-compat/live.ts'

await test('OpenCode synthetic model survives removal from the bundled model catalog', () => {
  const config = openCodeConfig('http://127.0.0.1:18889')
  const provider = config.provider.anthropic
  const modelID = config.model.slice('anthropic/'.length)
  const model = provider.models[modelID as keyof typeof provider.models]
  assert.equal(model.status, 'active', 'explicit model must override inherited catalog deprecation')
  assert.equal(config.small_model, config.model)
  assert.deepEqual(config.permission, { '*': 'deny' })
})
