/**
 * Unit Tests for Observability Node (post-orval-pipeline regen)
 *
 * The legacy hand-tuned node + actions/* modules were replaced by a generated
 * dispatcher that lives in nodes/Observability/operations/index.ts and is
 * driven by prefixed op names ("prometheusGetAlerts", "lokiQueryLogs",
 * "grafanaSearchDashboards", ...). The dispatcher calls the n8n built-in
 * helper `ctx.helpers.request()` directly (no axios, no separate client
 * module).
 *
 * These tests verify the post-regen contract:
 *   - Node description shape (displayName, name, version, credentials, ...)
 *   - Resource + operation selector exposure
 *   - execute() routing via the dispatcher (each resource × representative op)
 *   - Auth header injection (Authorization Bearer + X-Tenant-ID)
 *   - Error mapping (401/403/429 → NodeApiError via LicenseAuthenticator)
 *   - Unknown resource / unknown operation paths
 *   - continueOnFail behavior
 *   - Multi-item batch processing
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { IExecuteFunctions, NodeApiError, NodeOperationError } from 'n8n-workflow';
import { Observability } from '../Observability.node';
import { ObservabilityApi } from '../../../credentials/ObservabilityApi.credentials';
import { lokiOperationFlags } from '../resources/loki.resource';

interface MockExecuteFunctionsBuilderOptions {
  inputItems?: Array<{ json: Record<string, unknown> }>;
  credentials?: Record<string, unknown>;
  paramValues?: Array<unknown>;
  paramByName?: Record<string, unknown>;
  continueOnFail?: boolean;
}

function buildMockExecuteFunctions(opts: MockExecuteFunctionsBuilderOptions = {}) {
  const inputItems = opts.inputItems ?? [{ json: {} }];
  // ⚠️ THREE DISTINCT HOSTS, DELIBERATELY.
  //
  // This used to be a single `baseUrl: 'http://obs.test:9090'`, and the assertions
  // below expected Loki at `http://obs.test:9090/loki/...` and Grafana at
  // `http://obs.test:9090/api/...`. That was not a simplification — it was this
  // suite PINNING THE DEFECT AS THE SPECIFICATION. In the live cluster that one URL
  // is Prometheus, so those expectations encoded "send every Loki and Grafana
  // request to Prometheus" and went green for as long as the node did exactly that.
  //
  // Distinct hosts make a misaddressed request impossible to miss, here and in
  // `description-handler-reconciliation.test.ts`, which asserts the same property
  // across every operation.
  const credentials = opts.credentials ?? {
    baseUrl: 'http://obs.test:9090',
    prometheusUrl: 'http://obs.test:9090',
    lokiUrl: 'http://obs-loki.test:3100',
    grafanaUrl: 'http://obs-graf.test:3000',
    apiToken: 'test-api-token',
    tenantId: 'tenant-uuid-1234',
  };
  const requestMock = jest.fn();
  const queue = [...(opts.paramValues ?? [])];
  const byName = opts.paramByName ?? {};

  const ctx = {
    getInputData: jest.fn().mockReturnValue(inputItems),
    getNodeParameter: jest.fn(
      (name: string, _itemIndex?: number, defaultValue?: unknown) => {
        if (Object.prototype.hasOwnProperty.call(byName, name)) {
          return byName[name];
        }
        if (queue.length > 0) {
          return queue.shift();
        }
        return defaultValue;
      },
    ),
    getCredentials: jest.fn().mockResolvedValue(credentials),
    getNode: jest.fn().mockReturnValue({
      id: 'test-node',
      name: 'Test Node',
      type: 'n8n-nodes-base.observability',
      typeVersion: 2,
      position: [0, 0],
      parameters: {},
    }),
    continueOnFail: jest.fn().mockReturnValue(opts.continueOnFail ?? false),
    helpers: {
      request: requestMock,
    },
  } as unknown as jest.Mocked<IExecuteFunctions>;

  return { ctx, requestMock };
}

describe('Observability Node', () => {
  let observabilityNode: Observability;

  beforeEach(() => {
    observabilityNode = new Observability();
    jest.clearAllMocks();
  });

  describe('Node Description', () => {
    it('should have correct basic properties', () => {
      expect(observabilityNode.description.displayName).toBe('Observability Node APIs');
      expect(observabilityNode.description.name).toBe('observability');
      expect(observabilityNode.description.version).toEqual([1, 2]);
      expect(observabilityNode.description.description).toContain('Prometheus');
      expect(observabilityNode.description.description).toContain('Loki');
      expect(observabilityNode.description.description).toContain('Grafana');
    });

    it('should have correct node configuration', () => {
      expect(observabilityNode.description.group).toContain('transform');
      expect(observabilityNode.description.inputs).toEqual(['main']);
      expect(observabilityNode.description.outputs).toEqual(['main']);
    });

    it('should declare observabilityApi credentials (optional — pushgateway resource skips them)', () => {
      // `testedBy` is load-bearing: without it n8n has no test function for this
      // credential at all, because a function-valued ICredentialType.test is never
      // called (see the methods test below).
      expect(observabilityNode.description.credentials).toEqual([
        { name: 'observabilityApi', required: false, testedBy: 'observabilityApiTest' },
      ]);
    });

    it('exposes the credential test on the NODE, where n8n actually invokes it', async () => {
      // n8n resolves a credential test as: the credential's declarative `test`,
      // else `testedBy` → node.methods.credentialTest[<name>]. The credential-level
      // function this module used to ship was never invoked, so the UI test could
      // not pass. Pin BOTH halves of the wiring.
      const methods = (observabilityNode as any).methods;
      const fn = methods?.credentialTest?.observabilityApiTest;
      expect(typeof fn).toBe('function');

      // A node-level test receives the WRAPPER ({id, name, type, data}), not the
      // payload — reading credential.apiToken directly would be undefined.
      const requested: string[] = [];
      const ctx = {
        helpers: {
          request: async (opts: any) => {
            requested.push(opts.url);
            return { ok: true };
          },
        },
      };
      const result = await fn.call(ctx, {
        id: '1', name: 'obs', type: 'observabilityApi',
        data: { apiToken: 'j', prometheusUrl: 'http://prom:9090', lokiUrl: 'http://loki:3100' },
      });
      expect(result).toEqual({ status: 'OK', message: 'Reachable: prometheus, loki' });
      expect(requested).toEqual(['http://prom:9090/-/healthy', 'http://loki:3100/ready']);
    });

    it('the credential itself declares no function-valued test (n8n ignores it)', () => {
      const cred = new ObservabilityApi();
      expect(cred.test).toBeUndefined();
    });

    it('should have icon configured', () => {
      expect(observabilityNode.description.icon).toBe('file:observability.svg');
    });

    it('should have subtitle showing resource and operation', () => {
      expect(observabilityNode.description.subtitle).toBe(
        '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
      );
    });

    it('should have default name', () => {
      expect(observabilityNode.description.defaults).toEqual({
        name: 'Observability Node APIs',
      });
    });
  });

  describe('Resource Selector', () => {
    it('should have resource parameter defined', () => {
      const resourceParam = observabilityNode.description.properties.find(
        (p) => p.name === 'resource',
      );

      expect(resourceParam).toBeDefined();
      expect(resourceParam?.type).toBe('options');
      expect(resourceParam?.displayName).toBe('Resource');
      expect(resourceParam?.default).toBe('prometheus');
      // noDataExpression dropped so the AA DOING dispatcher can drive a dynamic
      // (expression) resource — n8n would otherwise return the raw ={{…}} string.
      expect(resourceParam?.noDataExpression).toBeUndefined();
    });

    it('should have all five resource options', () => {
      const resourceParam = observabilityNode.description.properties.find(
        (p) => p.name === 'resource',
      );
      const options = (resourceParam as any).options;

      expect(options).toHaveLength(5);

      const optionValues = options.map((o: any) => o.value);
      expect(optionValues).toContain('prometheus');
      expect(optionValues).toContain('loki');
      expect(optionValues).toContain('grafana');
      expect(optionValues).toContain('pushgateway');
      expect(optionValues).toContain('metering');
    });
  });

  describe('Operation Selectors', () => {
    it('should expose one operation parameter per resource (5 total)', () => {
      const operationParams = observabilityNode.description.properties.filter(
        (p) => p.name === 'operation',
      );

      expect(operationParams.length).toBe(5);
    });

    it('should expose prefixed prometheus operation values', () => {
      const operationParams = observabilityNode.description.properties.filter(
        (p) => p.name === 'operation',
      );
      const prometheusOp = operationParams.find((p) =>
        (p.displayOptions?.show as any)?.resource?.includes('prometheus'),
      );
      const values = ((prometheusOp as any)?.options ?? []).map((o: any) => o.value);

      expect(values).toContain('prometheusInstantQuery');
      expect(values).toContain('prometheusRangeQuery');
      expect(values).toContain('prometheusGetAlerts');
      expect(values).toContain('prometheusGetTargets');
    });

    it('should expose prefixed loki operation values', () => {
      const operationParams = observabilityNode.description.properties.filter(
        (p) => p.name === 'operation',
      );
      const lokiOp = operationParams.find((p) =>
        (p.displayOptions?.show as any)?.resource?.includes('loki'),
      );
      const values = ((lokiOp as any)?.options ?? []).map((o: any) => o.value);

      expect(values).toContain('lokiQueryLogs');
      expect(values).toContain('lokiQueryLogsRange');
      expect(values).toContain('lokiGetLabels');
    });

    // ORPHAN-SOURCE REGRESSION GUARD (instance 3 of the class).
    // pushLogs / pushAAEventLog used to exist ONLY in the parallel, unimported
    // descriptions/ + actions/ trees: compiled into dist/, never wired into
    // ./resources or ./operations, so 6 live workflow nodes named ops the node
    // did not register and died in n8n PARAMETER RESOLUTION — reported as
    // success by onError: continueRegularOutput. These two assertions fail the
    // moment the loki write ops stop being REGISTERED on the real node.
    it('registers the loki WRITE ops (pushLogs, pushAAEventLog) the AA telemetry workflows name', () => {
      const operationParams = observabilityNode.description.properties.filter(
        (p) => p.name === 'operation',
      );
      const lokiOp = operationParams.find((p) =>
        (p.displayOptions?.show as any)?.resource?.includes('loki'),
      );
      const values = ((lokiOp as any)?.options ?? []).map((o: any) => o.value);

      expect(values).toContain('pushLogs');
      expect(values).toContain('pushAAEventLog');
      // Non-vacuity: the loki resource must expose exactly the 5 reads + 2 writes.
      expect(values).toHaveLength(7);
    });

    it('declares the loki push fields (lokiUrl, entries, eventType, eventData) so the ops are configurable', () => {
      const props = observabilityNode.description.properties;
      const shownFor = (name: string) =>
        props.find(
          (p) =>
            p.name === name &&
            (p.displayOptions?.show as any)?.resource?.includes('loki'),
        );

      const lokiUrl = shownFor('lokiUrl');
      expect(lokiUrl).toBeDefined();
      expect((lokiUrl!.displayOptions!.show as any).operation).toEqual([
        'pushLogs',
        'pushAAEventLog',
      ]);
      expect(shownFor('labels')).toBeDefined();
      expect(shownFor('entries')).toBeDefined();
      expect(shownFor('eventType')).toBeDefined();
      expect(shownFor('eventData')).toBeDefined();
      expect(shownFor('level')).toBeDefined();
      expect(shownFor('additionalLabels')).toBeDefined();
    });

    it('flags both loki write ops as write + non-idempotent (a replay appends a second line)', () => {
      // Asserted against the SHIPPED resource module, not a re-declaration here.
      expect(lokiOperationFlags.pushLogs).toEqual({ write: true, idempotent: false });
      expect(lokiOperationFlags.pushAAEventLog).toEqual({ write: true, idempotent: false });
    });

    it('the orphan descriptions/ + actions/ trees are GONE (they are what made this class possible)', () => {
      const nodeDir = join(__dirname, '..');
      expect(existsSync(join(nodeDir, 'descriptions'))).toBe(false);
      expect(existsSync(join(nodeDir, 'actions'))).toBe(false);
      // Positive control: the tree that IS wired must still be there, otherwise
      // this assertion would pass on a deleted repo.
      expect(existsSync(join(nodeDir, 'resources', 'loki.resource.ts'))).toBe(true);
      expect(existsSync(join(nodeDir, 'operations', 'index.ts'))).toBe(true);
    });

    it('should expose prefixed grafana operation values', () => {
      const operationParams = observabilityNode.description.properties.filter(
        (p) => p.name === 'operation',
      );
      const grafanaOp = operationParams.find((p) =>
        (p.displayOptions?.show as any)?.resource?.includes('grafana'),
      );
      const values = ((grafanaOp as any)?.options ?? []).map((o: any) => o.value);

      expect(values).toContain('grafanaSearchDashboards');
      expect(values).toContain('grafanaGetDashboard');
      expect(values).toContain('grafanaCreateAnnotation');
    });
  });

  describe('Execute Method — Prometheus', () => {
    it('should dispatch prometheusInstantQuery to /api/v1/query', async () => {
      const mockResult = { status: 'success', data: { resultType: 'vector', result: [] } };
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: { resource: 'prometheus', operation: 'prometheusInstantQuery' },
      });
      requestMock.mockResolvedValue(mockResult);

      const result = await observabilityNode.execute.call(ctx);

      expect(requestMock).toHaveBeenCalledTimes(1);
      const callArg = requestMock.mock.calls[0][0];
      expect(callArg.method).toBe('GET');
      expect(callArg.uri).toBe('http://obs.test:9090/api/v1/query');
      expect(result[0][0].json).toEqual(mockResult);
    });

    it('should dispatch prometheusRangeQuery to /api/v1/query_range', async () => {
      const mockResult = { status: 'success', data: { resultType: 'matrix', result: [] } };
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: { resource: 'prometheus', operation: 'prometheusRangeQuery' },
      });
      requestMock.mockResolvedValue(mockResult);

      await observabilityNode.execute.call(ctx);

      expect(requestMock.mock.calls[0][0].uri).toBe(
        'http://obs.test:9090/api/v1/query_range',
      );
    });

    it('should dispatch prometheusGetTargets to /api/v1/targets', async () => {
      const mockResult = { status: 'success', data: { activeTargets: [], droppedTargets: [] } };
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: { resource: 'prometheus', operation: 'prometheusGetTargets' },
      });
      requestMock.mockResolvedValue(mockResult);

      await observabilityNode.execute.call(ctx);

      expect(requestMock.mock.calls[0][0].uri).toBe('http://obs.test:9090/api/v1/targets');
    });

    it('should dispatch prometheusGetAlerts to /api/v1/alerts', async () => {
      const mockResult = { status: 'success', data: { alerts: [] } };
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: { resource: 'prometheus', operation: 'prometheusGetAlerts' },
      });
      requestMock.mockResolvedValue(mockResult);

      const result = await observabilityNode.execute.call(ctx);

      expect(requestMock.mock.calls[0][0].uri).toBe('http://obs.test:9090/api/v1/alerts');
      expect(result[0][0].json).toEqual(mockResult);
    });

    it('should dispatch prometheusGetMetricNames to /api/v1/label/__name__/values', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: { resource: 'prometheus', operation: 'prometheusGetMetricNames' },
      });
      requestMock.mockResolvedValue({ status: 'success', data: ['up', 'go_gc_seconds'] });

      await observabilityNode.execute.call(ctx);

      expect(requestMock.mock.calls[0][0].uri).toBe(
        'http://obs.test:9090/api/v1/label/__name__/values',
      );
    });
  });

  describe('Execute Method — Loki', () => {
    it('should dispatch lokiQueryLogs to /loki/api/v1/query', async () => {
      const mockResult = { status: 'success', data: { resultType: 'streams', result: [] } };
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: { resource: 'loki', operation: 'lokiQueryLogs' },
      });
      requestMock.mockResolvedValue(mockResult);

      await observabilityNode.execute.call(ctx);

      expect(requestMock.mock.calls[0][0].uri).toBe('http://obs-loki.test:3100/loki/api/v1/query');
    });

    it('should dispatch lokiGetLabels to /loki/api/v1/labels', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: { resource: 'loki', operation: 'lokiGetLabels' },
      });
      requestMock.mockResolvedValue({ status: 'success', data: ['job', 'instance'] });

      await observabilityNode.execute.call(ctx);

      expect(requestMock.mock.calls[0][0].uri).toBe('http://obs-loki.test:3100/loki/api/v1/labels');
    });

    it('should dispatch lokiGetLabelValues with templated path param', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'loki',
          operation: 'lokiGetLabelValues',
          labelName: 'job',
        },
      });
      requestMock.mockResolvedValue({ status: 'success', data: ['api', 'web'] });

      await observabilityNode.execute.call(ctx);

      expect(requestMock.mock.calls[0][0].uri).toBe(
        'http://obs-loki.test:3100/loki/api/v1/label/job/values',
      );
    });
  });

  describe('Execute Method — Loki push (write surface)', () => {
    it('should POST pushLogs to <lokiUrl>/loki/api/v1/push with a single labelled stream', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'loki',
          operation: 'pushLogs',
          lokiUrl: 'http://localhost:3100/',
          labels: '{"app":"n8n-workflow","namespace":"n8n"}',
          entries: {
            entryValues: [
              { message: 'second', level: 'warn', timestamp: 1785837000000, additionalFields: '{"k":"v"}' },
              { message: 'first', level: 'info', timestamp: 1785836000000, additionalFields: '{}' },
            ],
          },
        },
      });
      requestMock.mockResolvedValue({ statusCode: 204 });

      const result = await observabilityNode.execute.call(ctx);

      expect(requestMock).toHaveBeenCalledTimes(1);
      const callArg = requestMock.mock.calls[0][0];
      expect(callArg.method).toBe('POST');
      // trailing slash stripped before appending the push path
      expect(callArg.uri).toBe('http://localhost:3100/loki/api/v1/push');
      expect(callArg.headers).toEqual({ 'Content-Type': 'application/json' });
      // The API Bearer must NOT reach Loki (unauthenticated endpoint).
      expect(callArg.headers).not.toHaveProperty('Authorization');

      const streams = callArg.body.streams;
      expect(streams).toHaveLength(1);
      expect(streams[0].stream).toEqual({ app: 'n8n-workflow', namespace: 'n8n' });
      expect(streams[0].values).toHaveLength(2);
      // Loki requires ascending timestamps: the later entry must be sorted second.
      expect(BigInt(streams[0].values[0][0]) < BigInt(streams[0].values[1][0])).toBe(true);
      const firstLine = JSON.parse(streams[0].values[0][1]);
      expect(firstLine.msg).toBe('first');
      expect(firstLine.level).toBe('info');
      const secondLine = JSON.parse(streams[0].values[1][1]);
      expect(secondLine.k).toBe('v');

      expect(result[0][0].json).toMatchObject({
        success: true,
        endpoint: 'http://localhost:3100/loki/api/v1/push',
        entriesCount: 2,
        statusCode: 204,
      });
    });

    it('should push pushAAEventLog with app/event labels and promote card_type + list to labels', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'loki',
          operation: 'pushAAEventLog',
          lokiUrl: 'http://localhost:3100',
          eventType: 'aa_telemetry_dropped',
          // The AA workflows pass eventData as JSON.stringify(...) — a STRING.
          eventData:
            '{"producer":"qa-evaluate","row_type":"exec_quality","reason":"post_failed","card_type":"bug_analysis","list":"DOING"}',
          level: 'warn',
          additionalLabels: '{}',
        },
      });
      requestMock.mockResolvedValue({ statusCode: 204 });

      const result = await observabilityNode.execute.call(ctx);

      const body = requestMock.mock.calls[0][0].body;
      expect(body.streams[0].stream).toEqual({
        app: 'aa-workflow',
        event: 'aa_telemetry_dropped',
        card_type: 'bug_analysis',
        list: 'DOING',
      });
      expect(body.streams[0].values).toHaveLength(1);
      const line = JSON.parse(body.streams[0].values[0][1]);
      expect(line.level).toBe('warn');
      expect(line.event).toBe('aa_telemetry_dropped');
      expect(line.producer).toBe('qa-evaluate');
      expect(line.reason).toBe('post_failed');
      expect(line.msg).toBe('AA aa_telemetry_dropped event');
      expect(result[0][0].json).toMatchObject({ success: true, entriesCount: 1 });
    });

    it('should merge additionalLabels on top of the standard AA labels', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'loki',
          operation: 'pushAAEventLog',
          lokiUrl: 'http://loki.test:3100',
          eventType: 'workflow_execution',
          eventData: '{}',
          level: 'info',
          additionalLabels: '{"source":"n8n-demo","environment":"test"}',
        },
      });
      requestMock.mockResolvedValue({ statusCode: 204 });

      await observabilityNode.execute.call(ctx);

      expect(requestMock.mock.calls[0][0].body.streams[0].stream).toEqual({
        app: 'aa-workflow',
        event: 'workflow_execution',
        source: 'n8n-demo',
        environment: 'test',
      });
    });

    it('should throw when NEITHER the node param nor the credential supplies a Loki URL', async () => {
      // The node parameter's declared default is `={{$env.LOKI_URL}}` and LOKI_URL is
      // set nowhere in the n8n deployment, so it has always resolved EMPTY — which is
      // why all six callers hardcode the literal. The op now falls back to the
      // credential's Loki URL (see the case below), so this test supplies NEITHER, to
      // keep pinning the property it was written for: never silently no-op.
      const { ctx } = buildMockExecuteFunctions({
        credentials: {
          baseUrl: 'http://obs.test:9090',
          prometheusUrl: 'http://obs.test:9090',
          grafanaUrl: 'http://obs-graf.test:3000',
          apiToken: 'test-api-token',
          tenantId: 'tenant-uuid-1234',
        },
        paramByName: {
          resource: 'loki',
          operation: 'pushAAEventLog',
          lokiUrl: '',
          eventType: 'workflow_execution',
          eventData: '{}',
          level: 'info',
          additionalLabels: '{}',
        },
      });
      // The WRITE ops carry their own endpoint, so the resource-level guard
      // deliberately does not fire for them (see SELF_ADDRESSING_OPS) — the handler's
      // own error is the accurate one, and it names both places a URL can come from.
      await expect(observabilityNode.execute.call(ctx)).rejects.toThrow(/A Loki URL is required/);
    });

    it('REGRESSION: an explicit node lokiUrl still works when the credential has only baseUrl', async () => {
      // ⛔ The shape ALL SIX live callers use. The per-resource URL guard added
      // alongside this test originally fired for these ops too, BEFORE the item loop
      // and therefore out of reach of continueOnFail — turning a working write path
      // into a hard node failure on deploy. Found by an adversarial review of that
      // change, not by this suite, which is why it is pinned here now.
      const { ctx, requestMock } = buildMockExecuteFunctions({
        credentials: {
          baseUrl: 'http://obs.test:9090',
          apiToken: 'test-api-token',
          tenantId: 'tenant-uuid-1234',
        },
        paramByName: {
          resource: 'loki',
          operation: 'pushAAEventLog',
          lokiUrl: 'http://real-loki.test:3100',
          eventType: 'workflow_execution',
          eventData: '{}',
          level: 'info',
          additionalLabels: '{}',
        },
      });
      requestMock.mockResolvedValue({ statusCode: 204 });
      await observabilityNode.execute.call(ctx);
      expect(requestMock.mock.calls[0][0].uri).toBe('http://real-loki.test:3100/loki/api/v1/push');
    });

    it('grafana requests carry the grafanaApiKey, NOT the observability API token', async () => {
      // ⛔ THE WHOLE POINT OF THE FIELD NAME. Grafana's API is authenticated and does
      // not understand an observability API token, so a grafana request carrying
      // the API Bearer is a 401 with a misleading cause. And the field is called
      // `grafanaApiKey` because the LIVE credential has carried exactly that key,
      // with a correct value, since 2026-02-14 — unread, because the node never
      // declared it. A test that did not assert the header would let this rename be
      // the same defect a second time: a name nothing reads.
      const { ctx, requestMock } = buildMockExecuteFunctions({
        credentials: {
          baseUrl: 'http://obs.test:9090',
          grafanaUrl: 'http://obs-graf.test:3000',
          grafanaApiKey: 'glsa_TEST_KEY',
          apiToken: 'test-api-token',
          tenantId: 'tenant-uuid-1234',
        },
        paramByName: { resource: 'grafana', operation: 'grafanaSearchDashboards' },
      });
      requestMock.mockResolvedValue({});
      await observabilityNode.execute.call(ctx);
      const headers = requestMock.mock.calls[0][0].headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer glsa_TEST_KEY');
      expect(headers.Authorization).not.toContain('test-api-token');
    });

    it('a user:password grafanaApiKey becomes Basic auth', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        credentials: {
          baseUrl: 'http://obs.test:9090',
          grafanaUrl: 'http://obs-graf.test:3000',
          grafanaApiKey: 'admin:secret',
          apiToken: 'test-api-token',
          tenantId: 'tenant-uuid-1234',
        },
        paramByName: { resource: 'grafana', operation: 'grafanaSearchDashboards' },
      });
      requestMock.mockResolvedValue({});
      await observabilityNode.execute.call(ctx);
      const headers = requestMock.mock.calls[0][0].headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Basic ${Buffer.from('admin:secret').toString('base64')}`);
    });

    it('a NON-grafana resource is unaffected by grafanaApiKey', async () => {
      // Scope control: the swap must not leak the Grafana key onto Prometheus/Loki,
      // which DO want the API Bearer.
      const { ctx, requestMock } = buildMockExecuteFunctions({
        credentials: {
          baseUrl: 'http://obs.test:9090',
          grafanaApiKey: 'glsa_TEST_KEY',
          apiToken: 'test-api-token',
          tenantId: 'tenant-uuid-1234',
        },
        paramByName: { resource: 'prometheus', operation: 'prometheusGetAlerts' },
      });
      requestMock.mockResolvedValue({});
      await observabilityNode.execute.call(ctx);
      const headers = requestMock.mock.calls[0][0].headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-api-token');
    });

    it('REGRESSION: pushLogs likewise survives a credential with only baseUrl', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        credentials: {
          baseUrl: 'http://obs.test:9090',
          apiToken: 'test-api-token',
          tenantId: 'tenant-uuid-1234',
        },
        paramByName: {
          resource: 'loki',
          operation: 'pushLogs',
          lokiUrl: 'http://real-loki.test:3100',
          labels: '{"app":"x"}',
          entries: { entryValues: [{ line: 'hello' }] },
        },
      });
      requestMock.mockResolvedValue({ statusCode: 204 });
      await observabilityNode.execute.call(ctx);
      expect(requestMock.mock.calls[0][0].uri).toBe('http://real-loki.test:3100/loki/api/v1/push');
    });

    it('falls back to the credential Loki URL when the node param is empty', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'loki',
          operation: 'pushAAEventLog',
          lokiUrl: '',
          eventType: 'workflow_execution',
          eventData: '{}',
          level: 'info',
          additionalLabels: '{}',
        },
      });
      requestMock.mockResolvedValue({ statusCode: 204 });
      await observabilityNode.execute.call(ctx);
      expect(requestMock.mock.calls[0][0].uri).toBe('http://obs-loki.test:3100/loki/api/v1/push');
    });

    it('should throw when pushLogs is given zero entries (the empty-entries lie)', async () => {
      const { ctx } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'loki',
          operation: 'pushLogs',
          lokiUrl: 'http://loki.test:3100',
          labels: '{"app":"x"}',
          entries: { entryValues: [] },
        },
      });
      await expect(observabilityNode.execute.call(ctx)).rejects.toThrow(/At least one log entry/);
    });

    it('should throw when eventType is empty', async () => {
      const { ctx } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'loki',
          operation: 'pushAAEventLog',
          lokiUrl: 'http://loki.test:3100',
          eventType: '',
          eventData: '{}',
          level: 'info',
          additionalLabels: '{}',
        },
      });
      await expect(observabilityNode.execute.call(ctx)).rejects.toThrow(/eventType is required/);
    });

    it('should accept entries supplied as a bare JSON array expression', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'loki',
          operation: 'pushLogs',
          lokiUrl: 'http://loki.test:3100',
          labels: { app: 'obj-literal' },
          entries: '[{"message":"from expression","level":"error"}]',
        },
      });
      requestMock.mockResolvedValue({ statusCode: 204 });

      await observabilityNode.execute.call(ctx);

      const body = requestMock.mock.calls[0][0].body;
      expect(body.streams[0].stream).toEqual({ app: 'obj-literal' });
      expect(JSON.parse(body.streams[0].values[0][1]).msg).toBe('from expression');
    });
  });

  describe('Execute Method — Grafana', () => {
    it('should dispatch grafanaSearchDashboards to /api/search', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: { resource: 'grafana', operation: 'grafanaSearchDashboards' },
      });
      requestMock.mockResolvedValue([{ uid: 'dash1', title: 'Test' }]);

      const result = await observabilityNode.execute.call(ctx);

      expect(requestMock.mock.calls[0][0].uri).toBe('http://obs-graf.test:3000/api/search');
      // Array results are flattened into multiple output items
      expect(result[0]).toHaveLength(1);
      expect(result[0][0].json).toEqual({ uid: 'dash1', title: 'Test' });
    });

    it('should dispatch grafanaGetDashboard with templated uid', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'grafana',
          operation: 'grafanaGetDashboard',
          dashboardUid: 'abc-123',
        },
      });
      requestMock.mockResolvedValue({ dashboard: { uid: 'abc-123' }, meta: {} });

      await observabilityNode.execute.call(ctx);

      expect(requestMock.mock.calls[0][0].uri).toBe(
        'http://obs-graf.test:3000/api/dashboards/uid/abc-123',
      );
    });

    it('should dispatch grafanaCreateAnnotation as POST with body fields', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'grafana',
          operation: 'grafanaCreateAnnotation',
          text: 'deploy started',
          dashboardId: 1,
          panelId: 2,
          tags: '["release","prod"]',
          time: 1704067200000,
          timeEnd: 1704067260000,
        },
      });
      requestMock.mockResolvedValue({ id: 42, message: 'Annotation added' });

      await observabilityNode.execute.call(ctx);

      const callArg = requestMock.mock.calls[0][0];
      expect(callArg.method).toBe('POST');
      expect(callArg.uri).toBe('http://obs-graf.test:3000/api/annotations');
      expect(callArg.body).toEqual({
        text: 'deploy started',
        dashboardId: 1,
        panelId: 2,
        tags: ['release', 'prod'],
        time: 1704067200000,
        timeEnd: 1704067260000,
      });
    });
  });

  describe('Execute Method — Pushgateway', () => {
    it('should POST a minimal pushMetric to /metrics/job/<job> with text body', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'pushgateway',
          operation: 'pushMetric',
          pushgatewayUrl: 'http://pushgateway.test:9091',
          job: 'cron_test',
          labelPairs: {},
          metrics: {
            metric: [
              { name: 'cron_last_success_seconds', value: 1715760000, type: 'gauge', help: '' },
            ],
          },
        },
      });
      requestMock.mockResolvedValue({ statusCode: 200 });

      const result = await observabilityNode.execute.call(ctx);

      expect(requestMock).toHaveBeenCalledTimes(1);
      const callArg = requestMock.mock.calls[0][0];
      expect(callArg.method).toBe('POST');
      expect(callArg.uri).toBe('http://pushgateway.test:9091/metrics/job/cron_test');
      expect(callArg.headers).toEqual({ 'Content-Type': 'text/plain' });
      expect(callArg.body).toBe('# TYPE cron_last_success_seconds gauge\ncron_last_success_seconds 1715760000\n');
      expect(result[0][0].json).toEqual({
        success: true,
        url: 'http://pushgateway.test:9091/metrics/job/cron_test',
        statusCode: 200,
        metricsCount: 1,
      });
    });

    it('should append grouping labels as /key/value/ path segments and emit HELP + TYPE lines', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'pushgateway',
          operation: 'pushMetric',
          pushgatewayUrl: 'http://pushgateway.test:9091/',
          job: 'improve_workflow_qa',
          labelPairs: {
            label: [
              { name: 'card_type', value: 'architecture epic' },
              { name: 'phase', value: 'qa' },
            ],
          },
          metrics: {
            metric: [
              { name: 'cron_last_success_seconds', value: '1715760000', type: 'gauge', help: 'last successful cron run' },
            ],
          },
        },
      });
      requestMock.mockResolvedValue({ statusCode: 202 });

      await observabilityNode.execute.call(ctx);

      const callArg = requestMock.mock.calls[0][0];
      expect(callArg.uri).toBe(
        'http://pushgateway.test:9091/metrics/job/improve_workflow_qa/card_type/architecture%20epic/phase/qa',
      );
      expect(callArg.body).toBe(
        '# HELP cron_last_success_seconds last successful cron run\n# TYPE cron_last_success_seconds gauge\ncron_last_success_seconds 1715760000\n',
      );
    });

    it('should NOT load observabilityApi credentials when resource=pushgateway', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'pushgateway',
          operation: 'pushMetric',
          pushgatewayUrl: 'http://pushgateway.test:9091',
          job: 'j',
          labelPairs: {},
          metrics: { metric: [{ name: 'x', value: 1, type: 'gauge', help: '' }] },
        },
      });
      requestMock.mockResolvedValue({ statusCode: 200 });

      await observabilityNode.execute.call(ctx);

      expect(ctx.getCredentials).not.toHaveBeenCalled();
      // No Authorization / X-Tenant-ID header for pushgateway
      const callArg = requestMock.mock.calls[0][0];
      expect(callArg.headers).not.toHaveProperty('Authorization');
      expect(callArg.headers).not.toHaveProperty('X-Tenant-ID');
    });

    it('should throw when pushgatewayUrl is empty', async () => {
      const { ctx } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'pushgateway',
          operation: 'pushMetric',
          pushgatewayUrl: '',
          job: 'j',
          labelPairs: {},
          metrics: { metric: [{ name: 'x', value: 1, type: 'gauge', help: '' }] },
        },
      });
      await expect(observabilityNode.execute.call(ctx)).rejects.toThrow(/pushgatewayUrl is required/);
    });

    it('should throw when job is empty', async () => {
      const { ctx } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'pushgateway',
          operation: 'pushMetric',
          pushgatewayUrl: 'http://pushgateway.test:9091',
          job: '',
          labelPairs: {},
          metrics: { metric: [{ name: 'x', value: 1, type: 'gauge', help: '' }] },
        },
      });
      await expect(observabilityNode.execute.call(ctx)).rejects.toThrow(/job is required/);
    });

    it('should throw when no metrics are supplied', async () => {
      const { ctx } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'pushgateway',
          operation: 'pushMetric',
          pushgatewayUrl: 'http://pushgateway.test:9091',
          job: 'j',
          labelPairs: {},
          metrics: { metric: [] },
        },
      });
      await expect(observabilityNode.execute.call(ctx)).rejects.toThrow(/At least one metric/);
    });

    it('should throw when metric value is non-numeric', async () => {
      const { ctx } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'pushgateway',
          operation: 'pushMetric',
          pushgatewayUrl: 'http://pushgateway.test:9091',
          job: 'j',
          labelPairs: {},
          metrics: { metric: [{ name: 'x', value: 'not-a-number', type: 'gauge', help: '' }] },
        },
      });
      await expect(observabilityNode.execute.call(ctx)).rejects.toThrow(/non-numeric value/);
    });

    it('should throw when metric name is empty', async () => {
      const { ctx } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'pushgateway',
          operation: 'pushMetric',
          pushgatewayUrl: 'http://pushgateway.test:9091',
          job: 'j',
          labelPairs: {},
          metrics: { metric: [{ name: '', value: 1, type: 'gauge', help: '' }] },
        },
      });
      await expect(observabilityNode.execute.call(ctx)).rejects.toThrow(/Metric name is required/);
    });
  });

  describe('Execute Method — Prometheus pushMetricsOTLP', () => {
    it('should POST an OTLP/JSON payload to <endpoint>/v1/metrics with counter→sum, gauge→gauge, histogram→histogram', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'prometheus',
          operation: 'pushMetricsOTLP',
          otlpEndpoint: 'http://localhost:4318/',
          metrics: {
            metricValues: [
              { name: 'aa_workflow_execution_total', type: 'counter', value: 1, labels: { status: 'success' } },
              { name: 'aa_workflow_duration_seconds', type: 'histogram', value: 2.5, labels: {} },
              { name: 'detector_up', type: 'gauge', value: 1, labels: {} },
            ],
          },
          // The telemetry workflows pass resourceAttributes as JSON.stringify(...) — a string.
          resourceAttributes: '{"service.name":"aa-workflow","service.namespace":"n8n"}',
        },
      });
      requestMock.mockResolvedValue({ statusCode: 200 });

      const result = await observabilityNode.execute.call(ctx);

      expect(requestMock).toHaveBeenCalledTimes(1);
      const callArg = requestMock.mock.calls[0][0];
      expect(callArg.method).toBe('POST');
      // trailing slash on the endpoint is stripped before appending /v1/metrics
      expect(callArg.uri).toBe('http://localhost:4318/v1/metrics');
      expect(callArg.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(callArg.json).toBe(true);

      const rm = callArg.body.resourceMetrics[0];
      expect(rm.resource.attributes).toEqual([
        { key: 'service.name', value: { stringValue: 'aa-workflow' } },
        { key: 'service.namespace', value: { stringValue: 'n8n' } },
      ]);
      const metrics = rm.scopeMetrics[0].metrics;
      expect(metrics[0].name).toBe('aa_workflow_execution_total');
      expect(metrics[0].sum.isMonotonic).toBe(true);
      expect(metrics[0].sum.aggregationTemporality).toBe(2);
      expect(metrics[0].sum.dataPoints[0].attributes).toEqual([
        { key: 'status', value: { stringValue: 'success' } },
      ]);
      expect(metrics[1].histogram.dataPoints[0].sum).toBe(2.5);
      expect(metrics[2].gauge.dataPoints[0].asDouble).toBe(1);

      expect(result[0][0].json).toMatchObject({
        success: true,
        endpoint: 'http://localhost:4318/v1/metrics',
        metricsCount: 3,
        statusCode: 200,
      });
    });

    it('should default resource attributes when none supplied', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'prometheus',
          operation: 'pushMetricsOTLP',
          otlpEndpoint: 'http://localhost:4318',
          metrics: { metricValues: [{ name: 'x', type: 'gauge', value: 1 }] },
          resourceAttributes: '',
        },
      });
      requestMock.mockResolvedValue({ statusCode: 200 });

      await observabilityNode.execute.call(ctx);
      const attrs = requestMock.mock.calls[0][0].body.resourceMetrics[0].resource.attributes;
      expect(attrs).toEqual([{ key: 'service.name', value: { stringValue: 'n8n-workflow' } }]);
    });

    it('should throw when otlpEndpoint is empty', async () => {
      const { ctx } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'prometheus',
          operation: 'pushMetricsOTLP',
          otlpEndpoint: '',
          metrics: { metricValues: [{ name: 'x', type: 'gauge', value: 1 }] },
        },
      });
      await expect(observabilityNode.execute.call(ctx)).rejects.toThrow(/otlpEndpoint is required/);
    });

    it('should throw when metricValues is empty', async () => {
      const { ctx } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'prometheus',
          operation: 'pushMetricsOTLP',
          otlpEndpoint: 'http://localhost:4318',
          metrics: { metricValues: [] },
        },
      });
      await expect(observabilityNode.execute.call(ctx)).rejects.toThrow(/non-empty array/);
    });
  });

  describe('Auth header injection', () => {
    it('should include Authorization Bearer + X-Tenant-ID on every request', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        credentials: {
          baseUrl: 'http://obs.test:9090',
          apiToken: 'super-secret-token',
          tenantId: 'tenant-abc',
        },
        paramByName: { resource: 'prometheus', operation: 'prometheusGetAlerts' },
      });
      requestMock.mockResolvedValue({ status: 'success', data: { alerts: [] } });

      await observabilityNode.execute.call(ctx);

      const callArg = requestMock.mock.calls[0][0];
      expect(callArg.headers.Authorization).toBe('Bearer super-secret-token');
      expect(callArg.headers['X-Tenant-ID']).toBe('tenant-abc');
    });

    it('omits X-Tenant-ID entirely when the credential carries no tenantId (service introspects the Bearer)', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        credentials: {
          baseUrl: 'http://obs.test:9090',
          apiToken: 'tok',
        },
        paramByName: { resource: 'prometheus', operation: 'prometheusGetAlerts' },
      });
      requestMock.mockResolvedValue({});

      await observabilityNode.execute.call(ctx);

      const callArg = requestMock.mock.calls[0][0];
      // No hardcoded tenant fallback: the header must be absent, not a foreign tenant.
      expect(callArg.headers).not.toHaveProperty('X-Tenant-ID');
      expect(callArg.headers.Authorization).toBe('Bearer tok');
    });

    it('the credential field default is "" and no source carries a hardcoded tenant UUID', () => {
      // A tenant UUID is deployment data, never a code-side fallback: the guard is
      // over the SHAPE, because scrubbing one literal must not turn the check into
      // a search for a placeholder that was never in the source.
      const HARDCODED_TENANT_PATTERN =
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      const cred = new ObservabilityApi();
      const tenantProp = cred.properties.find((p) => p.name === 'tenantId');
      expect(tenantProp).toBeDefined();
      expect(tenantProp!.default).toBe('');

      const credSrc = readFileSync(
        join(__dirname, '..', '..', '..', 'credentials', 'ObservabilityApi.credentials.ts'),
        'utf8',
      );
      const nodeSrc = readFileSync(join(__dirname, '..', 'Observability.node.ts'), 'utf8');
      expect(credSrc).not.toMatch(HARDCODED_TENANT_PATTERN);
      expect(nodeSrc).not.toMatch(HARDCODED_TENANT_PATTERN);
    });
  });

  describe('Error handling', () => {
    it('should wrap dispatcher Errors in NodeOperationError', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: { resource: 'prometheus', operation: 'prometheusGetAlerts' },
      });
      requestMock.mockRejectedValue(new Error('boom'));

      await expect(observabilityNode.execute.call(ctx)).rejects.toThrow(NodeOperationError);
    });

    it('should map 401 → "Authentication failed"', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: { resource: 'prometheus', operation: 'prometheusGetAlerts' },
      });
      requestMock.mockRejectedValue({ statusCode: 401, message: 'Unauthorized' });

      // The authenticator throws NodeApiError; node wraps in NodeOperationError
      await expect(observabilityNode.execute.call(ctx)).rejects.toThrow(/Authentication failed/);
    });

    it('should map 403 → "Access denied"', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: { resource: 'prometheus', operation: 'prometheusGetAlerts' },
      });
      requestMock.mockRejectedValue({ statusCode: 403, message: 'Forbidden' });

      await expect(observabilityNode.execute.call(ctx)).rejects.toThrow(/Access denied/);
    });

    it('should map 429 → "Rate limit exceeded"', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: { resource: 'prometheus', operation: 'prometheusGetAlerts' },
      });
      requestMock.mockRejectedValue({ statusCode: 429, message: 'Too Many Requests' });

      await expect(observabilityNode.execute.call(ctx)).rejects.toThrow(/Rate limit exceeded/);
    });

    it('should throw "Unknown resource: …" for an unknown resource value', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: { resource: 'mystery', operation: 'foo' },
      });

      await expect(observabilityNode.execute.call(ctx)).rejects.toThrow(/Unknown resource/);
      expect(requestMock).not.toHaveBeenCalled();
    });

    it('should throw "Unknown <resource> operation: …" for an unknown operation value', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: { resource: 'prometheus', operation: 'doesNotExist' },
      });

      await expect(observabilityNode.execute.call(ctx)).rejects.toThrow(
        /Unknown prometheus operation/,
      );
      expect(requestMock).not.toHaveBeenCalled();
    });

    it('should yield error item when continueOnFail=true', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: { resource: 'prometheus', operation: 'prometheusGetAlerts' },
        continueOnFail: true,
      });
      requestMock.mockRejectedValue(new Error('Test error'));

      const result = await observabilityNode.execute.call(ctx);

      expect(result[0]).toHaveLength(1);
      expect(result[0][0].json).toEqual({
        error: 'Test error',
        resource: 'prometheus',
        operation: 'prometheusGetAlerts',
      });
      expect(result[0][0].pairedItem).toEqual({ item: 0 });
    });
  });

  describe('Credentials handling', () => {
    it('should call getCredentials("observabilityApi")', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: { resource: 'prometheus', operation: 'prometheusGetAlerts' },
      });
      requestMock.mockResolvedValue({ status: 'success', data: { alerts: [] } });

      await observabilityNode.execute.call(ctx);

      expect(ctx.getCredentials).toHaveBeenCalledWith('observabilityApi');
    });

    it('should use baseUrl from credentials over the env-default', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        credentials: {
          baseUrl: 'http://custom-host.example:1234',
          apiToken: 'tok',
          tenantId: 't',
        },
        paramByName: { resource: 'prometheus', operation: 'prometheusGetAlerts' },
      });
      requestMock.mockResolvedValue({});

      await observabilityNode.execute.call(ctx);

      expect(requestMock.mock.calls[0][0].uri).toBe(
        'http://custom-host.example:1234/api/v1/alerts',
      );
    });
  });

  describe('Return data handling', () => {
    it('should include pairedItem on each return item', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: { resource: 'prometheus', operation: 'prometheusGetAlerts' },
      });
      requestMock.mockResolvedValue({ status: 'success', data: { alerts: [] } });

      const result = await observabilityNode.execute.call(ctx);

      expect(result[0][0].pairedItem).toEqual({ item: 0 });
    });

    it('should process multiple items in batch', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        inputItems: [{ json: {} }, { json: {} }],
        paramByName: { resource: 'prometheus', operation: 'prometheusGetAlerts' },
      });
      requestMock.mockResolvedValue({ status: 'success', data: { alerts: [] } });

      const result = await observabilityNode.execute.call(ctx);

      expect(requestMock).toHaveBeenCalledTimes(2);
      expect(result[0]).toHaveLength(2);
      expect(result[0][0].pairedItem).toEqual({ item: 0 });
      expect(result[0][1].pairedItem).toEqual({ item: 1 });
    });

    it('should flatten array responses into per-element output items', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: { resource: 'grafana', operation: 'grafanaSearchDashboards' },
      });
      requestMock.mockResolvedValue([
        { uid: 'a', title: 'A' },
        { uid: 'b', title: 'B' },
        { uid: 'c', title: 'C' },
      ]);

      const result = await observabilityNode.execute.call(ctx);

      expect(result[0]).toHaveLength(3);
      expect(result[0][0].json).toEqual({ uid: 'a', title: 'A' });
      expect(result[0][2].json).toEqual({ uid: 'c', title: 'C' });
      // All paired to the single input item
      expect(result[0].every((r) => r.pairedItem && (r.pairedItem as any).item === 0)).toBe(true);
    });
  });

  describe('Execute Method — Metering', () => {
    const METRICS_FIXTURE = [
      '# HELP metering_exec_quality_avg_score average qa score',
      '# TYPE metering_exec_quality_avg_score gauge',
      'metering_exec_quality_avg_score{asset_id="00000000-0000-4000-8000-000000000001",asset_kind="prompt"} 0.3875',
      'metering_exec_quality_avg_score{asset_id="00000000-0000-4000-8000-000000000002",asset_kind="workflow"} 0.9',
      'metering_exec_quality_governed_avg_score{asset_id="00000000-0000-4000-8000-000000000001",asset_kind="prompt"} 0.36363636363636365',
      'metering_exec_quality_total_count{asset_id="00000000-0000-4000-8000-000000000001",asset_kind="prompt"} 24.0',
      '',
    ].join('\n');

    it('should fetch /metrics and reshape one family into a Prometheus vector envelope', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'metering',
          operation: 'meteringInstantQuery',
          meteringUrl: 'http://metering.test:8156',
          metricName: 'metering_exec_quality_avg_score',
          assetKind: '',
        },
      });
      requestMock.mockResolvedValue(METRICS_FIXTURE);

      const result = await observabilityNode.execute.call(ctx);

      expect(requestMock).toHaveBeenCalledTimes(1);
      const callArg = requestMock.mock.calls[0][0];
      expect(callArg.method).toBe('GET');
      expect(callArg.uri).toBe('http://metering.test:8156/metrics');
      expect(callArg.json).toBe(false);

      const env = result[0][0].json as any;
      expect(env.status).toBe('success');
      expect(env.data.resultType).toBe('vector');
      // avg_score has two series (prompt + workflow); governed/total must NOT leak in.
      expect(env.data.result).toHaveLength(2);
      const prompt = env.data.result.find((s: any) => s.metric.asset_kind === 'prompt');
      expect(prompt.metric.asset_id).toBe('00000000-0000-4000-8000-000000000001');
      // value mirrors the prometheus instant-query [ts, "str"] shape; consumers Number() it.
      expect(Number(prompt.value[1])).toBeCloseTo(0.3875, 6);
      expect(prompt.value[0]).toBe(0);
    });

    it('should filter by assetKind when provided', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'metering',
          operation: 'meteringInstantQuery',
          meteringUrl: 'http://metering.test:8156/',
          metricName: 'metering_exec_quality_avg_score',
          assetKind: 'prompt',
        },
      });
      requestMock.mockResolvedValue(METRICS_FIXTURE);

      const result = await observabilityNode.execute.call(ctx);

      // trailing slash stripped
      expect(requestMock.mock.calls[0][0].uri).toBe('http://metering.test:8156/metrics');
      const env = result[0][0].json as any;
      expect(env.data.result).toHaveLength(1);
      expect(env.data.result[0].metric.asset_kind).toBe('prompt');
    });

    it('should match the series name exactly (no prefix bleed)', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'metering',
          operation: 'meteringInstantQuery',
          meteringUrl: 'http://metering.test:8156',
          // total_count must not also match _total_count-prefixed lines, and
          // avg_score must not match governed_avg_score (different prefix anyway).
          metricName: 'metering_exec_quality_total_count',
          assetKind: '',
        },
      });
      requestMock.mockResolvedValue(METRICS_FIXTURE);

      const result = await observabilityNode.execute.call(ctx);
      const env = result[0][0].json as any;
      expect(env.data.result).toHaveLength(1);
      expect(Number(env.data.result[0].value[1])).toBe(24);
    });

    it('should NOT load observabilityApi credentials when resource=metering', async () => {
      const { ctx, requestMock } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'metering',
          operation: 'meteringInstantQuery',
          meteringUrl: 'http://metering.test:8156',
          metricName: 'metering_exec_quality_avg_score',
          assetKind: '',
        },
      });
      requestMock.mockResolvedValue(METRICS_FIXTURE);

      await observabilityNode.execute.call(ctx);

      expect(ctx.getCredentials).not.toHaveBeenCalled();
      const callArg = requestMock.mock.calls[0][0];
      expect(callArg.headers === undefined || !('Authorization' in (callArg.headers ?? {}))).toBe(true);
    });

    it('should throw when meteringUrl is empty', async () => {
      const { ctx } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'metering',
          operation: 'meteringInstantQuery',
          meteringUrl: '',
          metricName: 'metering_exec_quality_avg_score',
          assetKind: '',
        },
      });
      await expect(observabilityNode.execute.call(ctx)).rejects.toThrow(/meteringUrl is required/);
    });

    it('should throw when metricName is empty', async () => {
      const { ctx } = buildMockExecuteFunctions({
        paramByName: {
          resource: 'metering',
          operation: 'meteringInstantQuery',
          meteringUrl: 'http://metering.test:8156',
          metricName: '',
          assetKind: '',
        },
      });
      await expect(observabilityNode.execute.call(ctx)).rejects.toThrow(/metricName is required/);
    });
  });
});
