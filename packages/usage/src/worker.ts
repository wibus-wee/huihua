import { parentPort, workerData } from 'node:worker_threads'

import type { SessionRef } from 'huihua'

import type { ExecutionOptions } from './cli.ts'
import { consumeRef, usageRegistry } from './cli.ts'
import type { ReportOptions } from './report.ts'
import { UsageReportBuilder } from './report.ts'

interface Work {
  refs: readonly SessionRef[]
  options: ReportOptions
  execution: ExecutionOptions
  useCallback: boolean
}

async function read(): Promise<void> {
  if (parentPort === null)
    throw new Error('usage worker requires its parent port')
  const { refs, options, execution, useCallback } = workerData as Work
  const controller = new AbortController()
  parentPort.on('message', () => controller.abort(new Error('usage sibling failed')))
  try {
    const sessions = await usageRegistry(refs.map(ref => ref.provider))
    const builder = new UsageReportBuilder(refs, options)
    for (const ref of refs) {
      const open = await sessions.open(ref, {
        signal: controller.signal,
        batchDecode: execution.batchDecode === true,
        ...(execution.maxRecordBytes === undefined ? {} : { maxRecordBytes: execution.maxRecordBytes }),
      })
      await consumeRef(builder, ref, open, execution, useCallback)
    }
    parentPort.postMessage(builder.partition())
  }
  catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
  finally {
    parentPort.close()
  }
}
void read().catch((error: unknown) => {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) })
  parentPort?.close()
})
