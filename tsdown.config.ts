import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'observe/index': 'src/observe/index.ts',
    'testing/index': 'src/testing/index.ts',
    'providers/claude/index': 'src/providers/claude/index.ts',
    'providers/codex/index': 'src/providers/codex/index.ts',
    'providers/cursor/index': 'src/providers/cursor/index.ts',
    'providers/opencode/index': 'src/providers/opencode/index.ts',
    'providers/pi/index': 'src/providers/pi/index.ts',
  },
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  target: 'node22.18',
  dts: true,
  clean: true,
  deps: { onlyBundle: [], onlyImport: ['fzstd', 'xxhashjs'] },
})
