export default {
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    // Use threads instead of forks for better isolation
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false,
        isolate: true,
      }
    },
    // Ensure files run sequentially, not in parallel
    fileParallelism: false,
    // Run each test file in isolation
    isolate: true,
    include: ['tests/handshaking.test.ts', 'tests/messaging.test.ts', 'tests/e2e.test.ts', '*.test.ts'],
    exclude: ['**/node_modules/**', 'packages/**']
  },
  define: {
    global: 'globalThis',
  }
};