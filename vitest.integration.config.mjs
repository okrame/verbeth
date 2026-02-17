export default {
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 120000,
    pool: 'threads',
    poolOptions: { threads: { singleThread: true, minThreads: 1, maxThreads: 1, isolate: true } },
    fileParallelism: false,
    isolate: true,
    include: ['tests/handshaking.test.ts', 'tests/e2e.test.ts', 'tests/scan-engine.test.ts', '*.test.ts'],
    exclude: ['**/node_modules/**', 'packages/**']
  },
  define: {
    global: 'globalThis',
  }
};