import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/runner.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: false,
  clean: true,
  minify: false,
  splitting: false,
});