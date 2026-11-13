/**
 * Jest Setup File
 *
 * Configures the test environment before running tests
 */

// Prevent localStorage initialization by n8n-workflow
Object.defineProperty(global, 'localStorage', {
  value: undefined,
  writable: false,
  configurable: false,
});

// Mock fetch for RetryingRequest
global.fetch = jest.fn();
