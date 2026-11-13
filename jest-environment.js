/**
 * Custom Jest Environment
 *
 * Disables localStorage to prevent SecurityError from n8n-workflow
 */

const NodeEnvironment = require('jest-environment-node').TestEnvironment;

class CustomEnvironment extends NodeEnvironment {
  constructor(config, context) {
    super(config, context);

    // Prevent localStorage access
    this.global.localStorage = undefined;
  }

  async setup() {
    await super.setup();
  }

  async teardown() {
    await super.teardown();
  }
}

module.exports = CustomEnvironment;
