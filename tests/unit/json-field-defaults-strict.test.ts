// @ts-nocheck
import { executeOperation } from "../../nodes/Observability/operations";

/**
 * n8n stores `json` parameters as STRINGS. These hand-written handlers turned INVALID JSON into a
 * silent default (`[]` / `{}`) — worst case pushMetricsOTLP's resourceAttributes, which then shipped
 * the default `service.name` as if the user had set nothing. Invalid JSON now throws a
 * NodeOperationError naming the field and sends nothing; empty / whitespace still means "not set".
 */
function makeCtx(params: Record<string, unknown>): any {
  const request = jest.fn().mockResolvedValue({ statusCode: 204 });
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

async function expectRejects(ctx: any, resource: string, op: string, re: RegExp) {
  await expect(run(ctx, resource, op)).rejects.toThrow(re);
  await expect(run(ctx, resource, op)).rejects.toHaveProperty("constructor.name", "NodeOperationError");
  expect(ctx._request).not.toHaveBeenCalled();
}

describe("prometheus.pushMetricsOTLP: json fields are strictly parsed", () => {
  it("invalid resourceAttributes throws naming the field (no silent default service.name)", async () => {
    await expectRejects(makeCtx({ ...OTLP, resourceAttributes: "service.name=x" }), "prometheus", "pushMetricsOTLP", /"Resource Attributes" \(resourceAttributes\) is not valid JSON/);
  });
  it("valid resourceAttributes JSON string is sent", async () => {
    const ctx = makeCtx({ ...OTLP, resourceAttributes: '{"service.name":"svc"}' });
    await run(ctx, "prometheus", "pushMetricsOTLP");
    expect(ctx._request.mock.calls[0][0].body.resourceMetrics[0].resource.attributes).toEqual([{ key: "service.name", value: { stringValue: "svc" } }]);
  });
  it("whitespace resourceAttributes = not set (default service.name)", async () => {
    const ctx = makeCtx({ ...OTLP, resourceAttributes: "   " });
    await run(ctx, "prometheus", "pushMetricsOTLP");
    expect(ctx._request.mock.calls[0][0].body.resourceMetrics[0].resource.attributes).toEqual([{ key: "service.name", value: { stringValue: "n8n-workflow" } }]);
  });
  it("invalid metrics throws naming the field", async () => {
    await expectRejects(makeCtx({ ...OTLP, metrics: "{nope" }), "prometheus", "pushMetricsOTLP", /"Metrics" \(metrics\) is not valid JSON/);
  });
  it("invalid metrics.metricValues string throws naming the field", async () => {
    await expectRejects(makeCtx({ ...OTLP, metrics: { metricValues: "[{bad" } }), "prometheus", "pushMetricsOTLP", /metrics\.metricValues\) is not valid JSON/);
  });
  it("valid metricValues JSON string is sent", async () => {
    const ctx = makeCtx({ ...OTLP, metrics: { metricValues: '[{"name":"m","type":"gauge","value":2}]' } });
    await run(ctx, "prometheus", "pushMetricsOTLP");
    expect(ctx._request.mock.calls[0][0].body.resourceMetrics[0].scopeMetrics[0].metrics[0].name).toBe("m");
  });
  it("whitespace metricValues = not set (the existing non-empty error, not a JSON error)", async () => {
    await expect(run(makeCtx({ ...OTLP, metrics: { metricValues: "  " } }), "prometheus", "pushMetricsOTLP")).rejects.toThrow(/must be a non-empty array/);
  });
});

describe("loki.pushLogs: json fields are strictly parsed", () => {
  it("invalid entries JSON string throws naming the field", async () => {
    await expectRejects(makeCtx({ ...LOKI, entries: "[{oops" }), "loki", "pushLogs", /"Log Entries" \(entries\) is not valid JSON/);
  });
  it("invalid entries.entryValues string throws naming the field", async () => {
    await expectRejects(makeCtx({ ...LOKI, entries: { entryValues: "{oops" } }), "loki", "pushLogs", /entries\.entryValues\) is not valid JSON/);
  });
  it("whitespace entries = not set (the existing required-entry error)", async () => {
    await expect(run(makeCtx({ ...LOKI, entries: "  " }), "loki", "pushLogs")).rejects.toThrow(/At least one log entry is required/);
    await expect(run(makeCtx({ ...LOKI, entries: { entryValues: " " } }), "loki", "pushLogs")).rejects.toThrow(/At least one log entry is required/);
  });
  it("valid entries JSON string is sent", async () => {
    const ctx = makeCtx({ ...LOKI, entries: '[{"message":"hi"}]' });
    await run(ctx, "loki", "pushLogs");
    expect(JSON.parse(ctx._request.mock.calls[0][0].body.streams[0].values[0][1]).msg).toBe("hi");
  });
  it("invalid labels throws naming the field", async () => {
    await expectRejects(makeCtx({ ...LOKI, entries: ENTRY, labels: "app=x" }), "loki", "pushLogs", /"Labels" \(labels\) is not valid JSON/);
  });
  it("invalid entry additionalFields throws naming the field", async () => {
    await expectRejects(makeCtx({ ...LOKI, entries: { entryValues: [{ message: "hi", additionalFields: "{x" }] } }), "loki", "pushLogs", /\(additionalFields\) is not valid JSON/);
  });
  it("whitespace labels = not set", async () => {
    const ctx = makeCtx({ ...LOKI, entries: ENTRY, labels: "  " });
    await run(ctx, "loki", "pushLogs");
    expect(ctx._request.mock.calls[0][0].body.streams[0].stream).toEqual({});
  });
});

describe("loki.pushAAEventLog: json fields are strictly parsed", () => {
  it("invalid eventData throws naming the field", async () => {
    await expectRejects(makeCtx({ ...LOKI, eventType: "e", eventData: "{x" }), "loki", "pushAAEventLog", /"Event Data" \(eventData\) is not valid JSON/);
  });
  it("invalid additionalLabels throws naming the field", async () => {
    await expectRejects(makeCtx({ ...LOKI, eventType: "e", additionalLabels: "a=b" }), "loki", "pushAAEventLog", /"Additional Labels" \(additionalLabels\) is not valid JSON/);
  });
  it("valid eventData string reaches the log line", async () => {
    const ctx = makeCtx({ ...LOKI, eventType: "e", eventData: '{"card_type":"bug"}' });
    await run(ctx, "loki", "pushAAEventLog");
    expect(ctx._request.mock.calls[0][0].body.streams[0].stream.card_type).toBe("bug");
  });
});
