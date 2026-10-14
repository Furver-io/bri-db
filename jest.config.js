/**
 * @file Jest runner configuration for BRI — Node ESM, coverage collection globs,
 *       and integration test discovery under tests/.
 */
export default {
  testEnvironment: 'node',
  transform: {},
  moduleFileExtensions: ['js'],
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: [
    'client/**/*.js',
    'engine/**/*.js',
    'storage/**/*.js',
    'utils/**/*.js',
    // Remote access control: pure modules the end-to-end server stories rely on.
    'remote/auth-protocol.js',
    'docker/server/security.js',
    '!**/test.js',
    '!**/*.test.js'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'html'],
  verbose: true,
  testTimeout: 30000
};
