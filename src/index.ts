import { claudeProvider } from './providers/claude/index.ts'
import { codexProvider } from './providers/codex/index.ts'
import { cursorProvider } from './providers/cursor/index.ts'
import { opencodeProvider } from './providers/opencode/index.ts'
import { piProvider } from './providers/pi/index.ts'
import { createSessionRegistry } from './registry.ts'

export type * from './contracts/diagnostic.ts'
export { SessionError } from './contracts/diagnostic.ts'
export type * from './contracts/event.ts'
export type * from './contracts/provider.ts'
export { defineProvider } from './contracts/provider.ts'
export type * from './contracts/session.ts'
export { SESSION_SCHEMA } from './contracts/session.ts'
export type * from './contracts/source.ts'
export {
  conversationOf,
  eventsOf,
  fileChangesOf,
  subagentsOf,
  toolCallsOf,
  toolResultsOf,
} from './observe/index.ts'
export { createSessionRegistry, SessionRegistry } from './registry.ts'
export { jsonOf } from './shared/value.ts'
/** The only builtin composition root. Provider subpaths and custom registries stay independent. */
export const sessions = createSessionRegistry([
  claudeProvider,
  codexProvider,
  cursorProvider,
  opencodeProvider,
  piProvider,
])
export const AgentSession = sessions
