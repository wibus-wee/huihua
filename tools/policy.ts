import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, relative, resolve } from 'node:path'

import ts from 'typescript'
import { parseAllDocuments } from 'yaml'

const runtimeDependencies = new Set(['fzstd', 'xxhashjs', '@bufbuild/protobuf']) // Dependency decisions: docs/architecture.md.
const developmentDependencies = new Set([
  'typescript',
  '@types/node',
  '@types/xxhashjs',
  'eslint',
  'eslint-config-hyoban',
  'knip',
  'tsdown',
  'yaml',
])
const permittedLicenses = new Set([
  'MIT',
  'Apache-2.0',
  'ISC',
  'BSD-3-Clause',
  'BSD-2-Clause',
  '(Apache-2.0 AND BSD-3-Clause)',
])
const developmentLicenses = new Set([
  ...permittedLicenses,
  '(MIT OR Apache-2.0)',
  'CC0-1.0',
  '0BSD',
  'BlueOak-1.0.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
])
async function sourceFiles(root = 'src'): Promise<string[]> {
  const output: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name)
    if (entry.isDirectory())
      output.push(...(await sourceFiles(path)))
    else if (path.endsWith('.ts'))
      output.push(path)
  }
  return output
}
export async function policy(): Promise<void> {
  const releaseDocuments = parseAllDocuments(await readFile('.github/workflows/release.yml', 'utf8'))
  assert.equal(releaseDocuments.length, 1)
  assert.equal(releaseDocuments[0]!.errors.length, 0)
  const release = releaseDocuments[0]!.toJS() as {
    on: unknown
    permissions: unknown
    jobs: { publish: { 'if': string, 'runs-on': string, 'permissions': unknown, 'environment'?: unknown } }
  }
  assert.deepEqual(release.on, { push: { tags: ['v*'] } }, 'only version tags may trigger publishing')
  assert.deepEqual(release.permissions, { contents: 'read' })
  assert.equal(release.jobs.publish.if, 'github.repository == \'wibus-wee/huihua\'')
  assert.equal(release.jobs.publish['runs-on'], 'ubuntu-latest')
  assert.deepEqual(release.jobs.publish.permissions, { 'contents': 'read', 'id-token': 'write' })
  assert.equal(release.jobs.publish.environment, undefined, 'npm Trusted Publisher environment is blank')
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
  }
  for (const name of Object.keys(pkg.dependencies)) {
    if (!runtimeDependencies.has(name)) {
      throw new Error(
        `new runtime dependency requires design/policy review: ${name}`,
      )
    }
  }
  for (const name of Object.keys(pkg.devDependencies)) {
    if (!developmentDependencies.has(name)) {
      throw new Error(
        `new development dependency requires design/policy review: ${name}`,
      )
    }
  }
  interface Lock {
    lockfileVersion: string
    importers: Record<string, {
      dependencies?: Record<string, { specifier: string }>
      devDependencies?: Record<string, { specifier: string }>
    }>
    packages: Record<string, { resolution: { integrity?: string, tarball?: string } }>
  }
  // pnpm 12 stores its package-manager graph and project graph as separate YAML documents.
  const documents = parseAllDocuments(await readFile('pnpm-lock.yaml', 'utf8'))
  if (documents.length === 0)
    throw new Error('missing pnpm lockfile graph')
  let projectGraphFound = false
  for (const document of documents) {
    if (document.errors.length)
      throw new Error(`invalid pnpm lockfile: ${document.errors[0]!.message}`)
    const lock = document.toJS() as Lock
    if (lock.lockfileVersion !== '9.0')
      throw new Error(`unreviewed pnpm lockfile version: ${lock.lockfileVersion}`)
    for (const [name, entry] of Object.entries(lock.packages)) {
      if (
        !/^(?:@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(name)
        || entry.resolution.integrity === undefined || entry.resolution.integrity === ''
        || (entry.resolution.tarball !== undefined && !entry.resolution.tarball.startsWith('https://registry.npmjs.org/'))
      ) {
        throw new Error(`unreviewed dependency source: ${name}`)
      }
    }
    const importer = lock.importers['.']
    if (importer?.dependencies) {
      if (projectGraphFound)
        throw new Error('duplicate pnpm project graph')
      projectGraphFound = true
      for (const field of ['dependencies', 'devDependencies'] as const) {
        const entries = importer[field] ?? {}
        if (Object.keys(entries).length !== Object.keys(pkg[field]).length)
          throw new Error(`stale pnpm lockfile: ${field}`)
        for (const [name, version] of Object.entries(pkg[field])) {
          if (entries[name]?.specifier !== version)
            throw new Error(`stale pnpm lockfile: ${name}`)
        }
      }
    }
  }
  if (!projectGraphFound)
    throw new Error('missing pnpm project graph')
  const config = parseAllDocuments(await readFile('pnpm-workspace.yaml', 'utf8'))[0]!.toJS() as {
    registry: string
    allowBuilds: Record<string, boolean>
  }
  if (config.registry !== 'https://registry.npmjs.org/' || Object.keys(config.allowBuilds).length)
    throw new Error('registry or dependency build approval needs policy review')

  interface LicenseEntry { name: string, versions: string[], paths: string[], license: string }
  const licenses = (prod: boolean): LicenseEntry[] => Object.values(JSON.parse(execFileSync(
    'pnpm',
    ['licenses', 'list', ...(prod ? ['--prod'] : []), '--json'],
    { encoding: 'utf8' },
  )) as Record<string, LicenseEntry[]>).flat()
  const production = licenses(true)
  for (const entry of production) {
    if (new Set(entry.versions).size !== 1)
      throw new Error(`duplicate production dependency versions: ${entry.name}`)
    if (!permittedLicenses.has(entry.license))
      throw new Error(`unreviewed production license: ${entry.name} (${entry.license})`)
  }
  // pnpm owns graph traversal and legacy license metadata; inspect installed manifests for scripts.
  for (const entry of licenses(false)) {
    if (!developmentLicenses.has(entry.license))
      throw new Error(`unreviewed license: ${entry.name} (${entry.license})`)
    for (const path of entry.paths) {
      const installed = JSON.parse(await readFile(resolve(path, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>
      }
      if (['preinstall', 'install', 'postinstall'].some(name => installed.scripts?.[name] !== undefined))
        throw new Error(`unreviewed dependency lifecycle: ${entry.name}`)
    }
  }
  const builtins = new Set(
    builtinModules.flatMap(name => [name, `node:${name}`]),
  )
  const allowedNode = new Set([
    'node:buffer',
    'node:crypto',
    'node:process',
    'node:fs',
    'node:fs/promises',
    'node:os',
    'node:path',
  ])
  for (const file of await sourceFiles()) {
    const name = relative(resolve('src'), file).replaceAll('\\', '/')
    const text = await readFile(file, 'utf8')
    if (/@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable/.test(text))
      throw new Error(`suppression bypass: ${name}`)
    if (
      name.startsWith('shared/')
      && /["'](?:claude|codex|cursor|opencode|pi|oar|acp|kimi|grok|antigravity|morph|copilot|openclaw|qwen|droid|deepseek|cline|fx|devin|hermes)["']/i.test(text)
    ) {
      throw new Error(`provider identity in shared: ${name}`)
    }
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const fileOpens = new Set<string>()
    const importSource = (specifier: string): void => {
      if (!specifier.startsWith('.')) {
        if (builtins.has(specifier)) {
          if (
            !allowedNode.has(specifier)
            || name.startsWith('contracts/')
            || name.startsWith('observe/')
            || name === 'registry.ts'
          ) {
            throw new Error(
              `forbidden platform import: ${name} -> ${specifier}`,
            )
          }
        }
        else {
          if (!runtimeDependencies.has(specifier) && specifier !== '@bufbuild/protobuf/wire') {
            throw new Error(
              `unreviewed dependency import ${name} -> ${specifier}`,
            )
          }
        }
        return
      }
      const target = relative(
        resolve('src'),
        resolve(dirname(file), specifier),
      ).replaceAll('\\', '/')
      if (target.startsWith('../'))
        throw new Error(`source escapes production root: ${name}`)
      if (name.startsWith('contracts/') && !target.startsWith('contracts/'))
        throw new Error(`contracts dependency direction: ${name}`)
      if (name.startsWith('shared/') && !/^(?:contracts|shared)\//.test(target))
        throw new Error(`shared dependency direction: ${name}`)
      if (name.startsWith('observe/') && !target.startsWith('contracts/'))
        throw new Error(`projection dependency direction: ${name}`)
      if (name === 'registry.ts' && !target.startsWith('contracts/'))
        throw new Error(`registry depends on implementation: ${target}`)
      if (
        target.startsWith('providers/')
        && name !== 'index.ts'
        && !name.startsWith(`providers/${target.split('/')[1]}/`)
      ) {
        throw new Error(
          `provider coupling/composition root: ${name} -> ${target}`,
        )
      }
    }
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
          importSource(node.moduleSpecifier.text)
      }
      if (
        ts.isCallExpression(node)
        && node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        const arg = node.arguments[0]
        if (!arg || !ts.isStringLiteral(arg))
          throw new Error(`nonliteral dynamic import: ${name}`)
        importSource(arg.text)
      }
      if (ts.isCallExpression(node)) {
        const call = node.expression.getText(ast)
        if (
          /^(?:fetch|eval|Function|require)$/.test(call)
          || /\.(?:write|writeFile|appendFile|unlink|rename|mkdir|rm|truncate|createWriteStream)$/.test(
            call,
          )
        ) {
          throw new Error(
            `side effect outside read-only data scope: ${name}: ${call}`,
          )
        }
      }
      if (
        ts.isImportDeclaration(node)
        && ts.isStringLiteral(node.moduleSpecifier)
        && ['node:fs/promises', 'node:fs'].includes(node.moduleSpecifier.text)
      ) {
        const bindings = node.importClause?.namedBindings
        if (!bindings || !ts.isNamedImports(bindings))
          throw new Error(`filesystem namespace bypass: ${name}`)
        for (const element of bindings.elements) {
          if (node.importClause?.isTypeOnly || element.isTypeOnly)
            continue
          const importedName = element.propertyName?.text ?? element.name.text
          if (importedName === 'open')
            fileOpens.add(element.name.text)
          if (
            !new Set(
              node.moduleSpecifier.text === 'node:fs'
                ? ['createReadStream']
                : ['open', 'stat', 'readdir', 'realpath'],
            ).has(element.propertyName?.text ?? element.name.text)
          ) {
            throw new Error(`filesystem write-capable import: ${name}`)
          }
        }
      }
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && fileOpens.has(node.expression.text)
      ) {
        const mode = node.arguments[1]
        if (!mode || !ts.isStringLiteral(mode) || mode.text !== 'r')
          throw new Error(`file open must be explicitly read-only: ${name}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
}
