import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, isAbsolute, join } from 'node:path'
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
const desktopPath = pathMatcher('**/local_*/.claude/projects/**/*.jsonl')
const insideRoot = pathMatcher('**')
const claude = jsonlProvider({
  id: 'claude',
  roots: resolveClaudeRoots,
  accepts(path, candidate) {
    if (!path.endsWith('.jsonl'))
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
  metadata(records) {
    const facts: Partial<Session> = {}
    let metadata: Record<string, unknown> = {}
    for (const record of records) {
      const v = object(record)
      const workspace = {
        ...optional('path', string(v.cwd)),
        ...optional('branch', string(v.gitBranch)),
      }
      if (Object.keys(workspace).length) {
        Object.assign(facts, {
          workspace: { ...facts.workspace, ...workspace },
        })
      }
      if (facts.createdAt === undefined && timestamp(v.timestamp))
        Object.assign(facts, { createdAt: timestamp(v.timestamp) })
      Object.assign(facts, {
        ...optional('id', string(v.sessionId)),
        ...optional('parentSessionId', string(v.parentSessionId)),
      })
      if (typeof v.sessionId === 'string')
        metadata = { ...metadata, id_origin: 'native' }
      if (v.type === 'custom-title')
        Object.assign(facts, optional('title', string(v.customTitle)))
    }
    return { ...facts, metadata }
  },
  parse(ingest, native) {
    const v = object(native)
    const type = string(v.type) ?? 'unknown'
    if (type === 'user' || type === 'assistant') {
      const m = object(v.message)
      if ('content' in m)
        messageEvents(ingest, type, m.content, string(m.model))
      if (type === 'assistant' && 'usage' in m)
        ingest.emit('usage', { usage: m.usage })
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
