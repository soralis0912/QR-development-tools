import { defineConfig } from 'vitest/config';

// Relative base so the build works on any GitHub Pages project path.
export default defineConfig({
  base: './',
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
