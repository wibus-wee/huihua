import { acpProvider } from './providers/acp/index.ts'
import { antigravityProvider } from './providers/antigravity/index.ts'
import { claudeProvider } from './providers/claude/index.ts'
import { clineProvider } from './providers/cline/index.ts'
import { codexProvider } from './providers/codex/index.ts'
import { copilotProvider } from './providers/copilot/index.ts'
import { cursorProvider } from './providers/cursor/index.ts'
import { deepseekProvider } from './providers/deepseek/index.ts'
import { devinProvider } from './providers/devin/index.ts'
import { droidProvider } from './providers/droid/index.ts'
import { fxProvider } from './providers/fx/index.ts'
import { grokProvider } from './providers/grok/index.ts'
import { hermesProvider } from './providers/hermes/index.ts'
import { kimiProvider } from './providers/kimi/index.ts'
import { morphProvider } from './providers/morph/index.ts'
import { oarProvider } from './providers/oar/index.ts'
import { openclawProvider } from './providers/openclaw/index.ts'
import { opencodeProvider } from './providers/opencode/index.ts'
import { piProvider } from './providers/pi/index.ts'
import { qwenProvider } from './providers/qwen/index.ts'
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
  millisOf,
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
  acpProvider,
  antigravityProvider,
  grokProvider,
  kimiProvider,
  oarProvider,
  morphProvider,
  copilotProvider,
  openclawProvider,
  qwenProvider,
  droidProvider,
  deepseekProvider,
  clineProvider,
  fxProvider,
  devinProvider,
  hermesProvider,
])
export const AgentSession = sessions
