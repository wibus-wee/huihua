import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, relative, resolve } from 'node:path'

import ts from 'typescript'
import { parseAllDocuments } from 'yaml'

const runtimeDependencies = new Set(['fzstd', 'xxhashjs', '@bufbuild/protobuf', 'picomatch']) // Dependency decisions: docs/architecture.md.
const developmentDependencies = new Set([
  'typescript',
  '@types/node',
  '@types/xxhashjs',
  '@types/picomatch',
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
  const producerHarness = await readFile('tools/producer-compat.ts', 'utf8')
  assert(producerHarness.includes('from \'../src/index.ts\''))
  assert(producerHarness.includes('homeDir: home'))
  assert(producerHarness.includes('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: \'1\''))
  const producerWorkflow = await readFile('.github/workflows/producer-compat.yml', 'utf8')
  assert(producerWorkflow.includes('5bdf08c6d0c48c1b9a12a287ff9d135844e07d52'))
  assert(producerWorkflow.includes('contents: read'))

  const workspacePackages = parseAllDocuments(await readFile('pnpm-workspace.yaml', 'utf8'))[0]!.toJS() as { packages: string[] }
  assert.deepEqual(workspacePackages.packages, ['packages/*'], 'the standalone usage CLI is the only workspace package')
  const usagePackage = JSON.parse(await readFile('packages/usage/package.json', 'utf8')) as {
    name: string
    dependencies: Record<string, string>
    scripts: Record<string, string>
    bin: Record<string, string>
  }
  assert.equal(usagePackage.name, '@huihua/usage')
  assert.deepEqual(usagePackage.dependencies, { huihua: 'workspace:*' }, 'usage CLI must consume only Huihua public package API')
  assert.deepEqual(usagePackage.bin, { 'huihua-usage': './dist/cli.js' })
  assert.equal(usagePackage.scripts.build, 'pnpm --filter huihua build && tsdown')
  assert.equal(usagePackage.scripts.start, 'node dist/cli.js')
  assert.equal(usagePackage.scripts.check, 'node dist/cli.js --help')
  const usageBuildSource = await readFile('packages/usage/tsdown.config.ts', 'utf8')
  assert.match(usageBuildSource, /onlyImport: \['huihua', \/\^huihua\\\//, 'the CLI must externalize Huihua public contracts and providers')
  const builtCli = (await Promise.all((await readdir('packages/usage/dist')).filter(path => path.endsWith('.js')).map(async path => readFile(`packages/usage/dist/${path}`, 'utf8')))).join('\n')
  assert.match(builtCli, /from "huihua\/registry"/)
  assert.doesNotMatch(builtCli, /class Ingestion|function jsonLinesFrom|function jsonlProvider/, 'provider readers must not be bundled into the consumer')
  assert.equal(usagePackage.scripts.bench, 'node --experimental-strip-types tools/bench.ts')
  const usageBenchmarkSource = await readFile('packages/usage/tools/bench.ts', 'utf8')
  assert.match(usageBenchmarkSource, /from 'huihua'/)
  assert.doesNotMatch(usageBenchmarkSource, /from ['"].*src\/(?:providers|shared|registry)/, 'bench workers must read sessions through public contracts')
  const usageCliSource = await readFile('packages/usage/src/cli.ts', 'utf8')
  const usageReportSource = await readFile('packages/usage/src/report.ts', 'utf8')
  assert.match(usageCliSource, /from 'huihua'/)
  assert.match(usageCliSource, /from 'huihua\/registry'/, 'selected-provider startup must use the public independent registry')
  const packageExports = (JSON.parse(await readFile('package.json', 'utf8')) as { exports: Record<string, unknown> }).exports
  assert.deepEqual(packageExports['./registry'], { types: './dist/registry.d.ts', import: './dist/registry.js' })
  assert.match(await readFile('tsdown.config.ts', 'utf8'), /'registry': 'src\/registry\.ts'/, 'the independent entry must build the existing registry, not a parallel implementation')
  const providerPaths = Object.keys(packageExports).filter(path => path.startsWith('./providers/')).map(path => `huihua/${path.slice(2)}`).sort()
  const cliProviderPaths = Array.from(usageCliSource.matchAll(/import\('(huihua\/providers\/[^']+)'\)/g), match => match[1]!).sort()
  assert.deepEqual(cliProviderPaths, providerPaths, 'CLI loader inventory must match public provider exports')
  assert.match(usageCliSource, /builder\.end\(ref\)/, 'completed sources must release native records before reading the next session')
  assert.match(usageCliSource, /metadataKeys: \['parentSessionId'\]/, 'usage selection must retain late parent lineage')
  assert.match(usageCliSource, /await open\.consume\(selection, frame => builder\.add\(ref, frame\)\)/, 'callback consumption must use the public frame consumer')
  assert.match(usageCliSource, /await open\.consumeUsage\(frame => builder\.add\(ref, frame\)\)/, 'evidence-free usage must use the optional public capability')
  assert.match(usageCliSource, /await open\.consumeUsageFacts\(item => builder\.addFact\(ref, item\)/, 'direct facts must use the public provider capability and the same report builder')
  assert.match(usageCliSource, /Promise\.allSettled/, 'concurrent reads must await all started siblings before failing')
  assert.match(usageCliSource, /open\.readMode === 'buffered'/, 'buffered providers must not enter the incremental read pool')
  assert.match(usageCliSource, /args\.since !== undefined && args\.since === args\.until/, 'automatic date pushdown is restricted to the measured single-day query')
  assert.match(usageCliSource, /execution\.concurrency \?\? 1/, 'unproven concurrency must remain opt-in')
  assert.match(usageCliSource, /batchDecode: execution\.batchDecode === true/, 'unproven batch decoding must remain opt-in')
  assert.match(usageCliSource, /execution\.workers \?\? args\.workers/, 'private experiments must preserve the explicit user worker option')
  const usageOptionsSource = await readFile('packages/usage/src/options.ts', 'utf8')
  assert.match(usageOptionsSource, /workers: 1/, 'CPU worker memory costs require serial defaults')
  assert.match(usageOptionsSource, /\['1', '2', '4'\]\.includes\(value\)/, 'worker counts must stay bounded')
  assert.match(usageCliSource, /new Worker\(new URL\('\.\/worker\.js', import\.meta\.url\)/, 'worker entry must be emitted by the same consumer build')
  assert.match(usageCliSource, /sibling\.postMessage\('abort'\)/, 'worker failure must cancel siblings')
  assert.match(usageCliSource, /if \(failures\.length !== 0\)/, 'usage must reject incomplete scan coverage before printing totals')
  assert.match(usageCliSource, /worker\.terminate\(\)/, 'all worker lifetimes must finish before returning')
  assert.match(usageBuildSource, /worker: 'src\/worker\.ts'/)
  const usageWorkerSource = await readFile('packages/usage/src/worker.ts', 'utf8')
  assert.match(usageWorkerSource, /from 'huihua'/)
  assert.doesNotMatch(usageWorkerSource, /src\/providers|src\/shared|JSON\.parse|readFile|createReadStream/)
  assert.match(usageWorkerSource, /parentPort\.postMessage\(builder\.partition\(\)\)/, 'workers must transport compact accumulator state, not records/events')
  assert.match(usageReportSource, /schema: 'usage-partition\/v1'/)
  assert.match(usageReportSource, /partition\.identities/, 'cross-worker identities must reach the original report builder')
  assert.match(usageReportSource, /event\.providerMetadata\.native_usage_context/, 'recordless usage must use provider-owned same-record facts')
  assert.match(usageReportSource, /from 'huihua'/)
  assert.doesNotMatch(`${usageCliSource}\n${usageReportSource}`, /src\/providers|src\/shared|src\/registry/)
  assert.match(usageReportSource, /schema: 'huihua-usage\/v2'/, 'the CLI owns a versioned daily/model report, independent of agent-session/v1')
  assert.match(usageReportSource, /readonly daily:/)
  assert.match(usageReportSource, /readonly modelBreakdowns:/)
  assert.doesNotMatch(usageReportSource, /JSON\.parse|readFile|createReadStream|fetch\s*\(/, 'report projection must consume public frames, not decode stores or fetch pricing')
  const sessionContract = ts.createSourceFile('session.ts', await readFile('src/contracts/session.ts', 'utf8'), ts.ScriptTarget.Latest, true)
  const opened = sessionContract.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'OpenSession')
  assert.ok(opened && ts.isInterfaceDeclaration(opened))
  const selective = opened.members.find(node => ts.isPropertySignature(node) && node.name.getText(sessionContract) === 'select')
  assert.ok(selective && ts.isPropertySignature(selective) && selective.questionToken, 'optimized frame selection must remain an optional public capability for third-party adapters')
  const consume = opened.members.find(node => ts.isPropertySignature(node) && node.name.getText(sessionContract) === 'consume')
  assert.ok(consume && ts.isPropertySignature(consume) && consume.questionToken, 'callback consumption must remain optional for third-party providers')
  const consumeUsage = opened.members.find(node => ts.isPropertySignature(node) && node.name.getText(sessionContract) === 'consumeUsage')
  assert.ok(consumeUsage && ts.isPropertySignature(consumeUsage) && consumeUsage.questionToken, 'usage delivery must remain an optional provider capability')
  const consumeUsageFacts = opened.members.find(node => ts.isPropertySignature(node) && node.name.getText(sessionContract) === 'consumeUsageFacts')
  assert.ok(consumeUsageFacts && ts.isPropertySignature(consumeUsageFacts) && consumeUsageFacts.questionToken, 'direct facts must remain optional for existing adapters')
  const ingestion = await readFile('src/shared/ingestion.ts', 'utf8')
  assert.match(ingestion, /adapter\.usageContext === true/, 'only format owners may advertise sufficient native usage context')
  assert.match(ingestion, /Pick<RawRecord, 'sequence' \| 'provider' \| 'native' \| 'source'>/, 'the internal cursor must not retain native text/byte evidence when records are omitted')
  assert.match(ingestion, /this\.#factOptions\?\.acceptTimestamp/, 'date pushdown must belong to synchronous consumer policy inside the existing mapper')
  assert.match(ingestion, /adapter\.metadata\(\[line\.native\], ref\.source\.path, \{ fileBacked: companions \}, metadataKeys\)/, 'demand must reach the same provider mapper, not another parser')
  assert.match(ingestion, /wantsUpdatedAt \|\| wantsMetadata/, 'unselected update-time metadata must not be constructed')
  const jsonl = await readFile('src/shared/jsonl.ts', 'utf8')
  assert.match(jsonl, /chunk\.length <= 262144/, 'batch UTF-8 must remain bounded to the current chunk')
  assert.match(jsonl, /line\(recordBytes, position\+\+, decoded\)/, 'batched decoding must reuse the native per-record parser/evidence path')
  for (const path of await sourceFiles('src/providers')) {
    const source = await readFile(path, 'utf8')
    if (/usageContext: true/.test(source)) {
      assert.ok(['/claude/index.ts', '/codex/index.ts'].some(suffix => path.endsWith(suffix)), 'new usage context capabilities need provider-specific evidence and equivalence tests')
      assert.match(source, /native_usage_context/)
    }
  }
  const selection = sessionContract.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'FrameSelection')
  assert.ok(selection && ts.isInterfaceDeclaration(selection))
  const metadataKeys = selection.members.find(node => ts.isPropertySignature(node) && node.name.getText(sessionContract) === 'metadataKeys')
  assert.ok(metadataKeys && ts.isPropertySignature(metadataKeys) && metadataKeys.questionToken, 'metadata delivery keys must remain optional')
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
      dependencies?: Record<string, { specifier: string, version?: string }>
      devDependencies?: Record<string, { specifier: string, version?: string }>
    }>
    packages: Record<string, { resolution: { integrity?: string, tarball?: string } }>
  }
  // pnpm 12 stores its package-manager graph and project graph as separate YAML documents.
  const documents = parseAllDocuments(await readFile('pnpm-lock.yaml', 'utf8'))
  if (documents.length === 0)
    throw new Error('missing pnpm lockfile graph')
  let projectGraphFound = false
  let usageImporterFound = false
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
    const usageImporter = lock.importers['packages/usage']
    if (usageImporter?.dependencies?.huihua?.specifier === 'workspace:*'
      && usageImporter.dependencies.huihua.version === 'link:../..') {
      if (usageImporterFound)
        throw new Error('duplicate usage CLI workspace importer')
      usageImporterFound = true
    }
  }
  if (!projectGraphFound)
    throw new Error('missing pnpm project graph')
  if (!usageImporterFound)
    throw new Error('missing pinned pnpm importer for the usage CLI workspace package')
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
