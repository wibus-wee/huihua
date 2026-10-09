import type { DecoderContribution, DecoderInput, DecoderReplay, SessionDecoder } from '../contracts/decoder.ts'
import type { RawRecord, SessionSource } from '../contracts/source.ts'
import type { Ingestion } from './ingestion.ts'

interface DecoderNamespace {
  readonly metadata?: { readonly record: number, readonly data: Readonly<Record<string, unknown>> }
  readonly parentSessionIds?: readonly { readonly record: number, readonly id: string }[]
}

/** One runner per replay; no source acquisition or mutable provider state lives here. */
export class DecoderRunner {
  readonly #replays: { id: string, replay: DecoderReplay }[]
  readonly #records = new WeakSet<RawRecord>()
  readonly #namespaces = new Map<string, DecoderNamespace>()
  readonly #parents = new Set<string>()
  readonly #ingest: Ingestion

  constructor(decoders: readonly SessionDecoder[], context: { provider: string, source: SessionSource }, ingest: Ingestion) {
    this.#ingest = ingest
    this.#replays = decoders.map(({ id, create }) => {
      try {
        return { id, replay: create(context) }
      }
      catch (cause) {
        throw new Error(`decoder ${id} failed during create`, { cause })
      }
    })
  }

  decode(input: DecoderInput): void {
    this.#records.add(input.record)
    for (const { id, replay } of this.#replays)
      this.#run(id, 'decode', () => replay.decode(input))
    // A contribution may refer to an earlier row; the native parser keeps its current row.
    this.#ingest.associate(input.record)
  }

  finish(): void {
    for (const { id, replay } of this.#replays) {
      if (replay.finish)
        this.#run(id, 'finish', () => replay.finish!())
    }
    if (this.#parents.size === 0)
      return
    const native = this.#ingest.parentSessionIds()
    if (native.size > 0) {
      if ([...this.#parents].some(id => !native.has(id)))
        this.#ingest.diagnostic('PartialParse', 'decoder parent-session candidates conflict with native lineage; native parent is authoritative')
    }
    else if (this.#parents.size === 1) {
      this.#ingest.patch({ parentSessionId: [...this.#parents][0]! })
    }
    else {
      this.#ingest.diagnostic('PartialParse', 'conflicting decoder parent-session candidates retained; canonical parentSessionId omitted')
    }
  }

  #run(id: string, phase: string, callback: () => readonly DecoderContribution[]): void {
    try {
      const contributions = callback()
      for (const contribution of contributions)
        this.#apply(id, contribution)
    }
    catch (cause) {
      throw new Error(`decoder ${id} failed during ${phase}`, { cause })
    }
  }

  #apply(id: string, contribution: DecoderContribution): void {
    const { record } = contribution
    if (!this.#records.has(record))
      throw new TypeError('contribution must reference a record from this replay')
    switch (contribution.type) {
      case 'event':
        this.#ingest.associate(record)
        this.#ingest.emit(contribution.event.type, contribution.event.data, record.native, {
          decoder: id,
          ...(contribution.event.type === 'tool_call' || contribution.event.type === 'tool_result' ? { tool_scope: ['decoder', id] } : {}),
        })
        return
      case 'metadata':
        this.#namespaces.set(id, { ...this.#namespaces.get(id), metadata: { record: record.sequence, data: contribution.data } })
        break
      case 'parent_session': {
        if (typeof contribution.id !== 'string' || contribution.id.trim() === '')
          throw new TypeError('parent-session candidate must have a nonempty ID')
        this.#parents.add(contribution.id)
        const previous = this.#namespaces.get(id)
        this.#namespaces.set(id, { ...previous, parentSessionIds: [...previous?.parentSessionIds ?? [], { record: record.sequence, id: contribution.id }] })
        break
      }
      default:
        throw new TypeError('unrecognized decoder contribution')
    }
    this.#ingest.patch({ metadata: { decoders: Object.fromEntries(this.#namespaces) } })
  }
}
