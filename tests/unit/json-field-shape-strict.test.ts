// @ts-nocheck
import { executeOperation } from "../../nodes/Observability/operations";

/**
 * VALID JSON of the wrong SHAPE used to be swallowed: an object-typed json field given `[]`, `5`,
 * `"x"` or `null` silently became `{}` (pushMetricsOTLP then shipped the default service.name), and
 * an array-typed one given an object/scalar silently became `[]` or was sent as-is (grafana tags).
 * Each now throws a NodeOperationError naming the field and sends nothing.
 */
function makeCtx(params: Record<string, unknown>): any {
  const request = jest.fn().mockResolvedValue({ statusCode: 204, ok: true });
  return {
    _request: request,
    helpers: { request, httpRequest: request },
    getNode: jest.fn(() => ({ name: "n", type: "n", typeVersion: 1, position: [0, 0], parameters: {} })),
    getNodeParameter: (n: string, _i: number, d?: unknown) => (n in params ? params[n] : d),
    getInputData: jest.fn(() => [{ json: {} }]),
    getCredentials: jest.fn(async () => ({ apiToken: "t", baseUrl: "http://svc.test" })),
    continueOnFail: jest.fn(() => false),
  };
}
const run = (ctx: any, resource: string, op: string) => executeOperation(ctx, "http://svc.test", {}, resource, op, 0);
const LOKI = { lokiUrl: "http://loki.test" };
const ENTRY = { entryValues: [{ message: "hi", level: "info" }] };
const OTLP = { otlpEndpoint: "http://otlp.test", metrics: { metricValues: [{ name: "m", type: "gauge", value: 1 }] } };

async function expectShape(params: Record<string, unknown>, resource: string, op: string, re: RegExp) {
  const ctx = makeCtx(params);
  await expect(run(ctx, resource, op)).rejects.toThrow(re);
  await expect(run(ctx, resource, op)).rejects.toHaveProperty("constructor.name", "NodeOperationError");
  expect(ctx._request).not.toHaveBeenCalled();
}

const ARR = /must be a JSON array/;

describe("object-typed json fields reject valid non-object JSON", () => {
  for (const bad of ["[]", "5", '"x"', "true", "null"]) {
    it(`resourceAttributes=${bad} throws (no default service.name)`, async () => {
      await expectShape({ ...OTLP, resourceAttributes: bad }, "prometheus", "pushMetricsOTLP", /"Resource Attributes" \(resourceAttributes\) must be a JSON object, got /);
    });
  }
  it("resourceAttributes as a literal array throws", async () => {
    await expectShape({ ...OTLP, resourceAttributes: ["service.name"] }, "prometheus", "pushMetricsOTLP", /\(resourceAttributes\) must be a JSON object, got an array/);
  });
  it("metrics='[1]' throws naming metrics", async () => {
    await expectShape({ ...OTLP, metrics: "[1]" }, "prometheus", "pushMetricsOTLP", /"Metrics" \(metrics\) must be a JSON object, got an array/);
  });
  it("labels='[\"a\"]' throws naming labels", async () => {
    await expectShape({ ...LOKI, entries: ENTRY, labels: '["a"]' }, "loki", "pushLogs", /"Labels" \(labels\) must be a JSON object/);
  });
  it("entry additionalFields='5' throws naming the field", async () => {
    await expectShape({ ...LOKI, entries: { entryValues: [{ message: "hi", additionalFields: "5" }] } }, "loki", "pushLogs", /\(additionalFields\) must be a JSON object, got a number/);
  });
  it("eventData='[]' throws naming eventData", async () => {
    await expectShape({ ...LOKI, eventType: "e", eventData: "[]" }, "loki", "pushAAEventLog", /"Event Data" \(eventData\) must be a JSON object, got an array/);
  });
  it("additionalLabels='true' throws naming additionalLabels", async () => {
    await expectShape({ ...LOKI, eventType: "e", additionalLabels: "true" }, "loki", "pushAAEventLog", /"Additional Labels" \(additionalLabels\) must be a JSON object, got a boolean/);
  });
  it("unset (not given / literal null, not the text \"null\") still means {} — default service.name", async () => {
    for (const params of [{ ...OTLP }, { ...OTLP, resourceAttributes: null }]) {
      const ctx = makeCtx(params);
      await run(ctx, "prometheus", "pushMetricsOTLP");
      expect(ctx._request.mock.calls[0][0].body.resourceMetrics[0].resource.attributes).toEqual([{ key: "service.name", value: { stringValue: "n8n-workflow" } }]);
    }
  });
  it("whitespace = not set for the array-typed grafana tags (no tags key)", async () => {
    const ctx = makeCtx({ text: "deploy", tags: "  " });
    await run(ctx, "grafana", "grafanaCreateAnnotation");
    expect("tags" in ctx._request.mock.calls[0][0].body).toBe(false);
  });
});

describe("array-typed json fields reject valid non-array JSON", () => {
  it("metrics.metricValues='{\"a\":1}' throws naming the field", async () => {
    await expectShape({ ...OTLP, metrics: { metricValues: '{"a":1}' } }, "prometheus", "pushMetricsOTLP", /\(metrics\.metricValues\) must be a JSON array, got an object/);
  });
  it("entries='5' throws naming entries", async () => {
    await expectShape({ ...LOKI, entries: "5" }, "loki", "pushLogs", /"Log Entries" \(entries\) must be a JSON array/);
  });
  it("entries.entryValues='{\"a\":1}' throws naming the field", async () => {
    await expectShape({ ...LOKI, entries: { entryValues: '{"a":1}' } }, "loki", "pushLogs", /\(entries\.entryValues\) must be a JSON array, got an object/);
  });
  for (const bad of ['"a"', '{"a":1}', "7"]) {
    it(`grafana tags=${bad} throws naming tags`, async () => {
      await expectShape({ text: "deploy", tags: bad }, "grafana", "grafanaCreateAnnotation", /"Tags" \(tags\) must be a JSON array, got /);
    });
  }
  it("grafana tags as a literal object throws", async () => {
    await expectShape({ text: "deploy", tags: { a: 1 } }, "grafana", "grafanaCreateAnnotation", ARR);
  });
  it("grafana tags literal array still reaches the body", async () => {
    const ctx = makeCtx({ text: "deploy", tags: ["a"] });
    await run(ctx, "grafana", "grafanaCreateAnnotation");
    expect(ctx._request.mock.calls[0][0].body.tags).toEqual(["a"]);
  });
});
