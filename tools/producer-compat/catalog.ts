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

async function main(): Promise<void> {
  const mode = process.argv[2]
  if (mode === 'matrix') {
    const value = JSON.stringify(activeProviders)
    if (process.env.GITHUB_OUTPUT !== undefined)
      await appendFile(process.env.GITHUB_OUTPUT, `providers=${value}\n`)
    else console.log(value)
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
