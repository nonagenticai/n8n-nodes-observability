/**
 * GATE: a parameter a handler READS must be a parameter the DESCRIPTION DECLARES,
 * and a request must be addressed to the base URL of its own RESOURCE.
 *
 * ── THE BUG CLASS THIS EXISTS FOR ───────────────────────────────────────────────
 * n8n does not hand a handler the `parameters` object stored on the workflow. It
 * normalises that object against `nodeType.description.properties` first
 * (`getNodeParameters`), keeping only what the description declares AT THE POSITION
 * it was written. A key the description declares only as a CHILD of a `collection`
 * is not a top-level key, so a handler reading it by bare name gets nothing — and
 * gets it silently, because `getNodeParameter(name, i, default)` cheerfully returns
 * the default.
 *
 * This node had that defect on essentially its whole read surface. `operations/index.ts`
 * reads `query`, `start`, `end`, `step`, `timeout`, `metric`, `match`, `limit`,
 * `direction`, `logQuery`, `annotationFilters`, `labelName`, `dashboardUid`,
 * `searchOptions`, `time` — every one of them bare and top-level — while the
 * descriptions declared most of them inside an `additionalOptions` collection and
 * four of them under a DIFFERENT NAME or not at all. So every Prometheus instant and
 * range query, every Loki log query, every series match, every metadata lookup and
 * every annotation fetch went out with NO PARAMETERS, and returned a plausible,
 * cheerful, unasked-for answer.
 *
 * The handlers are the intentional side. `operations/index.ts:1-11` records that they
 * were deliberately hand-patched off the `additionalOptions.` prefix and warns that
 * regenerating them reintroduces "the empty-query bug that broke all Prometheus/Loki
 * demos at v0.1.1". The descriptions were simply never brought along. So this gate
 * treats the HANDLER as the specification and the DESCRIPTION as the thing that must
 * agree with it.
 *
 * ── WHY IT DRIVES THE REAL NORMALISER RATHER THAN RE-IMPLEMENTING IT ────────────
 * The rule is not "the name appears somewhere in the properties array" — that is the
 * check that would have passed on the broken tree, because `query` DID appear, just
 * one level down. The only thing that settles it is what n8n itself keeps, so the
 * gate calls n8n's own `getNodeParameters` from `n8n-workflow` (already a
 * devDependency). A re-implementation could drift from the engine; this cannot.
 *
 * ── LEG 2: ADDRESSING ──────────────────────────────────────────────────────────
 * The same file fronts three different backends behind ONE credential URL, so every
 * Loki READ and every Grafana operation was addressed to Prometheus. The gate seeds
 * three DISTINCT sentinel hosts and requires each request to carry its own resource's
 * host and no other. This leg is red on the unfixed tree for a reason worth stating:
 * the pre-existing suite ASSERTS the defect as correct behaviour — it expects Loki at
 * `http://obs.test:9090/loki/...` and Grafana at `http://obs.test:9090/api/...`.
 *
 * ── NON-VACUITY ────────────────────────────────────────────────────────────────
 * A gate over "every operation" is worthless if it silently examines none, so this
 * file FAILS if it does not inspect at least MIN_OPERATIONS operations, and it pins
 * the operations that were already CORRECT before the fix (the write surface —
 * pushLogs, pushAAEventLog, pushMetricsOTLP, pushMetric, meteringInstantQuery,
 * grafanaCreateAnnotation). Those must stay green throughout, so a "fix" that merely
 * made the gate blind would be caught by the same file that reports the defect.
 */
import { IExecuteFunctions } from 'n8n-workflow';
import { NodeHelpers } from 'n8n-workflow';
import { Observability } from '../Observability.node';

const SENTINEL_PROM = 'http://prom.test:9090';
const SENTINEL_LOKI = 'http://loki.test:3100';
const SENTINEL_GRAF = 'http://graf.test:3000';

const HOST_BY_RESOURCE: Record<string, string> = {
  prometheus: SENTINEL_PROM,
  loki: SENTINEL_LOKI,
  grafana: SENTINEL_GRAF,
};

/**
 * Operations whose PARAMETERS (leg 1) were already declared correctly before this
 * gate landed — the write surface. They are the control that proves the gate
 * discriminates rather than simply failing everything: on the unfixed tree leg 1 is
 * GREEN for all six while it is RED for 13 read operations.
 *
 * ⚠️ "Correct on leg 1" is NOT "correct". `grafana.grafanaCreateAnnotation` has
 * always declared its parameters properly AND has always been sent to Prometheus,
 * so it is green on leg 1 and red on leg 2 — which is the whole point of splitting
 * the two legs: a parameter defect and an addressing defect are independent, and a
 * single pass/fail per operation would have conflated them.
 */
const ALREADY_CORRECT = [
  'prometheus.pushMetricsOTLP',
  'loki.pushLogs',
  'loki.pushAAEventLog',
  'grafana.grafanaCreateAnnotation',
  'pushgateway.pushMetric',
  'metering.meteringInstantQuery',
];

/** Floor: the description declares 23 operations across 5 resources today. */
const MIN_OPERATIONS = 20;
const MIN_RESOURCES = 5;

/**
 * A value that is non-empty for every shape a handler might coerce it to, so a
 * handler runs past its own guards and reaches the read we are trying to observe.
 * Handlers skip `""`, so an empty sentinel would hide exactly what we measure.
 */
const SENTINEL_VALUE = 'RECON_SENTINEL';

function enumerateOperations(): Array<{ resource: string; operation: string }> {
  const description = new Observability().description;
  const out: Array<{ resource: string; operation: string }> = [];
  for (const prop of description.properties) {
    if (prop.name !== 'operation') continue;
    const resources = (prop.displayOptions?.show?.resource ?? []) as string[];
    for (const resource of resources) {
      for (const option of (prop.options ?? []) as Array<{ value: string }>) {
        out.push({ resource, operation: option.value });
      }
    }
  }
  return out;
}

/**
 * Drive one operation with a RECORDING `getNodeParameter` and return both the set of
 * names the handler asked for and the URIs it addressed. Handlers are allowed to
 * throw (several throw on a missing URL) — a throw still leaves the reads that got
 * us there, which is the evidence we want.
 */
async function observe(resource: string, operation: string) {
  const reads = new Set<string>();
  const uris: string[] = [];
  const requestMock = jest.fn(async (opts: { uri?: string }) => {
    if (opts?.uri) uris.push(opts.uri);
    return {};
  });

  const ctx = {
    getInputData: () => [{ json: {} }],
    getNodeParameter: (name: string, _i?: number, defaultValue?: unknown) => {
      if (name === 'resource') return resource;
      if (name === 'operation') return operation;
      reads.add(name);
      // A collection read (`getParam('c', {}).child`) must return an object or the
      // handler crashes before we learn anything; everything else wants a scalar.
      if (defaultValue !== undefined && typeof defaultValue === 'object' && defaultValue !== null) {
        return defaultValue;
      }
      // A URL-shaped parameter must get a URL-shaped sentinel. The write ops
      // (`pushLogs`, `pushAAEventLog`, `pushMetric`, `pushMetricsOTLP`) take their
      // endpoint from such a parameter and validate it, falling back to the
      // credential base URL when it does not parse — so feeding them the generic
      // string sentinel would make them LOOK misaddressed and would manufacture a
      // failure in exactly the operations that are this gate's controls.
      if (/(url|endpoint)$/i.test(name)) return HOST_BY_RESOURCE[resource] ?? SENTINEL_PROM;
      return SENTINEL_VALUE;
    },
    getCredentials: async () => ({
      baseUrl: SENTINEL_PROM,
      prometheusUrl: SENTINEL_PROM,
      lokiUrl: SENTINEL_LOKI,
      grafanaUrl: SENTINEL_GRAF,
      apiToken: 'test-api-token',
      tenantId: 'tenant-uuid-1234',
    }),
    getNode: () => ({
      id: 'recon-node',
      name: 'Recon Node',
      type: 'n8n-nodes-base.observability',
      typeVersion: 2,
      position: [0, 0] as [number, number],
      parameters: {},
    }),
    // MUST be false. With continueOnFail the node CATCHES a handler throw and emits
    // an error item, so execute() resolves and `threw` reads false — which made LEG 4
    // treat a handler that had stopped at its first guard as one that ran to
    // completion, and then accuse it of not reading a parameter it reads ten lines
    // later. The probe's own error handling was hiding the thing the probe measures.
    continueOnFail: () => false,
    helpers: { request: requestMock },
  } as unknown as IExecuteFunctions;

  let threw = false;
  try {
    await new Observability().execute.call(ctx);
  } catch {
    /* a throw still leaves `reads` and `uris` populated — that is the evidence */
    threw = true;
  }
  return { reads, uris, threw };
}

/**
 * Ask n8n which of these names actually survive normalisation as TOP-LEVEL keys.
 * This is the whole gate: `getNodeParameters` is the same function the execution
 * engine runs before a handler ever sees a parameter.
 */
function survivesNormalisation(
  resource: string,
  operation: string,
  names: string[],
): Set<string> {
  const description = new Observability().description;
  const nodeValues: Record<string, unknown> = { resource, operation };
  for (const name of names) nodeValues[name] = SENTINEL_VALUE;

  const node = {
    id: 'recon-node',
    name: 'Recon Node',
    type: 'n8n-nodes-base.observability',
    typeVersion: 2,
    position: [0, 0] as [number, number],
    parameters: nodeValues,
  };

  const normalised = NodeHelpers.getNodeParameters(
    description.properties,
    nodeValues,
    true,
    false,
    node as never,
    description as never,
  ) as Record<string, unknown> | null;

  return new Set(Object.keys(normalised ?? {}));
}

/** Which top-level properties does the description SHOW for this (resource, operation)? */
function shownProperties(resource: string, operation: string): string[] {
  const description = new Observability().description;
  const out: string[] = [];
  for (const prop of description.properties) {
    if (prop.name === 'resource' || prop.name === 'operation') continue;
    const show = prop.displayOptions?.show as Record<string, unknown[]> | undefined;
    if (show) {
      if (show.resource && !(show.resource as string[]).includes(resource)) continue;
      if (show.operation && !(show.operation as string[]).includes(operation)) continue;
    }
    out.push(prop.name);
  }
  return out;
}

/** Drive one operation with a credential that supplies ONLY `baseUrl`. */
async function observeWithLegacyCredentialOnly(resource: string, operation: string) {
  const uris: string[] = [];
  let threw = false;
  const requestMock = jest.fn(async (opts: { uri?: string }) => {
    if (opts?.uri) uris.push(opts.uri);
    return {};
  });
  const ctx = {
    getInputData: () => [{ json: {} }],
    getNodeParameter: (name: string, _i?: number, defaultValue?: unknown) => {
      if (name === 'resource') return resource;
      if (name === 'operation') return operation;
      if (defaultValue !== undefined && typeof defaultValue === 'object' && defaultValue !== null) {
        return defaultValue;
      }
      // Deliberately DO NOT supply a URL-shaped sentinel here: the point is a
      // credential (and node) with no per-backend URL at all.
      return SENTINEL_VALUE;
    },
    getCredentials: async () => ({
      baseUrl: SENTINEL_PROM,
      apiToken: 'test-api-token',
      tenantId: 'tenant-uuid-1234',
    }),
    getNode: () => ({
      id: 'recon-node', name: 'Recon Node', type: 'n8n-nodes-base.observability',
      typeVersion: 2, position: [0, 0] as [number, number], parameters: {},
    }),
    continueOnFail: () => false,
    helpers: { request: requestMock },
  } as unknown as IExecuteFunctions;
  try {
    await new Observability().execute.call(ctx);
  } catch {
    threw = true;
  }
  return { uris, threw };
}

describe('description ↔ handler reconciliation', () => {
  const operations = enumerateOperations();

  it('inspects a non-vacuous number of operations', () => {
    const resources = new Set(operations.map((o) => o.resource));
    expect(operations.length).toBeGreaterThanOrEqual(MIN_OPERATIONS);
    expect(resources.size).toBeGreaterThanOrEqual(MIN_RESOURCES);
  });

  it('pins every already-correct operation as still enumerable', () => {
    const keys = new Set(operations.map((o) => `${o.resource}.${o.operation}`));
    for (const control of ALREADY_CORRECT) expect(keys.has(control)).toBe(true);
  });

  describe('LEG 1 — every name a handler reads survives n8n normalisation', () => {
    it.each(enumerateOperations().map((o) => [o.resource, o.operation]))(
      '%s.%s',
      async (resource, operation) => {
        const { reads } = await observe(resource, operation);
        const names = [...reads];
        if (names.length === 0) return; // an operation with no parameters is fine
        const kept = survivesNormalisation(resource, operation, names);
        const dropped = names.filter((n) => !kept.has(n));
        expect({ operation: `${resource}.${operation}`, dropped }).toEqual({
          operation: `${resource}.${operation}`,
          dropped: [],
        });
      },
    );
  });

  describe('LEG 3 — a missing per-backend URL must NEVER fall back to baseUrl', () => {
    // ⛔ THIS LEG EXISTS BECAUSE ITS ABSENCE WAS CAUGHT. Legs 1 and 2 seed a
    // credential carrying all three URLs, so they cannot see a fallback: an
    // adversarial review reinstated `grafana: grafanaUrl || baseUrl` — the ORIGINAL
    // BUG — and the whole suite stayed green. A guard that cannot observe the
    // property it was built to defend is decoration.
    //
    // With ONLY `baseUrl` configured, a loki/grafana READ must refuse. What it must
    // never do is quietly send the request to baseUrl, because baseUrl is Prometheus.
    it.each(
      enumerateOperations()
        .filter((o) => (o.resource === 'loki' || o.resource === 'grafana'))
        .filter((o) => !['pushLogs', 'pushAAEventLog'].includes(o.operation))
        .map((o) => [o.resource, o.operation]),
    )('%s.%s refuses rather than addressing baseUrl', async (resource, operation) => {
      const { uris, threw } = await observeWithLegacyCredentialOnly(resource, operation);
      const addressedPrometheus = uris.filter((u) => u.startsWith(SENTINEL_PROM));
      expect({ operation: `${resource}.${operation}`, addressedPrometheus, threw }).toEqual({
        operation: `${resource}.${operation}`,
        addressedPrometheus: [],
        threw: true,
      });
    });

    it('the loki WRITE ops are deliberately exempt and still work', async () => {
      // They carry their own endpoint and have never read baseUrl, so gating them on
      // a credential URL breaks a working path rather than fixing a broken one.
      for (const operation of ['pushLogs', 'pushAAEventLog']) {
        const { uris } = await observeWithLegacyCredentialOnly('loki', operation);
        for (const uri of uris) expect(uri.startsWith(SENTINEL_PROM)).toBe(false);
      }
    });
  });

  describe('LEG 4 — a property shown for an operation is read by that operation', () => {
    const LEG4_ASSERTED = new Set<string>();
    const LEG4_SKIPPED = new Set<string>();

    afterAll(() => {
      // NON-VACUITY. Every operation whose handler throws on the generic sentinel is
      // exempted above. If that exemption ever grew to cover most of the node, this
      // leg would report green having asserted almost nothing — the failure shape
      // this whole file exists to prevent. Measured today: 15 asserted, 8 skipped.
      const asserted = LEG4_ASSERTED.size;
      if (asserted < 12) {
        throw new Error(
          `LEG 4 asserted only ${asserted} operation(s) (skipped ${LEG4_SKIPPED.size}: ` +
            `${[...LEG4_SKIPPED].join(', ')}). Below the floor of 12 — the leg is no longer ` +
            `covering the node and its green is meaningless.`,
        );
      }
    });

    // The reverse direction of leg 1: leg 1 catches a read with no declaration, this
    // catches a declaration with no read — DEAD UI, a field an author can fill in
    // that goes nowhere. Its absence was also caught adversarially: a comment in
    // prometheus.resource.ts claimed this leg existed before it did, and a planted
    // `totallyUnreadParam` shown on two prometheus operations passed unnoticed.
    it.each(enumerateOperations().map((o) => [o.resource, o.operation]))(
      '%s.%s',
      async (resource, operation) => {
        const { reads, threw } = await observe(resource, operation);
        // ⚠️ SOUNDNESS, not convenience. If the handler THREW, it stopped early and
        // the reads we observed are a PREFIX of the reads it makes — so "shown but
        // not read" is unproven, not proven. Asserting anyway produces a confident
        // false accusation: measured on `prometheus.pushMetricsOTLP`, which reads
        // `resourceAttributes` on a line the probe never reaches because the generic
        // sentinel cannot satisfy the metrics guard above it. The count floor below
        // is what stops this exemption from quietly swallowing the whole leg.
        if (threw) {
          LEG4_SKIPPED.add(`${resource}.${operation}`);
          return;
        }
        LEG4_ASSERTED.add(`${resource}.${operation}`);
        const unread = shownProperties(resource, operation).filter((n) => !reads.has(n));
        expect({ operation: `${resource}.${operation}`, unread }).toEqual({
          operation: `${resource}.${operation}`,
          unread: [],
        });
      },
    );
  });

  describe('LEG 2 — a request is addressed to its own resource', () => {
    it.each(
      enumerateOperations()
        .filter((o) => HOST_BY_RESOURCE[o.resource])
        .map((o) => [o.resource, o.operation]),
    )('%s.%s', async (resource, operation) => {
      const { uris } = await observe(resource, operation);
      if (uris.length === 0) return; // handler threw before addressing anything
      const expected = HOST_BY_RESOURCE[resource];
      const foreign = Object.entries(HOST_BY_RESOURCE)
        .filter(([r]) => r !== resource)
        .map(([, host]) => host);
      for (const uri of uris) {
        const wrong = foreign.find((host) => uri.startsWith(host));
        expect({ uri, addressedTo: wrong ?? expected }).toEqual({ uri, addressedTo: expected });
        expect(uri.startsWith(expected)).toBe(true);
      }
    });
  });
});
