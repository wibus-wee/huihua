import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { cli: 'src/cli.ts', worker: 'src/worker.ts' },
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  target: 'node22.18',
  dts: false,
  clean: true,
  deps: { onlyBundle: [], onlyImport: ['huihua', /^huihua\//] },
})
