export default {
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true
      }
    },
    fileParallelism: false,
    include: ['tests/handshaking.test.ts', 'tests/messaging.test.ts', 'tests/e2e.test.ts', '*.test.ts'],
    exclude: ['**/node_modules/**', 'packages/**']
  },
  define: {
    global: 'globalThis',
  }
};