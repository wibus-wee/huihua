import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { auditNativeStore } from './native.ts'
import type { CompatibilityProgress } from './report.ts'
import { chatExchange, exchange, json, required, startSimulator } from './runtime.ts'

async function main(): Promise<void> {
  const provider = required('COMPAT_PROVIDER')
  assert(['pi', 'qwen', 'copilot', 'opencode', 'cline', 'deepseek', 'openclaw', 'fx', 'grok', 'droid', 'hermes'].includes(provider), 'unsupported live producer')
  const port = Number(process.env.SIMULATOR_PORT ?? 18889)
  assert(Number.isSafeInteger(port) && port > 1024 && port < 65535)
  const root = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), `huihua-live-${provider}-`))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  await mkdir(home)
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), ANTHROPIC_API_KEY: 'synthetic-test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, PI_OFFLINE: '1', NO_COLOR: '1' }
  const base = `http://127.0.0.1:${port}`
  const control = `http://127.0.0.1:${port + 1}/_simulator`
  const bin = resolve(required('PRODUCER_BIN'))
  let args: string[] = []
  if (provider === 'pi') {
    const config = join(home, '.pi/agent')
    await mkdir(config, { recursive: true })
    await writeFile(join(config, 'models.json'), JSON.stringify({ providers: { synthetic: { baseUrl: base, api: 'anthropic-messages', apiKey: 'synthetic-test-key', models: [{ id: 'claude-sonnet-4-5', contextWindow: 200000, maxTokens: 1024 }] } } }))
    args = ['--print', '--mode', 'json', '--provider', 'synthetic', '--model', 'claude-sonnet-4-5', '--offline', '--no-tools', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files']
  }
  if (provider === 'qwen') {
    const config = join(home, '.qwen')
    await mkdir(config)
    await writeFile(join(config, 'settings.json'), JSON.stringify({ $version: 4, modelProviders: { anthropic: [{ id: 'claude-sonnet-4-5', envKey: 'ANTHROPIC_API_KEY', baseUrl: base }] }, telemetry: { enabled: false }, general: { enableAutoUpdate: false } }))
    args = ['--bare', '--auth-type', 'anthropic', '--model', 'claude-sonnet-4-5', '--output-format', 'json', '--chat-recording', '--telemetry=false', '--approval-mode', 'plan']
  }
  if (provider === 'copilot') {
    Object.assign(env, { COPILOT_PROVIDER_TYPE: 'anthropic', COPILOT_PROVIDER_BASE_URL: base, COPILOT_PROVIDER_API_KEY: 'synthetic-test-key', COPILOT_MODEL: 'claude-sonnet-4-5', COPILOT_OFFLINE: 'true' })
    args = ['--disable-builtin-mcps', '--output-format', 'json']
  }
  if (provider === 'opencode') {
    const config = join(home, '.config/opencode')
    await mkdir(config, { recursive: true })
    await writeFile(join(config, 'opencode.json'), JSON.stringify({ model: 'anthropic/claude-sonnet-4-5', small_model: 'anthropic/claude-sonnet-4-5', provider: { anthropic: { options: { baseURL: `${base}/v1`, apiKey: 'synthetic-test-key' } } }, permission: { '*': 'deny' }, share: 'disabled', autoupdate: false }))
    Object.assign(env, { OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_LSP_DOWNLOAD: 'true' })
    args = ['run', '--pure', '--format', 'json', '--title', 'Synthetic Huihua compatibility']
  }
  if (provider === 'cline') {
    const config = join(home, '.cline/data/settings')
    await mkdir(config, { recursive: true })
    await writeFile(join(config, 'providers.json'), JSON.stringify({ version: 1, lastUsedProvider: 'anthropic', modes: {}, providers: { anthropic: { settings: { provider: 'anthropic', model: 'claude-sonnet-4-5', protocol: 'anthropic', client: 'anthropic', baseUrl: `${base}/v1`, apiKey: 'synthetic-test-key', maxTokens: 1024, contextWindow: 200000 }, updatedAt: new Date().toISOString(), tokenSource: 'manual' } } }))
    args = ['--json', '--provider', 'anthropic', '--model', 'claude-sonnet-4-5', '--auto-approve', 'false', '--retries', '1', '--timeout', '45']
  }
  if (provider === 'deepseek') {
    env.DSH_HOME = join(home, '.dsh')
    await mkdir(env.DSH_HOME)
    const patch = join(root, 'synthetic.yml')
    await writeFile(patch, `- id: agent-default-model\n  config:\n    provider: synthetic\n    model: claude-sonnet-4-5\n- id: llm-pi-ai\n  config:\n    providers:\n      synthetic:\n        api: anthropic-messages\n        baseURL: ${base}\n        apiKeyEnv: ANTHROPIC_API_KEY\n        models:\n          - id: claude-sonnet-4-5\n- id: session-title-llm\n  disabled: true\n`)
    args = ['--profile', 'headless', '--patch', patch, '--json']
  }
  if (provider === 'openclaw') {
    const config = join(home, '.openclaw')
    await mkdir(config)
    await writeFile(join(config, 'openclaw.json'), JSON.stringify({ agents: { defaults: { workspace, skipBootstrap: true, model: { primary: 'synthetic/claude-sonnet-4-5' } } }, models: { mode: 'replace', providers: { synthetic: { baseUrl: base, api: 'anthropic-messages', apiKey: 'synthetic-test-key', models: [{ id: 'claude-sonnet-4-5', name: 'Synthetic', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }, tools: { profile: 'minimal' } }))
    args = ['agent', '--local', '--agent', 'main', '--session-id', '11111111-2222-4333-8444-555555555555', '--json', '--timeout', '45']
  }
  if (provider === 'fx') {
    const config = join(home, '.fx')
    await mkdir(config)
    await writeFile(join(config, 'settings.json'), JSON.stringify({ provider: 'synthetic', providers: { synthetic: { protocol: 'openai-chat-completions', base_url: `${base}/v1`, auth: { type: 'bearer', env: 'SYNTHETIC_API_KEY' }, model_metadata: { 'gpt-test': { context_window: 200000, max_output_tokens: 1024, supports_tool_use: true } } } }, models: { synthetic: 'gpt-test' }, permission_mode: 'ask' }))
    Object.assign(env, { SYNTHETIC_API_KEY: 'synthetic-test-key', FX_PROVIDER: 'synthetic', FX_MODEL: 'gpt-test' })
    args = ['ask', '--json', '--no-color']
  }
  if (provider === 'grok') {
    const config = join(home, '.grok')
    await mkdir(config)
    await writeFile(join(config, 'config.toml'), `[cli]
auto_update = false
[telemetry]
otel_enabled = false
trace_upload = false
[model.synthetic]
model = "gpt-test"
api_backend = "chat_completions"
base_url = "${base}/v1"
env_key = "SYNTHETIC_API_KEY"
context_window = 200000
max_completion_tokens = 1024
max_retries = 0
supports_backend_search = false
`)
    Object.assign(env, { SYNTHETIC_API_KEY: 'synthetic-test-key', GROK_DISABLE_AUTOUPDATER: '1', GROK_XAI_API_BASE_URL: `${base}/v1`, GROK_MODELS_BASE_URL: `${base}/v1`, XAI_API_KEY: 'synthetic-test-key' })
    args = ['--model', 'synthetic', '--output-format', 'json', '--disable-web-search', '--max-turns', '1']
  }
  if (provider === 'droid') {
    const config = join(home, '.factory')
    await mkdir(config)
    await writeFile(join(config, 'settings.json'), JSON.stringify({ customModels: [{ model: 'gpt-test', displayName: 'Synthetic', baseUrl: `${base}/v1`, apiKey: 'synthetic-test-key', provider: 'generic-chat-completion-api', maxOutputTokens: 1024 }] }))
    env.FACTORY_HOME = config
    args = ['exec', '--output-format', 'json', '--model', 'custom:Synthetic-0', '--disable-builtin-skills']
  }
  if (provider === 'hermes') {
    Object.assign(env, { HERMES_HOME: join(home, '.hermes'), CUSTOM_BASE_URL: `${base}/v1`, CUSTOM_API_KEY: 'synthetic-test-key', OPENAI_BASE_URL: `${base}/v1`, OPENAI_API_KEY: 'synthetic-test-key' })
    args = ['--safe-mode', '--provider', 'custom', '--model', 'gpt-test']
  }
  const simulator = startSimulator(resolve(required('SIMULATOR_DIR')), port)
  const output = resolve(process.env.COMPAT_REPORT ?? `${provider}-compat-report.json`)
  const progress: CompatibilityProgress = { stage: 'simulator-startup', completed: [] }
  let resumeId: string | undefined
  try {
    await simulator.ready()
    const template = await json(`${base}/v1/messages`, { model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'synthetic template' }] })
    await json(`${control}/reset`, {})
    // Cline --id explicitly discards the prompt and forces interactive mode in 3.0.70.
    // Certify first-turn storage, and expose the missing resume journey in the manifest.
    const turns = provider === 'cline' ? ['FIRST'] : ['FIRST', 'RESUME']
    for (const [index, label] of turns.entries()) {
      progress.stage = index ? 'producer-resume' : 'producer'
      const prompt = `${provider === 'cline' ? 'Reply to ' : ''}HUIHUA_${provider.toUpperCase()}_${label}`
      const reply = `HUIHUA_${provider.toUpperCase()}_${index ? 'RESUMED' : 'REPLY'}`
      const response = exchange(label, prompt, { type: 'text', text: reply, citations: null }, 'end_turn', template)
      if (['copilot', 'openclaw'].includes(provider))
        standardAnthropic(response)
      const chat = ['fx', 'grok', 'droid', 'hermes'].includes(provider)
      await json(`${control}/enqueue`, { provider: chat ? 'openai' : 'anthropic', exchanges: [chat ? chatExchange(label, prompt, reply) : response] })
      const continuation = !index || provider === 'openclaw' ? [] : ['deepseek', 'droid'].includes(provider) ? ['--session-id', resumeId!] : provider === 'fx' ? ['--resume', 'last'] : ['--continue']
      const promptArgs = ['qwen', 'copilot'].includes(provider) ? ['--prompt', prompt] : provider === 'openclaw' ? ['--message', prompt] : provider === 'grok' ? ['-p', prompt] : provider === 'hermes' ? ['-z', prompt] : [prompt]
      const stdout = await run(bin, [...args, ...continuation, ...promptArgs], env, workspace, join(root, label))
      assert(stdout.includes(reply), 'native producer did not return the scenario reply')
      if (!index && provider === 'droid') {
        const result = JSON.parse(stdout) as { session_id?: string }
        assert.equal(typeof result.session_id, 'string')
        resumeId = result.session_id
      }
      if (!index && provider === 'deepseek') {
        const session = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as {
          type?: string
          sessionId?: string
        }).find(row => row.type === 'session')
        assert(session?.sessionId !== undefined && session.sessionId !== '', 'DeepSeek did not disclose the native session ID')
        resumeId = session.sessionId
      }
    }
    await writeFile(join(root, 'ledger.json'), JSON.stringify(await json(`${control}/requests`), null, 2))
    await auditNativeStore(provider, home, root, progress)
    progress.completed.push('scenario')
    progress.stage = 'passed'
  }
  catch (error) {
    progress.error = String(error)
    process.exitCode = 1
  }
  finally {
    await simulator.stop(join(root, 'simulator.log'))
    await writeFile(output, JSON.stringify({ ...progress, artifacts: root }, null, 2))
    await writeFile(`${output}.progress.json`, JSON.stringify(progress, null, 2))
    console.log(JSON.stringify({ ...progress, artifacts: root }))
  }
}
function standardAnthropic(response: ReturnType<typeof exchange>): void {
  // The template is the beta profile;
  // These clients deliberately use standard Messages.
  for (const step of response.response.steps) {
    const event = 'event' in step ? step.event as Record<string, unknown> : undefined
    if (event?.type === 'message_start') {
      const message = event.message as Record<string, unknown>
      delete message.context_management
      const usage = message.usage as Record<string, unknown>
      for (const key of ['fallback_credit', 'iterations', 'speed'])
        delete usage[key]
    }
    if (event?.type === 'message_delta') {
      delete event.context_management
      const usage = event.usage as Record<string, unknown>
      for (const key of ['fallback_credit', 'iterations'])
        delete usage[key]
    }
  }
}
async function run(binary: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (data) => {
      stdout += String(data)
    })
    child.stderr.on('data', (data) => {
      stderr += String(data)
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 90000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      void Promise.all([writeFile(`${path}.stdout`, stdout), writeFile(`${path}.stderr`, stderr)]).then(() => {
        if (code === 0 && !timedOut)
          resolve(stdout)
        else
          reject(new Error(timedOut ? 'Producer timed out' : `Producer exited ${code}: ${stderr.slice(-2000)}`))
      }, reject)
    })
  })
}
if (import.meta.main)
  await main()
