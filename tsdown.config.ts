import { defineConfig } from 'tsdown'

// The runner executes the single bundled dist/index.js committed in the repository, so every
// runtime dependency is bundled in (node: builtins stay external via platform: 'node').
export default defineConfig({
  entry: 'src/index.ts',
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  dts: false,
  deps: {
    alwaysBundle: (id) => !id.startsWith('node:'),
    onlyBundle: false,
  },
})
