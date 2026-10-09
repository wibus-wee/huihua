import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import process from 'node:process'

import type { ScanOptions } from '../../contracts/provider.ts'
import type { Session } from '../../contracts/session.ts'
import { jsonlProvider, messageEvents } from '../../shared/ingestion.ts'
import { ioError, pathMatcher } from '../../shared/paths.ts'
import { scanSource } from '../../shared/scan.ts'
import { object, optional, string, timestamp } from '../../shared/value.ts'

async function resolveClaudeRoots(options: ScanOptions, siblingsEnabled = true): Promise<readonly string[]> {
  if (options.roots?.claude)
    return options.roots.claude
  const home = options.homeDir ?? homedir()
  const config
    = options.homeDir === undefined ? process.env.CLAUDE_CONFIG_DIR : undefined
  const multi = options.homeDir === undefined ? process.env.CLAUDE_CONFIG_DIRS : undefined
  const xdg
    = options.homeDir === undefined ? process.env.XDG_CONFIG_HOME : undefined
  let siblings: string[] = []
  try {
    siblings = siblingsEnabled
      ? (await readdir(home, { withFileTypes: true }))
          .filter(entry => entry.isDirectory() && entry.name.startsWith('.claude'))
          .map(entry => join(home, entry.name, 'projects'))
      : []
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      ioError(error, home)
  }
  return [...new Set([
    ...[...(multi?.split(delimiter).filter(Boolean) ?? []), ...(config !== undefined && config !== '' ? [config] : [])]
      .map(path => basename(path) === 'projects' ? path : join(path, 'projects')),
    join(home, '.claude/projects'),
    ...siblings.sort(),
    join(
      xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, '.config'),
      'claude/projects',
    ),
    join(home, 'Library/Application Support/Claude/local-agent-mode-sessions'),
  ])]
}
const desktopPath = pathMatcher('**/local_*/.claude/projects/**/*.{jsonl,ndjson}')
const insideRoot = pathMatcher('**')
function desktopDirectory(path: string): string | undefined {
  let directory = dirname(path)
  while (dirname(directory) !== directory) {
    if (basename(directory).startsWith('local_') && desktopPath(path, dirname(directory)))
      return directory
    directory = dirname(directory)
  }
  return undefined
}
function subagentMetadataPath(path: string): string | undefined {
  return basename(dirname(path)) === 'subagents' && /^agent-.+\.(?:jsonl|ndjson)$/.test(basename(path))
    ? path.replace(/\.(?:jsonl|ndjson)$/, '.meta.json')
    : undefined
}
const claude = jsonlProvider({
  id: 'claude',
  usageContext: true,
  roots: resolveClaudeRoots,
  accepts(path, candidate) {
    if (!path.endsWith('.jsonl') && !path.endsWith('.ndjson'))
      return false
    if (candidate.explicitFile)
      return true
    const desktop = candidate.roots.find(root => basename(root) === 'local-agent-mode-sessions')
    if (desktop !== undefined && insideRoot(path, desktop))
      return desktopPath(path, desktop)
    return basename(path) !== 'journal.jsonl'
  },
  identify({ header, explicitFile }) {
    return explicitFile || header.some(record => typeof object(record).sessionId === 'string') ? {} : false
  },
  metadataFiles(path) {
    const local = desktopDirectory(path)
    const subagent = subagentMetadataPath(path)
    return [...(local === undefined ? [] : [`${local}.json`]), ...(subagent === undefined ? [] : [subagent])]
  },
  metadata(records, path, context, keys) {
    const facts: Partial<Session> = {}
    let metadata: Record<string, unknown> = {}
    const wantsWorkspace = keys === undefined || keys.includes('workspace')
    const wantsCreated = keys === undefined || keys.includes('createdAt')
    const wantsParent = keys === undefined || keys.includes('parentSessionId')
    const wantsMetadata = keys === undefined || keys.includes('metadata')
    const wantsTitle = keys === undefined || keys.includes('title')
    for (const record of records) {
      const v = object(record)
      if (v.type === undefined && typeof v.agentType === 'string' && typeof v.toolUseId === 'string') {
        if (wantsMetadata && context.fileBacked && subagentMetadataPath(path) !== undefined)
          metadata = { ...metadata, subagent: v }
        continue
      }
      if (typeof v.cliSessionId === 'string') {
        const local = desktopDirectory(path)
        if (local !== undefined && v.sessionId === basename(local) && v.cliSessionId === basename(path).replace(/\.(?:jsonl|ndjson)$/, '')) {
          if (wantsTitle)
            Object.assign(facts, optional('title', string(v.title)))
          if (wantsMetadata)
            metadata = { ...metadata, desktop_session_id: v.sessionId }
        }
        continue
      }
      const workspace = wantsWorkspace
        ? {
            ...optional('path', string(v.cwd)),
            ...optional('branch', string(v.gitBranch)),
          }
        : undefined
      if (workspace !== undefined && Object.keys(workspace).length) {
        Object.assign(facts, {
          workspace: { ...facts.workspace, ...workspace },
        })
      }
      if (wantsCreated && facts.createdAt === undefined && timestamp(v.timestamp))
        Object.assign(facts, { createdAt: timestamp(v.timestamp) })
      const sessionId = string(v.sessionId)
      const parentSessionId = string(v.parentSessionId)
      // An explicit parentSessionId already describes an independently identified session.
      const agentId = parentSessionId === undefined && v.isSidechain === true ? string(v.agentId) : undefined
      const id = agentId ?? sessionId
      Object.assign(facts, {
        ...optional('id', id),
        ...optional('parentSessionId', wantsParent ? parentSessionId ?? (agentId === undefined ? undefined : sessionId) : undefined),
      })
      if (wantsMetadata && id !== undefined) {
        metadata = {
          ...metadata,
          id_origin: 'native',
          ...(agentId === undefined ? {} : { agentId, ...optional('sessionId', sessionId) }),
        }
      }
      if (wantsTitle && v.type === 'custom-title')
        Object.assign(facts, optional('title', string(v.customTitle)))
    }
    return { ...facts, ...optional('metadata', wantsMetadata ? metadata : undefined) }
  },
  parse(ingest, native) {
    const v = object(native)
    const type = string(v.type) ?? 'unknown'
    if (type === 'user' || type === 'assistant') {
      const m = object(v.message)
      if ('content' in m)
        messageEvents(ingest, type, m.content, string(m.model))
      if (type === 'assistant' && 'usage' in m) {
        ingest.emit('usage', { usage: m.usage }, undefined, ingest.usageContext
          ? () => ({ native_usage_context: {
              ...optional('model', string(m.model)),
              ...optional('message_id', string(m.id)),
              ...optional('request_id', string(v.requestId)),
            } })
          : undefined)
      }
    }
    else if ((type === 'tool_use' || type === 'tool_call') && typeof (v.name ?? v.tool) === 'string') {
      ingest.emit('tool_call', { ...optional('callId', string(v.id) ?? string(v.tool_use_id)), toolName: String(v.name ?? v.tool), arguments: v.input ?? v.arguments ?? null })
    }
    else if (type === 'tool_result') {
      ingest.emit('tool_result', { ...optional('callId', string(v.tool_use_id) ?? string(v.tool_call_id)), ...optional('toolName', string(v.name) ?? string(v.tool)), result: v.output ?? v.content ?? null, isError: v.is_error === true })
    }
    else if (v.type === undefined && typeof v.agentType === 'string' && typeof v.toolUseId === 'string') {
      ingest.emit('system', { sourceType: 'subagent_metadata', payload: native })
    }
    else if (typeof v.cliSessionId === 'string') {
      ingest.emit('system', { sourceType: 'desktop_metadata', payload: native })
    }
    else if (['system', 'summary', 'custom-title'].includes(type)) {
      ingest.emit('system', { sourceType: type, payload: native })
    }
    else if (type === 'permission_request') {
      ingest.emit('permission_request', {
        ...optional('requestId', string(v.id)),
        request: native,
      })
    }
    else {
      ingest.unknown(type, native)
    }
  },
})
export const claudeProvider = {
  ...claude,
  async* scan(options: ScanOptions = {}) {
    let roots: readonly string[] | undefined
    yield* scanSource('claude', { path: options.homeDir ?? homedir() }, options, async function* () {
      roots = await resolveClaudeRoots(options)
    })
    // A denied home listing cannot hide independently configured or conventional stores.
    roots ??= await resolveClaudeRoots(options, false)
    yield* claude.scan({ ...options, roots: { claude: roots } })
  },
}
