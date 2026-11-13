/**
 * Integration Tests for Observability Module (post-orval-pipeline regen)
 *
 * Drives the public Observability node through multi-step workflows that
 * exercise the new `executeOperation` dispatcher in
 * nodes/Observability/operations/index.ts. The dispatcher uses prefixed op
 * names (`prometheusGetAlerts`, `lokiQueryLogs`, `grafanaSearchDashboards`,
 * ...) and routes via `ctx.helpers.request()` directly — the legacy
 * `actions/*.operations.ts` modules are no longer reached by the node.
 */
import { IExecuteFunctions, NodeOperationError } from 'n8n-workflow';
import { Observability } from '../../nodes/Observability/Observability.node';
import { executeOperation } from '../../nodes/Observability/operations';

const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';
const BASE_URL = 'http://obs.test:9090';

interface BuildOpts {
  inputItems?: Array<{ json: Record<string, unknown> }>;
  credentials?: Record<string, unknown>;
  paramByName?: Record<string, unknown>;
  continueOnFail?: boolean;
}

function buildCtx(opts: BuildOpts = {}) {
  const requestMock = jest.fn();
  const ctx = {
    getInputData: jest.fn().mockReturnValue(opts.inputItems ?? [{ json: {} }]),
    getNodeParameter: jest.fn(
      (name: string, _itemIndex?: number, defaultValue?: unknown) => {
        if (opts.paramByName && Object.prototype.hasOwnProperty.call(opts.paramByName, name)) {
          return opts.paramByName[name];
        }
        return defaultValue;
      },
    ),
    getCredentials: jest.fn().mockResolvedValue(
      opts.credentials ?? {
        baseUrl: BASE_URL,
        apiToken: 'test-api-token',
        tenantId: DEFAULT_TENANT,
      },
    ),
    getNode: jest.fn().mockReturnValue({
      id: 'test-node-id',
      name: 'Test Node',
      type: 'n8n-nodes-base.observability',
      typeVersion: 2,
      position: [0, 0] as [number, number],
      parameters: {},
    }),
    continueOnFail: jest.fn().mockReturnValue(opts.continueOnFail ?? false),
    helpers: { request: requestMock },
  } as unknown as jest.Mocked<IExecuteFunctions>;
  return { ctx, requestMock };
}

const authHeaders = (token = 'test-api-token', tenantId = DEFAULT_TENANT) => ({
  Authorization: `Bearer ${token}`,
  'X-Tenant-ID': tenantId,
});

describe('Observability Integration Tests', () => {
  describe('Prometheus Workflow (via dispatcher)', () => {
    it('should complete instant query → targets → alerts via executeOperation', async () => {
      const { ctx, requestMock } = buildCtx();

      requestMock.mockResolvedValueOnce({
        status: 'success',
        data: { resultType: 'vector', result: [{ metric: { __name__: 'up' }, value: [1, '1'] }] },
      });
      const queryResult = (await executeOperation(
        ctx,
        BASE_URL,
        authHeaders(),
        'prometheus',
        'prometheusInstantQuery',
        0,
      )) as any;
      expect(queryResult.status).toBe('success');
      expect(requestMock.mock.calls[0][0].uri).toBe(`${BASE_URL}/api/v1/query`);

      requestMock.mockResolvedValueOnce({
        status: 'success',
        data: {
          activeTargets: [{ scrapeUrl: 'http://localhost:9090/metrics', health: 'up' }],
          droppedTargets: [],
        },
      });
      const targetsResult = (await executeOperation(
        ctx,
        BASE_URL,
        authHeaders(),
        'prometheus',
        'prometheusGetTargets',
        0,
      )) as any;
      expect(targetsResult.data.activeTargets).toHaveLength(1);
      expect(requestMock.mock.calls[1][0].uri).toBe(`${BASE_URL}/api/v1/targets`);

      requestMock.mockResolvedValueOnce({ status: 'success', data: { alerts: [] } });
      const alertsResult = (await executeOperation(
        ctx,
        BASE_URL,
        authHeaders(),
        'prometheus',
        'prometheusGetAlerts',
        0,
      )) as any;
      expect(alertsResult.status).toBe('success');
      expect(requestMock.mock.calls[2][0].uri).toBe(`${BASE_URL}/api/v1/alerts`);
    });

    it('should handle range query', async () => {
      const { ctx, requestMock } = buildCtx();
      requestMock.mockResolvedValueOnce({
        status: 'success',
        data: { resultType: 'matrix', result: [] },
      });

      const result = (await executeOperation(
        ctx,
        BASE_URL,
        authHeaders(),
        'prometheus',
        'prometheusRangeQuery',
        0,
      )) as any;

      expect(result.status).toBe('success');
      expect(result.data.resultType).toBe('matrix');
      expect(requestMock.mock.calls[0][0].uri).toBe(`${BASE_URL}/api/v1/query_range`);
      expect(requestMock.mock.calls[0][0].method).toBe('GET');
    });
  });

  describe('Loki Workflow (via dispatcher)', () => {
    it('should complete query logs → labels → label values via executeOperation', async () => {
      const { ctx, requestMock } = buildCtx({
        paramByName: { labelName: 'job' },
      });

      requestMock.mockResolvedValueOnce({
        status: 'success',
        data: {
          resultType: 'streams',
          result: [{ stream: { job: 'test' }, values: [['1700000000000000000', 'msg']] }],
        },
      });
      const logs = (await executeOperation(
        ctx,
        BASE_URL,
        authHeaders(),
        'loki',
        'lokiQueryLogs',
        0,
      )) as any;
      expect(logs.status).toBe('success');
      expect(requestMock.mock.calls[0][0].uri).toBe(`${BASE_URL}/loki/api/v1/query`);

      requestMock.mockResolvedValueOnce({
        status: 'success',
        data: ['job', 'level', 'instance'],
      });
      const labels = (await executeOperation(
        ctx,
        BASE_URL,
        authHeaders(),
        'loki',
        'lokiGetLabels',
        0,
      )) as any;
      expect(labels.data).toContain('job');
      expect(requestMock.mock.calls[1][0].uri).toBe(`${BASE_URL}/loki/api/v1/labels`);

      requestMock.mockResolvedValueOnce({
        status: 'success',
        data: ['api', 'web', 'worker'],
      });
      const values = (await executeOperation(
        ctx,
        BASE_URL,
        authHeaders(),
        'loki',
        'lokiGetLabelValues',
        0,
      )) as any;
      expect(values.data).toContain('api');
      expect(requestMock.mock.calls[2][0].uri).toBe(`${BASE_URL}/loki/api/v1/label/job/values`);
    });
  });

  describe('Grafana Workflow (via dispatcher)', () => {
    it('should complete search → get dashboard → annotations via executeOperation', async () => {
      const { ctx, requestMock } = buildCtx({
        paramByName: { dashboardUid: 'dash1' },
      });

      requestMock.mockResolvedValueOnce([
        { uid: 'dash1', title: 'System Overview' },
        { uid: 'dash2', title: 'Application Metrics' },
      ]);
      const search = (await executeOperation(
        ctx,
        BASE_URL,
        authHeaders(),
        'grafana',
        'grafanaSearchDashboards',
        0,
      )) as any[];
      expect(search).toHaveLength(2);
      expect(requestMock.mock.calls[0][0].uri).toBe(`${BASE_URL}/api/search`);

      requestMock.mockResolvedValueOnce({
        dashboard: { uid: 'dash1', title: 'System Overview' },
        meta: { canEdit: true },
      });
      const dash = (await executeOperation(
        ctx,
        BASE_URL,
        authHeaders(),
        'grafana',
        'grafanaGetDashboard',
        0,
      )) as any;
      expect(dash.dashboard.uid).toBe('dash1');
      expect(requestMock.mock.calls[1][0].uri).toBe(`${BASE_URL}/api/dashboards/uid/dash1`);

      requestMock.mockResolvedValueOnce([{ id: 1, text: 'deploy', time: 1700000000000 }]);
      const ann = (await executeOperation(
        ctx,
        BASE_URL,
        authHeaders(),
        'grafana',
        'grafanaGetAnnotations',
        0,
      )) as any[];
      expect(ann).toHaveLength(1);
      expect(requestMock.mock.calls[2][0].uri).toBe(`${BASE_URL}/api/annotations`);
    });

    it('should create annotation as POST with body fields', async () => {
      const { ctx, requestMock } = buildCtx({
        paramByName: {
          text: 'Test annotation',
          dashboardId: 1,
          panelId: 2,
          tags: '["test","deployment"]',
        },
      });
      requestMock.mockResolvedValueOnce({ id: 123, message: 'Annotation added' });

      const result = (await executeOperation(
        ctx,
        BASE_URL,
        authHeaders(),
        'grafana',
        'grafanaCreateAnnotation',
        0,
      )) as any;

      expect(result.id).toBe(123);
      const callArg = requestMock.mock.calls[0][0];
      expect(callArg.method).toBe('POST');
      expect(callArg.uri).toBe(`${BASE_URL}/api/annotations`);
      expect(callArg.body).toEqual({
        text: 'Test annotation',
        dashboardId: 1,
        panelId: 2,
        tags: ['test', 'deployment'],
      });
    });
  });

  describe('Observability Node Integration (full execute() pipeline)', () => {
    let observabilityNode: Observability;

    beforeEach(() => {
      observabilityNode = new Observability();
    });

    it('should attach Authorization + X-Tenant-ID headers from credentials', async () => {
      const { ctx, requestMock } = buildCtx({
        credentials: {
          baseUrl: BASE_URL,
          apiToken: 'license-xyz',
          tenantId: 'tenant-007',
        },
        paramByName: { resource: 'prometheus', operation: 'prometheusGetAlerts' },
      });
      requestMock.mockResolvedValue({ status: 'success', data: { alerts: [] } });

      await observabilityNode.execute.call(ctx);

      const callArg = requestMock.mock.calls[0][0];
      expect(callArg.headers.Authorization).toBe('Bearer license-xyz');
      expect(callArg.headers['X-Tenant-ID']).toBe('tenant-007');
    });

    it('should handle errors with continueOnFail enabled (401 path)', async () => {
      const { ctx, requestMock } = buildCtx({
        paramByName: { resource: 'prometheus', operation: 'prometheusInstantQuery' },
        continueOnFail: true,
      });
      requestMock.mockRejectedValue({ statusCode: 401, message: 'Unauthorized' });

      const result = await observabilityNode.execute.call(ctx);

      expect(result[0]).toHaveLength(1);
      expect(result[0][0].json).toHaveProperty('error');
      expect(result[0][0].json.resource).toBe('prometheus');
      expect(result[0][0].json.operation).toBe('prometheusInstantQuery');
    });

    it('should process multiple items in batch', async () => {
      const { ctx, requestMock } = buildCtx({
        inputItems: [{ json: {} }, { json: {} }],
        paramByName: { resource: 'prometheus', operation: 'prometheusGetAlerts' },
      });
      requestMock.mockResolvedValue({ status: 'success', data: { alerts: [] } });

      const result = await observabilityNode.execute.call(ctx);

      expect(result[0]).toHaveLength(2);
      expect(requestMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('Error Handling Scenarios', () => {
    it('should map 401 → NodeOperationError with Authentication-failed wording', async () => {
      const observabilityNode = new Observability();
      const { ctx, requestMock } = buildCtx({
        paramByName: { resource: 'prometheus', operation: 'prometheusGetAlerts' },
      });
      requestMock.mockRejectedValue({ statusCode: 401, message: 'Unauthorized' });

      await expect(observabilityNode.execute.call(ctx)).rejects.toThrow(/Authentication failed/);
    });

    it('should map 403 → NodeOperationError with "Access denied"', async () => {
      const observabilityNode = new Observability();
      const { ctx, requestMock } = buildCtx({
        paramByName: { resource: 'prometheus', operation: 'prometheusGetAlerts' },
      });
      requestMock.mockRejectedValue({ statusCode: 403, message: 'Forbidden' });

      await expect(observabilityNode.execute.call(ctx)).rejects.toThrow(/Access denied/);
    });

    it('should map 404 directly through (no special mapping)', async () => {
      const observabilityNode = new Observability();
      const { ctx, requestMock } = buildCtx({
        paramByName: { resource: 'grafana', operation: 'grafanaGetDashboard', dashboardUid: 'missing' },
      });
      requestMock.mockRejectedValue({ statusCode: 404, message: 'Not Found' });

      // 404 is not in RetryingRequest's special-case set; it surfaces as NodeOperationError
      await expect(observabilityNode.execute.call(ctx)).rejects.toThrow(NodeOperationError);
    });

    it('should map 429 → NodeOperationError with "Rate limit exceeded"', async () => {
      const observabilityNode = new Observability();
      const { ctx, requestMock } = buildCtx({
        paramByName: {
          resource: 'prometheus',
          operation: 'prometheusGetMetricNames',
        },
      });
      requestMock.mockRejectedValue({ statusCode: 429, message: 'Too Many Requests' });

      await expect(observabilityNode.execute.call(ctx)).rejects.toThrow(/Rate limit exceeded/);
    });
  });
});
