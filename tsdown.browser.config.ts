import { defineConfig } from 'tsdown'

/**
 * The portable build: the same parser graph with browser platform arms, bundled with the pure-JS
 * implementations it needs so a browser consumer installs no polyfill or Node shim.
 * It owns its own output directory and is built by `pnpm build` after the Node build.
 */
export default defineConfig({
  entry: { index: 'src/browser/index.ts' },
  format: 'esm',
  fixedExtension: false,
  platform: 'browser',
  target: 'es2022',
  dts: true,
  clean: true,
  outDir: 'dist/browser',
  deps: {
    onlyBundle: ['buffer', 'base64-js', 'ieee754', '@noble/hashes'],
    onlyImport: ['fzstd', 'xxhashjs', '@bufbuild/protobuf', 'picomatch'],
  },
})
