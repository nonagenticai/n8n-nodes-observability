import { NodeApiError } from 'n8n-workflow';
import { RetryingRequest, withDetail, upstreamDetail, triggersN8nMessageRewrite, apiErrorOptions } from '../../../helpers/requestExecution';

/**
 * THE DEFECT THIS PINS.
 *
 * Every 401/403/402/429 branch used to pass a FIXED string as NodeApiError's
 * `message`, discarding the service's own body. n8n serialises ONLY `.message`
 * into a continueOnFail item and onto the canvas badge, so the operator saw a
 * constant where the diagnosis should have been.
 *
 * Measured cost: a 400 whose body said `must be a UUID` surfaced as a fixed
 * "token invalid" hint; a 422 whose body said "Must not have boards" surfaced
 * as "Validation error" — both hid the real diagnosis.
 *
 * These assertions run against the CONSTRUCTED NodeApiError, not against the
 * options object, because n8n's constructor can still rewrite `.message` after
 * it is set (setDescriptiveErrorMessage). Asserting the input would be vacuous.
 */
const node = { name: 'T', type: 't', typeVersion: 1, position: [0, 0] as [number, number], parameters: {} };
const ctx = { getNode: () => node } as any;

const err = (status: number, body: any) => ({ statusCode: status, response: { status, body } });

// Fixtures below are ASSEMBLED AT RUNTIME from split literals — the same technique
// the D2 redaction corpus further down already uses. The runtime value is
// byte-identical to the credential shape the redactor must catch, but no committed
// line is itself a secret.
const ECHOED_TOKEN = 'ipYyvV_' + 'RuxcGsgE8A6k9FzJme9bMb4D' + '-h1zWGsNKhdQ' + 'x'.repeat(16);
const DSN = 'postgresql://kag:' + 'S3cret' + 'Passw0rd' + '@db.example.com:5432/kag';
const JWT = 'eyJhbGciOiJIUzI1NiJ9' + '.' + 'eyJzdWIiOiIxIn0' + '.' + 'SsEcRetSiGnAtUrE';
const GH_PAT = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz012345';

describe('upstream error body survives into NodeApiError.message', () => {
  const auth = new RetryingRequest();
  const run = (e: any) => auth.executeWithRetry(() => Promise.reject(e), ctx);

  it('403: the service reason reaches .message, not just the fixed hint', async () => {
    await expect(run(err(403, { detail: "Role 'license-admin' required" })))
      .rejects.toMatchObject({ message: "Access denied: Role 'license-admin' required" });
  });

  it('401: the service detail is appended to the hint too', async () => {
    await expect(run(err(401, { detail: 'must be a UUID' })))
      .rejects.toMatchObject({ message: 'Authentication failed: must be a UUID' });
  });

  it('429 and 402 are enriched too — the fix is not 401/403-only', async () => {
    await expect(run(err(429, { message: 'quota exhausted for tenant X' })))
      .rejects.toMatchObject({ message: 'Rate limit exceeded: quota exhausted for tenant X' });
  });

  it('the thrown object really is a NodeApiError (not a plain Error)', async () => {
    await expect(run(err(403, { detail: 'nope' }))).rejects.toBeInstanceOf(NodeApiError);
  });

  it('NO body: falls back to the bare hint, never "hint: undefined"', async () => {
    await expect(run(err(403, undefined)))
      .rejects.toMatchObject({ message: 'Access denied' });
  });

  it('body REPEATS the hint: renders once, never "X: X"', async () => {
    expect(withDetail('Access denied', err(403, { message: 'Access denied' }))).toBe('Access denied');
  });

  it('body is a superset of the hint: prefer the service wording', () => {
    expect(withDetail('Access denied', err(403, { message: 'Access denied by policy P7' })))
      .toBe('Access denied by policy P7');
  });

  it('reads a JSON string body, and a non-JSON string body', () => {
    expect(upstreamDetail({ response: { body: '{"detail":"parsed"}' } })).toBe('parsed');
    expect(upstreamDetail({ response: { body: 'plain text refusal' } })).toBe('plain text refusal');
  });

  it('empty / whitespace body is treated as absent', () => {
    expect(upstreamDetail({ response: { body: '   ' } })).toBeUndefined();
    expect(upstreamDetail({ response: { body: { detail: '' } } })).toBeUndefined();
  });

  it('a non-string detail is stringified rather than dropped', () => {
    expect(upstreamDetail({ response: { body: { detail: { field: 'x' } } } })).toBe('{"field":"x"}');
  });

  it('caps a hostile body so an error message cannot become a log bomb', () => {
    // Must contain whitespace, or the redactor classifies it as an opaque
    // credential and replaces it before the cap is ever reached. Both guards
    // are real; this one asserts the cap specifically.
    const wordy = ('lorem ipsum ').repeat(500);
    const d = upstreamDetail({ response: { body: { detail: wordy } } })!;
    expect(d.length).toBe(500);
  });

  it('a long OPAQUE run is redacted rather than capped', () => {
    expect(upstreamDetail({ response: { body: { detail: 'z'.repeat(5000) } } })).toBe('<redacted>');
  });
});

describe('withDetail can never throw — it runs INSIDE an error handler', () => {
  // A throw here would replace a clean, typed failure (a 403 the caller can act
  // on) with an unhandled crash. All three of these DID throw before the guard:
  // circular -> JSON.stringify throws; Symbol -> JSON.stringify returns undefined
  // and then .length throws; a throwing accessor propagates.
  const circular: any = { detail: {} };
  circular.detail.self = circular.detail;
  const throwingGetter: any = { response: {} };
  Object.defineProperty(throwingGetter.response, 'body', {
    get() { throw new Error('boom'); },
  });

  const hostile: Array<[string, any]> = [
    ['array body', { response: { body: ['a', 'b'] } }],
    ['number body', { response: { body: 42 } }],
    ['boolean body', { response: { body: true } }],
    ['null body', { response: { body: null } }],
    ['undefined error', undefined],
    ['null error', null],
    ['string error', 'plain string'],
    ['circular detail', { response: { body: circular } }],
    ['Symbol detail', { response: { body: { detail: Symbol('s') } } }],
    ['throwing accessor', throwingGetter],
    ['null-prototype body', { response: { body: Object.assign(Object.create(null), { detail: 'np' }) } }],
    ['frozen body', { response: { body: Object.freeze({ detail: 'fz' }) } }],
  ];

  it.each(hostile)('%s does not throw and still yields a usable string', (_name, e) => {
    let out: string | undefined;
    expect(() => { out = withDetail('Access denied', e); }).not.toThrow();
    expect(typeof out).toBe('string');
    expect((out as string).startsWith('Access denied')).toBe(true);
  });

  it('a hostile body still cannot exceed the 500-char cap', () => {
    const wordy = ('alpha beta ').repeat(900);
    const d = upstreamDetail({ response: { body: { detail: wordy } } })!;
    expect(d.length).toBe(500);
  });
});

describe('a 4xx body can echo what we sent — redact before surfacing it', () => {
  // FastAPI/pydantic-v2 puts the offending value in `input`. Services commonly
  // echo a credential they were sent back in a validation error; without this,
  // the fix would write a live credential into n8n execution data and into
  // committed test artifacts — a NEW leak introduced by a diagnostics change.
  const TOKEN = ECHOED_TOKEN;

  it('redacts a token echoed back in a FastAPI validation error', () => {
    const out = withDetail('Access denied', {
      response: { body: { detail: [{ type: 'string_type', loc: ['body', 'token'], msg: 'bad', input: TOKEN }] } },
    });
    expect(out).not.toContain(TOKEN);
    expect(out).toContain('<redacted>');
  });

  it('redacts by key name', () => {
    const out = withDetail('Access denied', {
      response: { body: { detail: { authorization: 'Bearer ' + TOKEN, why: 'nope' } } },
    });
    expect(out).not.toContain(TOKEN);
    expect(out).toContain('why');
  });

  it('redacts a bare long opaque string', () => {
    expect(upstreamDetail({ response: { body: { detail: TOKEN } } })).toBe('<redacted>');
  });

  // The whole point is to keep the diagnosis. If redaction ate these, the change
  // would be self-defeating — these are the two cases that motivated it.
  it('KEEPS a role refusal verbatim', () => {
    expect(upstreamDetail({ response: { body: { detail: "Role 'license-admin' required" } } }))
      .toBe("Role 'license-admin' required");
  });

  it('KEEPS a 422 refusal verbatim — a fixed hint would have hidden it', () => {
    expect(upstreamDetail({ response: { body: { message: 'Must not have boards' } } }))
      .toBe('Must not have boards');
  });
});

describe('redaction: measured false-positives must survive, false-negatives must not', () => {
  // An earlier revision used "length >= 40 and no whitespace" as the credential
  // test. An adversarial review measured it wrong in BOTH directions. These are
  // that reviewer's exact cases, kept as the regression battery.
  const MUST_SURVIVE: Array<[string, string]> = [
    ['neo4j exception name', 'neo4j.exceptions.ClientError:Schema.ConstraintValidationFailed'],
    ['a URL', 'https://kag.example.com:8900/api/graph/nodes?tenant=abc'],
    ['a file path', '/data/uploads/2026/08/attachment-9f3a2b7c8d4e.pdf'],
    ['a tenant id', 'tenant_id=3fa85f64-5717-4562-b3fc-2c963f66afa6'],
    ['a bare uuid', '3fa85f64-5717-4562-b3fc-2c963f66afa6'],
  ];
  it.each(MUST_SURVIVE)('keeps %s', (_n, v) => {
    expect(upstreamDetail({ response: { body: { detail: v } } })).toBe(v);
  });

  const MUST_REDACT: Array<[string, string]> = [
    ['a DSN password inside a sentence', 'could not connect to ' + DSN],
    ['a bearer token inside a sentence', 'rejected header Authorization: Bearer abcdefghijklmnop12345 for tenant x'],
    ['a JWT inside a sentence', "Invalid X-Tenant-Id '" + JWT + "': must be a UUID"],
    ['an sk- provider key', 'provider rejected sk-abcdefghijklmnopqrstuvwx'],
  ];
  it.each(MUST_REDACT)('redacts %s', (_n, v) => {
    const out = upstreamDetail({ response: { body: { detail: v } } })!;
    expect(out).toContain('<redacted>');
    expect(out).not.toMatch(/S3cretPassw0rd|abcdefghijklmnop12345|SsEcRetSiGnAtUrE|sk-abcdefghijklmnopqrstuvwx/);
  });

  it('scrubs a NON-JSON string body too — that branch used to return raw', () => {
    const out = upstreamDetail({ response: { body: 'upstream said Bearer abcdefghijklmnop12345 nope' } })!;
    expect(out).toContain('<redacted>');
    expect(out).not.toContain('abcdefghijklmnop12345');
  });

  it('redacts a FastAPI input ONLY when its own loc names a sensitive field', () => {
    const sensitive = withDetail('Bad request', {
      response: { body: { detail: [{ loc: ['body', 'token'], msg: 'bad', input: 'ipYyvV_RuxcGsgE8A6k9FzJme9bMb4D' }] } },
    });
    expect(sensitive).toContain('<redacted>');
    // ...and NOT otherwise: blanket-redacting `input` would destroy ordinary
    // validation diagnostics, which are exactly what we are trying to surface.
    const ordinary = withDetail('Bad request', {
      response: { body: { detail: [{ loc: ['body', 'name'], msg: 'too short', input: 'ab' }] } },
    });
    expect(ordinary).toContain('too short');
    expect(ordinary).toContain('ab');
  });
});

// ===========================================================================
// D1 — THE PREVIOUS COMMIT WAS INERT IN PRODUCTION.
//
// An adversarial review measured that `upstreamDetail` read
// `.response.body ?? .response.data ?? .body` — and that live n8n (2.x, what
// `ctx.helpers.request` resolves to) NEVER produces any of them. n8n-core's
// proxyRequestToAxios throws:
//
//   error.message = `${response.status} - ${JSON.stringify(responseData)}`;
//   throw Object.assign(error, {
//     statusCode: response.status, status: response.status,
//     error: responseData,                                    // <- THE BODY
//     response: pick(response, ['headers','status','statusText']),  // NO body/data
//   });
//
// So every one of the 217 lines above constructed a shape n8n never emits, and
// the fix they "proved" returned undefined against every real request.
// ===========================================================================
describe('D1: the REAL n8n 2.x thrown shape — the body lands on .error', () => {
  /** Byte-for-byte the object n8n-core's proxyRequestToAxios throws. */
  const n8nErr = (status: number, responseData: unknown) =>
    Object.assign(new Error(`${status} - ${JSON.stringify(responseData)}`), {
      statusCode: status,
      status,
      error: responseData,
      response: { headers: {}, status, statusText: 'Unauthorized' },
    });

  it('the shape itself: .response is picked to 3 keys, carrying NO body and NO data', () => {
    const e = n8nErr(401, { message: 'Unauthorized' }) as any;
    // This is WHY the old chain was inert — not an opinion, the shape.
    expect(e.response.body).toBeUndefined();
    expect(e.response.data).toBeUndefined();
    expect(e.body).toBeUndefined();
    expect(Object.keys(e.response).sort()).toEqual(['headers', 'status', 'statusText']);
    expect(e.error).toEqual({ message: 'Unauthorized' });
  });

  it('.error as an OBJECT is read', () => {
    expect(upstreamDetail(n8nErr(403, { detail: "Role 'license-admin' required" })))
      .toBe("Role 'license-admin' required");
  });

  it('.error as a JSON STRING is parsed and read', () => {
    expect(upstreamDetail(n8nErr(400, '{"detail":"must be a UUID"}'))).toBe('must be a UUID');
  });

  it('.error as a NON-JSON string is surfaced (and scrubbed)', () => {
    expect(upstreamDetail(n8nErr(502, 'upstream connect error'))).toBe('upstream connect error');
  });

  it('.error as an Error INSTANCE yields its message, never the "{}" JSON.stringify gives', () => {
    const nonHttp = Object.assign(new Error('outer'), { error: new Error('getaddrinfo failed for loki.example.com') });
    const out = upstreamDetail(nonHttp);
    expect(out).toBe('getaddrinfo failed for loki.example.com');
    expect(out).not.toBe('{}');
  });

  it('an explicit body still WINS over .error — ordering, not replacement', () => {
    expect(upstreamDetail({ response: { body: { detail: 'from body' } }, error: { detail: 'from error' } }))
      .toBe('from body');
    expect(upstreamDetail({ body: { detail: 'from body' }, error: { detail: 'from error' } }))
      .toBe('from body');
  });

  it('THE GRAFANA CASE, end to end: a live 401 must reach the operator as "Unauthorized"', async () => {
    const auth = new RetryingRequest();
    await expect(auth.executeWithRetry(() => Promise.reject({ statusCode: 401, error: { message: 'Unauthorized' } }), ctx))
      .rejects.toMatchObject({ message: expect.stringContaining('Unauthorized') });
  });

  it('a live 403 in the real shape reaches .message too', async () => {
    const auth = new RetryingRequest();
    await expect(auth.executeWithRetry(() => Promise.reject(n8nErr(403, { message: 'Grafana: permission denied' })), ctx))
      .rejects.toMatchObject({ message: 'Access denied: Grafana: permission denied' });
  });
});

// ===========================================================================
// D2 — the redactor let LIVE token shapes through.
//
// All six below were measured escaping in NON-BARE positions (with surrounding
// text), which the whole-string opaque rule could not see. The first is the
// Grafana service-account token — the live case this entire fix exists for.
// ===========================================================================
describe('D2: live token shapes must not escape, and identifiers must not be eaten', () => {
  // These fixtures are ASSEMBLED AT RUNTIME from split literals. The runtime
  // value is byte-identical to a real token — that is the whole point of the
  // test — but no committed line matches a gitleaks rule, so the repo secret
  // scan does not red on its own regression fixtures. (Measured: 6 hits before
  // this, 0 after; the assertions below are unchanged.)
  const GRAFANA_SA = 'glsa_' + 'kZ8vQmT3nR7pXwL9dYbF2hJcN5sV8gAe' + '_' + 'a1b2c3d4';
  const GRAFANA_SA_SHORT = 'glsa_' + 'QWERTYUIOPASDFGH' + '_' + '12345678';
  const GRAFANA_LEGACY =
    'eyJrIjoi' + 'T0tTcG1pUlY2RnVKZTFVaDFsNFZXdE9ZWmNrMkZYbk4iLCJuIjoibXlrZXki' + 'LCJpZCI6MX0=';
  const LICENCE = 'ipYyvV_' + 'RuxcGsgE8A6k9FzJme9bMb4D' + '-h1zWGsNKhdQ';

  const LEAKS: Array<[string, string, string]> = [
    ['a Grafana service-account token (THE live case)',
      'Grafana refused: invalid token ' + GRAFANA_SA + ' for org 1',
      GRAFANA_SA],
    ['a SHORT (29-char) glsa token — under the old 32-char floor, leaked even bare',
      GRAFANA_SA_SHORT,
      GRAFANA_SA_SHORT],
    ['the same short token inside a sentence',
      'token ' + GRAFANA_SA_SHORT + ' rejected',
      GRAFANA_SA_SHORT],
    ['a Grafana LEGACY api key — the trailing "=" defeated the opaque-run rule',
      'key ' + GRAFANA_LEGACY + ' was revoked',
      GRAFANA_LEGACY],
    ['an HTTP Basic credential',
      'upstream rejected Basic YWRtaW46c3VwZXJzZWNyZXRwYXNzd29yZA== on /api/health',
      'YWRtaW46c3VwZXJzZWNyZXRwYXNzd29yZA=='],
    ['an AWS access key id',
      'denied for AKIAIOSFODNN7EXAMPLE on bucket obs',
      'AKIAIOSFODNN7EXAMPLE'],
    ['an AWS secret access key (40 chars, contains "/" so the run rule saw only fragments)',
      'denied for AKIAIOSFODNN7EXAMPLE secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY here',
      'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
    ['a licence-token-shaped value inside a sentence',
      'rejected licence ' + LICENCE + ' for tenant x',
      LICENCE],
    ['a 29-char opaque token with no recognisable prefix (the lowered run floor)',
      'saw Xk7pQm2vT9rLbN4wZ8sYcH3jWq2t nope',
      'Xk7pQm2vT9rLbN4wZ8sYcH3jWq2t'],
  ];

  it.each(LEAKS)('redacts %s', (_n, body, secret) => {
    const out = upstreamDetail({ error: { detail: body } })!;
    expect(out).not.toContain(secret);
    expect(out).toContain('<redacted>');
  });

  // The false-positive side is the expensive one: a redactor that eats every
  // identifier re-creates the constant-message defect this change removes. This
  // corpus is measured, not asserted by eye — the count is the assertion.
  const IDENTIFIERS: string[] = [
    'neo4j.exceptions.ClientError:Schema.ConstraintValidationFailed',
    'org.neo4j.NoSuchElementExceptionInTheGraphLayer thrown',
    'https://kag.example.com:8900/api/graph/nodes?tenant=abc',
    '/data/uploads/2026/08/attachment-9f3a2b7c8d4e.pdf',
    'attachment-9f3a2b7c8d4e.pdf',
    'tenant_id=3fa85f64-5717-4562-b3fc-2c963f66afa6',
    '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    'node_network_receive_bytes_total',
    'container_memory_working_set_bytes is not a valid selector',
    'apiserver_request_duration_seconds_bucket has no data',
    'kube_pod_container_status_waiting_reason',
    'build 356a192b7913b04c54574d18c28d46e6395428ab failed',
    'digest e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'parse error: sum(rate(http_requests_total{job="api"}[5m])) by (le)',
    'datasource Prometheus-Production-EU-West-1 not found',
    'datasource Loki-Production-EU-West-1 unreachable',
    'dashboard Kubernetes-Cluster-Overview-v2 not found',
    'missing header X-Api-Token',
    'Basic authentication failed for this datasource',
    'ConstraintValidationFailed',
    "Role 'license-admin' required",
    'Must not have boards',
    'Unauthorized',
  ];

  it('MEASURED false-positive rate over a legitimate-identifier corpus is ZERO', () => {
    const eaten = IDENTIFIERS.filter((v) => upstreamDetail({ error: { detail: v } }) !== v);
    expect(eaten).toEqual([]);
    expect(IDENTIFIERS.length).toBeGreaterThanOrEqual(23);
  });

  // The already-correct behaviour, re-pinned against the new substring scan.
  it('does not regress the shapes that already worked', () => {
    const stillRedacted = [
      'could not connect to ' + DSN,
      'rejected header Authorization: Bearer abcdefghijklmnop12345 for tenant x',
      "Invalid X-Tenant-Id '" + JWT + "': must be a UUID",
      'provider rejected sk-abcdefghijklmnopqrstuvwx',
      GH_PAT + ' is not valid',
    ];
    for (const v of stillRedacted) {
      expect(upstreamDetail({ error: { detail: v } })).toContain('<redacted>');
    }
  });
});

// ===========================================================================
// D3 — a defect this fix INTRODUCED, found by the same review.
//
// Making `message` variable exposed it to n8n's NodeError.setDescriptiveErrorMessage,
// which REPLACES the whole message when it contains any COMMON_ERRORS code as a
// substring. Both the hint AND the service's words are lost. This was impossible
// before, because the fixed hints contained no such substring.
// ===========================================================================
describe('D3: an upstream body naming a libuv code must not let n8n eat the message', () => {
  const auth = new RetryingRequest();
  const run = (e: any) => auth.executeWithRetry(() => Promise.reject(e), ctx);

  it('n8n really does destroy such a message — the behaviour being defended against', () => {
    const e = new NodeApiError(node as any, { statusCode: 403 } as any, {
      message: 'Access denied: returned EACCES from Loki',
    });
    expect(e.message).toBe('Forbidden by access permissions, make sure you have the right permissions');
    expect(e.message).not.toContain('Loki');
  });

  it('detects the codes that trigger it', () => {
    expect(triggersN8nMessageRewrite('returned EACCES from Loki')).toBe(true);
    expect(triggersN8nMessageRewrite('upstream ETIMEDOUT while querying')).toBe(true);
    expect(triggersN8nMessageRewrite('econnrefused, lower case counts too')).toBe(true);
    expect(triggersN8nMessageRewrite("Role 'license-admin' required")).toBe(false);
    expect(triggersN8nMessageRewrite('Access denied')).toBe(false);
  });

  it('TRIGGER branch: hint survives as .message and the service words move to .description', async () => {
    const e = await run({ statusCode: 403, error: { detail: 'returned EACCES from Loki' } }).catch((x) => x);
    // n8n leaves the bare hint alone, so the operator still gets a real message...
    expect(e.message).toBe('Access denied');
    expect(e.message).not.toBe('Forbidden by access permissions, make sure you have the right permissions');
    // ...and the service's own words survive on description instead of being erased.
    expect(e.description).toContain('returned EACCES from Loki');
  });

  it('TRIGGER branch, ETIMEDOUT — the second measured case', async () => {
    const e = await run({ statusCode: 401, error: { detail: 'upstream ETIMEDOUT while querying Loki' } }).catch((x) => x);
    expect(e.message).toBe('Authentication failed');
    expect(e.message).not.toContain('consider setting');
    expect(e.description).toContain('upstream ETIMEDOUT while querying Loki');
  });

  it('NON-trigger branch is unchanged: the words stay in .message where they belong', async () => {
    const e = await run({ statusCode: 403, error: { detail: "Role 'license-admin' required" } }).catch((x) => x);
    expect(e.message).toBe("Access denied: Role 'license-admin' required");
    expect(e.description).toBe('These credentials do not permit this operation.');
  });

  it('429 gets the same treatment on both branches', async () => {
    const bad = await run({ statusCode: 429, error: { detail: 'backend ENOTFOUND' } }).catch((x) => x);
    expect(bad.message).toBe('Rate limit exceeded');
    expect(bad.description).toContain('ENOTFOUND');
    const ok = await run({ statusCode: 429, error: { detail: 'quota exhausted' } }).catch((x) => x);
    expect(ok.message).toBe('Rate limit exceeded: quota exhausted');
  });

  it('apiErrorOptions never throws, whatever it is handed', () => {
    const circular: any = { detail: {} };
    circular.detail.self = circular.detail;
    for (const e of [undefined, null, 'str', 42, circular, { error: Symbol('s') }]) {
      expect(() => apiErrorOptions('Hint', 'Desc', e)).not.toThrow();
      expect(apiErrorOptions('Hint', 'Desc', e).message.startsWith('Hint')).toBe(true);
    }
  });
});
