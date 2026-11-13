/**
 * Unit tests for OBSERVABILITY_API_URL resolution + validateProductionConfig.
 *
 * Locks in:
 *   1. No hardcoded service URL when neither env nor credential is set.
 *   2. validateProductionConfig() throws iff NODE_ENV === "production" and OBSERVABILITY_API_URL is unset.
 *   3. validateProductionConfig() is a no-op in dev / test.
 *
 * The generated `validateProductionConfig` signature takes a ProcessEnv
 * (not a baseUrl string) — it reads OBSERVABILITY_API_URL off the env
 * object so callers can inject test envs without mutating process.env.
 */
import { validateProductionConfig } from "../credentials/ObservabilityApi.credentials";

describe("validateProductionConfig", () => {
  it("throws in production when OBSERVABILITY_API_URL is unset", () => {
    expect(() =>
      validateProductionConfig({ NODE_ENV: "production", OBSERVABILITY_API_URL: "" }),
    ).toThrow(/Missing required env var.*OBSERVABILITY_API_URL/);
  });

  it("does not throw in production when OBSERVABILITY_API_URL is set", () => {
    expect(() =>
      validateProductionConfig({
        NODE_ENV: "production",
        OBSERVABILITY_API_URL: "http://obs.example:9090",
      }),
    ).not.toThrow();
  });

  it("does not throw in non-production environments even with unset OBSERVABILITY_API_URL", () => {
    expect(() =>
      validateProductionConfig({ NODE_ENV: "test", OBSERVABILITY_API_URL: "" }),
    ).not.toThrow();
    expect(() =>
      validateProductionConfig({ NODE_ENV: "development", OBSERVABILITY_API_URL: "" }),
    ).not.toThrow();
  });
});

describe("OBSERVABILITY_API_URL resolution", () => {
  it("resolves to empty string when env var is unset (no hardcoded fallback)", () => {
    // The module-level constant is evaluated at import time; re-require with
    // a cleared env to verify there's no fallback baked into the literal.
    jest.resetModules();
    const original = process.env.OBSERVABILITY_API_URL;
    delete process.env.OBSERVABILITY_API_URL;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("../credentials/ObservabilityApi.credentials");
      expect(mod.OBSERVABILITY_API_URL).toBe("");
    } finally {
      if (original !== undefined) process.env.OBSERVABILITY_API_URL = original;
    }
  });

  it("honours OBSERVABILITY_API_URL env var when set", () => {
    jest.resetModules();
    process.env.OBSERVABILITY_API_URL = "http://obs.from-env:9090";
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../credentials/ObservabilityApi.credentials");
    expect(mod.OBSERVABILITY_API_URL).toBe("http://obs.from-env:9090");
  });
});
