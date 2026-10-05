export type Timestamp
  = | { readonly format: 'rfc3339', readonly value: string }
    | { readonly format: 'unix_millis', readonly value: number }
export interface Attachment {
  readonly uri?: string
  readonly mimeType?: string
  readonly data?: unknown
  readonly metadata: Readonly<Record<string, unknown>>
}
export type ContentBlock
  = | { readonly type: 'text', readonly data: string }
    | { readonly type: 'image' | 'file', readonly data: Attachment }
    | { readonly type: 'structured', readonly data: unknown }
export interface EventDataMap {
  user_message: { readonly content: readonly ContentBlock[] }
  assistant_message: {
    readonly content: readonly ContentBlock[]
    readonly model?: string
  }
  reasoning: {
    readonly text?: string
    readonly summary?: string
    readonly encrypted?: unknown
  }
  tool_call: {
    readonly callId?: string
    readonly toolName: string
    readonly arguments: unknown
  }
  tool_result: {
    readonly callId?: string
    readonly toolName?: string
    readonly result: unknown
    readonly isError: boolean
  }
  command: {
    readonly command: unknown
    readonly output?: unknown
    readonly exitCode?: number
  }
  file_change: {
    readonly path: string
    readonly operation: 'create' | 'modify' | 'delete' | 'rename' | 'unknown'
    readonly before?: string
    readonly after?: string
    readonly diff?: string
  }
  permission_request: {
    readonly requestId?: string
    readonly request: unknown
  }
  subagent: {
    readonly agentId: string
    readonly parentAgentId?: string
    readonly kind: 'spawn' | 'started' | 'message' | 'completed' | 'failed'
    readonly name?: string
    readonly metadata: Readonly<Record<string, unknown>>
  }
  usage: { readonly usage: unknown }
  error: { readonly message?: string, readonly details: unknown }
  system: { readonly sourceType: string, readonly payload: unknown }
  unknown: { readonly sourceType: string, readonly payload: unknown }
}
export type EventType = keyof EventDataMap
export type EventBody = {
  [K in EventType]: { readonly type: K, readonly data: EventDataMap[K] };
}[EventType]
export interface EventEnvelope {
  readonly sequence: number
  readonly record: number
  readonly id?: string
  readonly timestamp?: Timestamp
  readonly providerMetadata: Readonly<Record<string, unknown>>
}
export type SessionEvent = EventEnvelope & EventBody
