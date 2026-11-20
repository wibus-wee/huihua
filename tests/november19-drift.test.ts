import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import type { DriftSummary } from '../tools/producer-compat/runtime.ts'
import { assertNoProducerDrift, NativeDriftError } from '../tools/producer-compat/runtime.ts'

const changes = [
  [
    'deepseek',
    {
      fieldPaths: [
        '$.data.header.tools[].parameters.properties.agent.description:string',
        '$.data.header.tools[].parameters.properties.agent.type:string',
        '$.data.header.tools[].parameters.properties.agent:object',
        '$.data.message.source.replayState.response.prefixDigest:string',
        '$.data.stream[].chunk.replayState.response.prefixDigest:string',
      ],
      groupedFieldPaths: [
        '["assistant/message",null,null,null,null,null,null,null]:$.data.message.source.replayState.response.prefixDigest:string',
        '["assistant/message",null,null,null,null,null,null,null]:$.data.stream[].chunk.replayState.response.prefixDigest:string',
        '["request/header",null,null,null,null,null,null,null]:$.data.header.tools[].parameters.properties.agent.description:string',
        '["request/header",null,null,null,null,null,null,null]:$.data.header.tools[].parameters.properties.agent.type:string',
        '["request/header",null,null,null,null,null,null,null]:$.data.header.tools[].parameters.properties.agent:object',
      ],
    },
    {
      fieldPaths: [
        '$.data.header.tools[].parameters.properties.agent_id.description:string',
        '$.data.header.tools[].parameters.properties.agent_id.type:string',
        '$.data.header.tools[].parameters.properties.agent_id:object',
        '$.data.header.tools[].parameters.properties.plan.description:string',
        '$.data.header.tools[].parameters.properties.plan.type:string',
        '$.data.header.tools[].parameters.properties.plan:object',
        '$.data.header.tools[].parameters.properties.queries.description:string',
        '$.data.header.tools[].parameters.properties.queries.items.type:string',
        '$.data.header.tools[].parameters.properties.queries.items:object',
        '$.data.header.tools[].parameters.properties.queries.type:string',
        '$.data.header.tools[].parameters.properties.queries:object',
        '$.data.header.tools[].parameters.properties.scope.description:string',
        '$.data.header.tools[].parameters.properties.scope.enum:array',
        '$.data.header.tools[].parameters.properties.scope.enum[]:string',
        '$.data.header.tools[].parameters.properties.scope.type:string',
        '$.data.header.tools[].parameters.properties.scope:object',
      ],
      groupedFieldPaths: [
        '["request/header",null,null,null,null,null,null,null]:$.data.header.tools[].parameters.properties.agent_id.description:string',
        '["request/header",null,null,null,null,null,null,null]:$.data.header.tools[].parameters.properties.agent_id.type:string',
        '["request/header",null,null,null,null,null,null,null]:$.data.header.tools[].parameters.properties.agent_id:object',
        '["request/header",null,null,null,null,null,null,null]:$.data.header.tools[].parameters.properties.plan.description:string',
        '["request/header",null,null,null,null,null,null,null]:$.data.header.tools[].parameters.properties.plan.type:string',
        '["request/header",null,null,null,null,null,null,null]:$.data.header.tools[].parameters.properties.plan:object',
        '["request/header",null,null,null,null,null,null,null]:$.data.header.tools[].parameters.properties.queries.description:string',
        '["request/header",null,null,null,null,null,null,null]:$.data.header.tools[].parameters.properties.queries.items.type:string',
        '["request/header",null,null,null,null,null,null,null]:$.data.header.tools[].parameters.properties.queries.items:object',
        '["request/header",null,null,null,null,null,null,null]:$.data.header.tools[].parameters.properties.queries.type:string',
        '["request/header",null,null,null,null,null,null,null]:$.data.header.tools[].parameters.properties.queries:object',
        '["request/header",null,null,null,null,null,null,null]:$.data.header.tools[].parameters.properties.scope.description:string',
        '["request/header",null,null,null,null,null,null,null]:$.data.header.tools[].parameters.properties.scope.enum:array',
        '["request/header",null,null,null,null,null,null,null]:$.data.header.tools[].parameters.properties.scope.enum[]:string',
        '["request/header",null,null,null,null,null,null,null]:$.data.header.tools[].parameters.properties.scope.type:string',
        '["request/header",null,null,null,null,null,null,null]:$.data.header.tools[].parameters.properties.scope:object',
      ],
    },
  ],
  [
    'grok',
    {
      fieldPaths: [
        '$.timestamp_us:number',
      ],
      groupedFieldPaths: [
        '["_x.ai/session/update",null,null,"background_tasks",null,null,null,null]:$.timestamp_us:number',
        '["_x.ai/session/update",null,null,"turn_completed",null,null,null,null]:$.timestamp_us:number',
        '["session/update",null,null,"agent_message_chunk",null,null,null,null]:$.timestamp_us:number',
        '["session/update",null,null,"user_message_chunk",null,null,null,null]:$.timestamp_us:number',
      ],
    },
    {
      fieldPaths: [],
      groupedFieldPaths: [],
    },
  ],
] as const
for (const [provider, added, removed] of changes) {
  await test(`${provider} November 19 reviewed native changes remain narrow`, async () => {
    const baseline = JSON.parse(await readFile(new URL(`../tools/producer-compat/baselines/${provider}.json`, import.meta.url), 'utf8')) as DriftSummary
    const actual = { ...baseline, fieldPaths: [...baseline.fieldPaths.filter(p => !(removed.fieldPaths as readonly string[]).includes(p)), ...added.fieldPaths], groupedFieldPaths: [...baseline.groupedFieldPaths!.filter(p => !(removed.groupedFieldPaths as readonly string[]).includes(p)), ...added.groupedFieldPaths] }
    assertNoProducerDrift(actual, baseline)
    for (const path of ['"wrong":$.timestamp_us:number', `${added.groupedFieldPaths[0].replace(/:[^:]+$/, ':boolean')}`, '"future":$.future:string']) {
      assert.throws(() => assertNoProducerDrift({ ...actual, groupedFieldPaths: [...actual.groupedFieldPaths, path] }, baseline), NativeDriftError)
    }
    const required = baseline.groupedFieldPaths!.find(p => !baseline.optionalGroupedFieldPaths?.includes(p))!
    assert.throws(() => assertNoProducerDrift({ ...actual, groupedFieldPaths: actual.groupedFieldPaths.filter(p => p !== required) }, baseline), NativeDriftError)
  })
}
