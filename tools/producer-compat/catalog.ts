import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'

import manifest from './manifest.json' with { type: 'json' }

export { manifest }
export const activeProviders = manifest.providers.filter(provider => provider.ci)
export function providerManifest(id: string) {
  const result = manifest.providers.find(provider => provider.id === id)
  assert(result, `Provider missing from compatibility manifest: ${id}`)
  return result
}

export interface ProviderSelection {
  providers: string[]
  scopeLabels: string[]
  reasons: string[]
  unavailable: string[]
  full: boolean
}

/** Path scopes select lanes. Manual labels may only add coverage, never remove it. */
export function selectProviders(paths: readonly string[], labels: readonly string[] = [], full = false): ProviderSelection {
  const selected = new Set<string>()
  const scopeLabels = new Set<string>()
  const reasons = new Set<string>()
  let all = full
  if (full)
    reasons.add('Scheduled/manual run: full native-provider matrix')
  const quality = manifest.selection.qualityOnly
  for (const path of paths) {
    if (quality.files.includes(path) || quality.prefixes.some(prefix => path.startsWith(prefix)) || quality.suffixes.some(suffix => path.endsWith(suffix))) {
      scopeLabels.add(path.startsWith('packages/usage/') ? 'scope:usage' : 'scope:docs-or-quality')
      reasons.add(`${path}: regular quality checks only`)
      continue
    }
    const matches = manifest.providers.filter(provider => provider.paths.files.includes(path) || provider.paths.prefixes.some(prefix => path.startsWith(prefix)))
    if (matches.length) {
      for (const provider of matches) {
        selected.add(provider.id)
        scopeLabels.add(provider.scopeLabel)
        reasons.add(`${path}: ${provider.id}`)
      }
    }
    else {
      all = true
      scopeLabels.add('scope:shared-or-unknown')
      reasons.add(`${path}: shared infrastructure or unclassified change; run all`)
    }
  }
  for (const label of labels) {
    if (label === manifest.selection.manualAllLabel) {
      all = true
      reasons.add(`${label}: explicitly expand to all native providers`)
    }
    else if (label.startsWith(manifest.selection.manualProviderPrefix)) {
      const id = label.slice(manifest.selection.manualProviderPrefix.length)
      if (manifest.providers.some(provider => provider.id === id)) {
        selected.add(id)
        scopeLabels.add(providerManifest(id).scopeLabel)
        reasons.add(`${label}: explicitly add ${id}`)
      }
      else {
        all = true
        reasons.add(`${label}: unknown provider override; conservatively run all`)
      }
    }
  }
  if (all)
    activeProviders.forEach(provider => selected.add(provider.id))
  if (!selected.size)
    reasons.add('No native-reader impact; keep normal quality checks, skip real CLI installation')
  return {
    providers: activeProviders.filter(provider => selected.has(provider.id)).map(provider => provider.id),
    scopeLabels: [...scopeLabels].sort(),
    reasons: [...reasons],
    unavailable: manifest.providers.filter(provider => selected.has(provider.id) && !provider.ci).map(provider => provider.id),
    full: all,
  }
}

async function matrixSelection(): Promise<ProviderSelection> {
  const eventName = process.env.GITHUB_EVENT_NAME
  if (eventName !== 'pull_request' && eventName !== 'push')
    return selectProviders([], [], true)
  try {
    assert(process.env.GITHUB_EVENT_PATH !== undefined)
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')) as {
      before?: string
      after?: string
      pull_request?: { number: number, base: { sha: string }, head: { sha: string }, labels: { name: string }[] }
    }
    const pr = event.pull_request
    const base = pr?.base.sha ?? event.before
    const head = pr?.head.sha ?? event.after
    assert(base !== undefined && head !== undefined && /^[a-f\d]{40}$/.test(base) && /^[a-f\d]{40}$/.test(head) && !/^0+$/.test(base), 'No reliable comparison base')
    // --no-renames keeps both the deleted source path and added destination path.
    const paths = execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', pr ? `${base}...${head}` : `${base}..${head}`], { encoding: 'utf8' }).split('\0').filter(Boolean)
    let labels = pr?.labels.map(label => label.name) ?? []
    if (pr !== undefined && process.env.GITHUB_TOKEN !== undefined) {
      const repository = process.env.GITHUB_REPOSITORY ?? ''
      assert(/^[\w.-]+\/[\w.-]+$/.test(repository))
      assert(Number.isSafeInteger(pr.number) && pr.number > 0)
      const response = await fetch(`https://api.github.com/repos/${repository}/pulls/${pr.number}`, { headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) })
      assert(response.ok, `Cannot refresh manual CI labels: ${response.status}`)
      const current = await response.json() as { labels: { name: string }[] }
      assert(Array.isArray(current.labels) && current.labels.every(label => typeof label.name === 'string'))
      labels = current.labels.map(label => label.name)
    }
    return selectProviders(paths, labels)
  }
  catch (error) {
    const selected = selectProviders([], [], true)
    selected.reasons.unshift(`Change detection unavailable: ${String(error)}. Fail open to full coverage, never skip.`)
    return selected
  }
}

function selectionSummary(selection: ProviderSelection): string {
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('`', '').replace(/[\r\n]+/g, ' ')
  return [
    '## Native provider check selection',
    '',
    `Selected ${selection.providers.length}/${activeProviders.length} runnable providers: ${selection.providers.join(', ') || 'none'}.`,
    `Scope labels: ${selection.scopeLabels.map(escape).join(', ') || 'full scheduled/manual coverage'}.`,
    ...(selection.unavailable.length ? [`Not certified despite affected scope: ${selection.unavailable.join(', ')}. See manifest blockers; skipping these does not establish compatibility.`] : []),
    '',
    '<details><summary>Why these checks run</summary>',
    '',
    ...selection.reasons.slice(0, 100).map(reason => `- ${escape(reason)}`),
    ...(selection.reasons.length > 100 ? [`- ${selection.reasons.length - 100} additional reasons omitted from this summary.`] : []),
    '',
    '</details>',
    '',
    'Paths are authoritative. Manual ci:all / ci:provider:ID labels only expand coverage and are read again on PR rerun or push. Adding a label alone does not launch another run. Scope labels here are classifications, not automatically written PR labels.',
    '',
  ].join('\n')
}

async function main(): Promise<void> {
  const mode = process.argv[2]
  if (mode === 'matrix') {
    const selection = await matrixSelection()
    const value = JSON.stringify(activeProviders.filter(provider => selection.providers.includes(provider.id)))
    if (process.env.GITHUB_OUTPUT !== undefined) {
      await appendFile(process.env.GITHUB_OUTPUT, `providers=${value}\nhas_providers=${selection.providers.length > 0}\n`)
    }
    else {
      console.log(value)
    }
    if (process.env.GITHUB_STEP_SUMMARY !== undefined)
      await appendFile(process.env.GITHUB_STEP_SUMMARY, selectionSummary(selection))
    return
  }
  assert.equal(mode, 'install')
  const provider = providerManifest(process.env.COMPAT_PROVIDER ?? '')
  assert(provider.ci && provider.install)
  const install = provider.install
  const prefix = resolve(process.env.PRODUCER_PREFIX ?? join(process.env.RUNNER_TEMP ?? '/tmp', 'producers'))
  await mkdir(prefix, { recursive: true })
  let version = install.version
  const latest = process.env.COMPAT_LANE === 'latest'
  if (latest) {
    if (install.kind === 'python-source') {
      version = execFileSync('git', ['ls-remote', install.source, 'HEAD'], { encoding: 'utf8' }).split(/\s/)[0]!
    }
    else if (['npm', 'npm-sdk'].includes(install.kind)) {
      version = execFileSync('npm', ['view', install.package!, 'version'], { encoding: 'utf8' }).trim()
    }
    else {
      assert(install.latest !== undefined)
      const result = await fetch(install.latest)
      assert(result.ok, `Release lookup failed: ${result.status}`)
      version = (await result.text()).trim().replace(/^v/, '')
    }
  }
  assert(/^[a-z\d][\w.+-]*$/i.test(version), 'invalid release version')
  let binary: string
  let url: string | undefined
  if (install.kind === 'python-source') {
    assert(/^[a-f\d]{40}$/.test(version), 'Python source must resolve to a commit')
    const source = join(prefix, 'source')
    execFileSync('git', ['clone', '--filter=blob:none', install.source, source], { stdio: 'inherit' })
    execFileSync('git', ['-C', source, 'checkout', '--detach', version], { stdio: 'inherit' })
    execFileSync('python3', ['-m', 'pip', 'install', '--user', `uv==${install.uv}`], { stdio: 'inherit' })
    execFileSync('python3', ['-m', 'uv', 'sync', '--frozen', '--python', install.python!, '--no-dev'], { cwd: source, stdio: 'inherit' })
    binary = join(source, '.venv/bin', install.binary)
  }
  else if (['npm', 'npm-sdk'].includes(install.kind)) {
    assert(install.package !== undefined)
    execFileSync('npm', ['install', '--prefix', prefix, '--no-save', `${install.package}@${version}`], { stdio: 'inherit' })
    binary = install.kind === 'npm-sdk' ? join(prefix, 'node_modules', install.package, install.binary) : join(prefix, 'node_modules/.bin', install.binary)
  }
  else {
    assert(install.url !== undefined)
    url = install.url.replace('{version}', version)
    const archive = join(prefix, provider.id === 'fx' ? 'producer.tar.gz' : install.binary)
    execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', url, '--output', archive], { stdio: 'inherit' })
    if (provider.id === 'fx')
      execFileSync('tar', ['-xzf', archive, '-C', prefix], { stdio: 'inherit' })
    binary = join(prefix, install.binary)
    execFileSync('chmod', ['+x', binary])
    if (!latest)
      assert.equal(sha256(await readFile(binary)), install.binarySha256, 'pinned native binary hash changed')
  }
  const reported = install.kind === 'npm-sdk'
    ? (JSON.parse(await readFile(join(prefix, 'node_modules', install.package!, 'package.json'), 'utf8')) as { version: string }).version
    : install.kind === 'python-source'
      ? execFileSync('git', ['-C', join(prefix, 'source'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
      : execFileSync(binary, ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: join(prefix, 'version-home'), PI_OFFLINE: '1' } }).trim()
  assert(reported.includes(version), `producer reports ${reported};
expected ${version}`)
  const provenance = { provider: provider.id, requestedVersion: install.version, lane: process.env.COMPAT_LANE, resolvedVersion: version, reportedVersion: reported, source: install.source, ...(url !== undefined ? { url } : { package: install.package }), executableSha256: sha256(await readFile(binary)), manifestSha256: sha256(await readFile(new URL('./manifest.json', import.meta.url))), simulator: manifest.simulator }
  await writeFile(join(prefix, 'install-manifest.json'), JSON.stringify(provenance, null, 2))
  if (process.env.GITHUB_ENV !== undefined)
    await appendFile(process.env.GITHUB_ENV, `PRODUCER_BIN=${binary}\nCOMPAT_CLI_VERSION=${version}\nCOMPAT_INSTALL_MANIFEST=${join(prefix, 'install-manifest.json')}\n`)
  console.log(JSON.stringify(provenance))
}
function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
if (import.meta.main)
  await main()
