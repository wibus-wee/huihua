import type { DecoderContribution, DecoderInput, DecoderReplay, SessionDecoder } from '../contracts/decoder.ts'
import type { FrameSelection } from '../contracts/session.ts'
import type { RawRecord, SessionSource } from '../contracts/source.ts'
import type { Ingestion } from './ingestion.ts'

interface DecoderNamespace {
  metadata?: { readonly record: number, readonly data: Readonly<Record<string, unknown>> }
  parentSessionIds?: { readonly record: number, readonly id: string }[]
}

/** One runner per replay; no source acquisition or mutable provider state lives here. */
export class DecoderRunner {
  readonly #replays: { id: string, replay: DecoderReplay }[]
  readonly #records = new WeakSet<RawRecord>()
  readonly #namespaces: Map<string, DecoderNamespace> | undefined
  readonly #parents = new Set<string>()
  readonly #ingest: Ingestion

  constructor(decoders: readonly SessionDecoder[], context: { provider: string, source: SessionSource }, ingest: Ingestion, selection: FrameSelection = {}) {
    this.#ingest = ingest
    this.#namespaces = selection.metadata !== false && (selection.metadataKeys === undefined || selection.metadataKeys.includes('metadata')) ? new Map() : undefined
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
      this.#run(id, replay, input)
    // A contribution may refer to an earlier row; the native parser keeps its current row.
    this.#ingest.associate(input.record)
  }

  finish(): void {
    for (const { id, replay } of this.#replays) {
      if (replay.finish)
        this.#run(id, replay)
    }
    if (this.#namespaces !== undefined && this.#namespaces.size > 0)
      this.#ingest.patch({ metadata: { decoders: Object.fromEntries(this.#namespaces) } })
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

  #run(id: string, replay: DecoderReplay, input?: DecoderInput): void {
    try {
      const contributions = input === undefined ? replay.finish!() : replay.decode(input)
      for (const contribution of contributions)
        this.#apply(id, contribution)
    }
    catch (cause) {
      throw new Error(`decoder ${id} failed during ${input === undefined ? 'finish' : 'decode'}`, { cause })
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
        if (this.#namespaces !== undefined)
          this.#namespace(id).metadata = { record: record.sequence, data: contribution.data }
        break
      case 'parent_session': {
        if (typeof contribution.id !== 'string' || contribution.id.trim() === '')
          throw new TypeError('parent-session candidate must have a nonempty ID')
        this.#parents.add(contribution.id)
        if (this.#namespaces !== undefined)
          (this.#namespace(id).parentSessionIds ??= []).push({ record: record.sequence, id: contribution.id })
        break
      }
      default:
        throw new TypeError('unrecognized decoder contribution')
    }
  }

  #namespace(id: string): DecoderNamespace {
    let namespace = this.#namespaces!.get(id)
    if (namespace === undefined) {
      namespace = {}
      this.#namespaces!.set(id, namespace)
    }
    return namespace
  }
}
