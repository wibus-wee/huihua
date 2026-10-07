import { SessionError } from './contracts/diagnostic.ts'
import type { SessionEvent } from './contracts/event.ts'
import type {
  DetectOptions,
  JsonlInput,
  ReadOptions,
  ScanEvent,
  ScanFailure,
  ScanOptions,
  ScanResult,
  SessionInput,
  SessionProvider,
} from './contracts/provider.ts'
import { positiveLimit, scanFailure } from './contracts/provider.ts'
import type { OpenSession, SessionFrame, SessionRef } from './contracts/session.ts'
/** Consumer-owned provider composition; no builtin identities or parsers belong here. */
export class SessionRegistry {
  readonly #providers = new Map<string, SessionProvider>()
  constructor(providers: Iterable<SessionProvider>) {
    for (const provider of providers) {
      if (this.#providers.has(provider.id))
        throw new TypeError(`duplicate provider id: ${provider.id}`)
      this.#providers.set(provider.id, provider)
    }
  }

  providers(): readonly SessionProvider[] {
    return [...this.#providers.values()]
  }

  require(id: string): SessionProvider {
    const provider = this.#providers.get(id)
    if (!provider)
      throw new SessionError('ProviderNotFound', `unregistered provider ${id}`)
    return provider
  }

  async detect(options?: DetectOptions) {
    const results = []
    for (const provider of this.#providers.values())
      results.push(await provider.detect(options))
    return results
  }

  async* scanStream(options: ScanOptions = {}): AsyncGenerator<ScanEvent, void> {
    options.signal?.throwIfAborted()
    positiveLimit(options.headerBytes, 65536)
    const selected
      = options.providers === undefined
        ? this.providers()
        : Array.from(new Set(options.providers), id => this.require(id))
    const seen = new Set<string>()
    for (const provider of selected) {
      options.signal?.throwIfAborted()
      let yielding = false
      try {
        for await (const event of provider.scan(options)) {
          options.signal?.throwIfAborted()
          if (event.type === 'ref') {
            const key = JSON.stringify([event.ref.provider, event.ref.source])
            if (seen.has(key))
              continue
            seen.add(key)
          }
          yielding = true
          yield event
          yielding = false
        }
        options.signal?.throwIfAborted()
      }
      catch (error) {
        options.signal?.throwIfAborted()
        // Consumer throw()/return() and their cleanup errors must not become provider failures.
        if (yielding)
          throw error
        yield { type: 'failure', failure: scanFailure(provider.id, error) }
      }
    }
  }

  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    const refs: SessionRef[] = []
    const failures: ScanFailure[] = []
    for await (const event of this.scanStream(options)) {
      if (event.type === 'ref')
        refs.push(event.ref)
      else
        failures.push(event.failure)
    }
    refs.sort((a, b) =>
      `${a.provider}\0${a.source.path}\0${a.id}`.localeCompare(
        `${b.provider}\0${b.source.path}\0${b.id}`,
        'en',
      ))
    return { refs, failures }
  }

  async read(ref: SessionRef, options?: ReadOptions) {
    return this.require(ref.provider).read(ref, options)
  }

  async parse(providerId: string, input: SessionInput, options?: ReadOptions) {
    const provider = this.require(providerId)
    options?.signal?.throwIfAborted()
    if ('path' in input) {
      return provider.read({
        id: input.id ?? `source:${input.path}`,
        provider: providerId,
        metadata: { id_origin: input.id === undefined ? 'source_locator' : 'caller' },
        source: {
          path: input.path,
          format: input.format ?? 'jsonl',
          ...(input.id === undefined && input.locator === undefined
            ? {}
            : { locator: { ...(input.id === undefined ? {} : { id: input.id }), ...input.locator } }),
        },
      }, options)
    }
    if (!provider.parse) {
      throw new SessionError('UnsupportedSchema', `${providerId} does not support acquired JSONL input`)
    }
    return provider.parse(input, options)
  }

  /** Each result accepts one consumer. To replay, call again with fresh input; no snapshot fallback is used. */
  stream(providerId: string, input: JsonlInput, options?: ReadOptions): AsyncIterable<SessionFrame> {
    const provider = this.require(providerId)
    options?.signal?.throwIfAborted()
    if (!provider.stream) {
      throw new SessionError('UnsupportedSchema', `${providerId} does not support acquired JSONL streaming`)
    }
    return provider.stream(input, options)
  }

  async open(ref: SessionRef, options?: ReadOptions): Promise<OpenSession> {
    const provider = this.require(ref.provider)
    if (provider.open)
      return provider.open(ref, options)
    // Third-party adapters can implement only the minimal SPI. Their fallback is eager.
    const snapshot = async () => provider.read(ref, options)
    return {
      ref,
      readMode: 'buffered',
      snapshot,
      async* events() {
        yield* (await snapshot()).events
      },
      async* records() {
        yield* (await snapshot()).records
      },
      async* stream() {
        const value = await snapshot()
        const eventsByRecord = new Map<number, SessionEvent[]>()
        for (const event of value.events) {
          const owned = eventsByRecord.get(event.record)
          if (owned === undefined)
            eventsByRecord.set(event.record, [event])
          else
            owned.push(event)
        }
        for (const record of value.records) {
          yield { type: 'record', record }
          for (const event of eventsByRecord.get(record.sequence) ?? [])
            yield { type: 'event', event }
        }
        for (const diagnostic of value.diagnostics)
          yield { type: 'diagnostic', diagnostic }
      },
    }
  }
}
export function createSessionRegistry(
  providers: Iterable<SessionProvider> = [],
): SessionRegistry {
  return new SessionRegistry(providers)
}
