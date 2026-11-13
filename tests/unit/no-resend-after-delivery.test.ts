import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as http from 'http';
import type { AddressInfo } from 'net';
import {
	RetryingRequest,
	isIdempotentMethod,
	isPreSendNetworkError,
} from '../../helpers/requestExecution';

/**
 * A request that MAY have reached the server is never re-sent unless it is read-only.
 *
 * RetryingRequest used to re-send ETIMEDOUT, ECONNRESET and socket hang-up
 * for EVERY method, so a write whose response was lost was applied two or three
 * times.
 *
 * Rule now: GET/HEAD/OPTIONS retry on any transient failure and on 5xx; every
 * other method (and a request with no declared method) retries ONLY on
 * ECONNREFUSED or a DNS failure, which prove no byte was sent. No 401 re-send.
 *
 * Measured against a real local HTTP server that COUNTS the requests it receives —
 * the count is the fact, not the number of times requestFn was invoked.
 */

type Mode = 'hang' | 'reset' | 'ok' | 'status';

let server: http.Server;
let port = 0;
const counts: Record<string, number> = {};
let mode: Mode = 'ok';
let statusToSend = 200;

beforeAll(async () => {
	server = http.createServer((req, res) => {
		const key = `${req.method} ${req.url}`;
		counts[key] = (counts[key] ?? 0) + 1;
		if (mode === 'hang') return; // accept, never answer -> client ETIMEDOUT
		if (mode === 'reset') {
			req.socket.destroy(); // delivered, then connection dropped -> ECONNRESET / hang up
			return;
		}
		res.statusCode = mode === 'status' ? statusToSend : 200;
		res.end('{}');
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
	server.closeAllConnections?.();
	await new Promise<void>((r) => server.close(() => r()));
});

/** A requestFn shaped like n8n's: throws an Error carrying `.code` / `.statusCode`. */
function send(method: string, path: string, targetPort = port): () => Promise<unknown> {
	return () =>
		new Promise((resolve, reject) => {
			const req = http.request(
				{ host: '127.0.0.1', port: targetPort, method, path, timeout: 150, agent: false },
				(res) => {
					res.resume();
					res.on('end', () => {
						if ((res.statusCode ?? 0) >= 400) {
							reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode }));
						} else resolve({ ok: true });
					});
				},
			);
			req.on('timeout', () => {
				req.destroy(Object.assign(new Error('timeout of 150ms exceeded'), { code: 'ETIMEDOUT' }));
			});
			req.on('error', reject);
			if (method === 'POST' || method === 'PUT' || method === 'PATCH') req.write('{"a":1}');
			req.end();
		});
}

function auth(): RetryingRequest {
	const a = new RetryingRequest();
	(a as any).RETRY_DELAYS = [5, 5, 5]; // speed only; the attempt cap is unchanged
	return a;
}
const ctx = { getNode: () => ({ name: 'Observability', type: 'n8n-nodes-observability.observability' }) } as any;

let seq = 0;
function freshPath(label: string): string {
	seq += 1;
	return `/${label}-${seq}`;
}

describe('non-idempotent methods are sent exactly once after possible delivery', () => {
	it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s + ETIMEDOUT -> exactly 1 request', async (method) => {
		mode = 'hang';
		const path = freshPath('timeout');
		await expect(auth().executeWithRetry(send(method, path), ctx, { method })).rejects.toMatchObject({
			code: 'ETIMEDOUT',
		});
		expect(counts[`${method} ${path}`]).toBe(1);
	});

	it.each(['POST', 'PATCH'])('%s + connection reset after delivery -> exactly 1 request', async (method) => {
		mode = 'reset';
		const path = freshPath('reset');
		await expect(auth().executeWithRetry(send(method, path), ctx, { method })).rejects.toBeDefined();
		expect(counts[`${method} ${path}`]).toBe(1);
	});

	it.each([503, 504])('POST + %s -> exactly 1 request', async (code) => {
		mode = 'status';
		statusToSend = code;
		const path = freshPath('5xx');
		await expect(auth().executeWithRetry(send('POST', path), ctx, { method: 'POST' })).rejects.toBeDefined();
		expect(counts[`POST ${path}`]).toBe(1);
	});

	it('POST + 504 (no declared method) -> exactly 1 request', async () => {
		mode = 'status';
		statusToSend = 504;
		const path = freshPath('gw');
		await expect(auth().executeWithRetry(send('POST', path), ctx)).rejects.toBeDefined();
		expect(counts[`POST ${path}`]).toBe(1);
	});

	it('POST with NO declared method (fail-safe) + ETIMEDOUT -> exactly 1 request', async () => {
		mode = 'hang';
		const path = freshPath('nomethod');
		await expect(auth().executeWithRetry(send('POST', path), ctx)).rejects.toBeDefined();
		expect(counts[`POST ${path}`]).toBe(1);
	});

	it('POST + 401 -> exactly 1 request (no refresh re-send)', async () => {
		mode = 'status';
		statusToSend = 401;
		const path = freshPath('unauth');
		await expect(auth().executeWithRetry(send('POST', path), ctx, { method: 'POST' })).rejects.toBeDefined();
		expect(counts[`POST ${path}`]).toBe(1);
	});
});

describe('read-only methods still retry', () => {
	it('GET + ETIMEDOUT -> retried to the cap (3 requests)', async () => {
		mode = 'hang';
		const path = freshPath('get-timeout');
		await expect(auth().executeWithRetry(send('GET', path), ctx, { method: 'GET' })).rejects.toMatchObject({
			code: 'ETIMEDOUT',
		});
		expect(counts[`GET ${path}`]).toBe(3);
	});

	it('GET + 503 -> retried (3 requests)', async () => {
		mode = 'status';
		statusToSend = 503;
		const path = freshPath('get-503');
		await expect(auth().executeWithRetry(send('GET', path), ctx, { method: 'GET' })).rejects.toBeDefined();
		expect(counts[`GET ${path}`]).toBe(3);
	});
});

describe('pre-send failures are retried for every method', () => {
	it('POST + ECONNREFUSED -> retried (3 attempts, 0 delivered)', async () => {
		// A port that was bound and released: nothing listens, connect is refused.
		const probe = http.createServer();
		await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
		const deadPort = (probe.address() as AddressInfo).port;
		await new Promise<void>((r) => probe.close(() => r()));

		let attempts = 0;
		const fn = send('POST', '/refused', deadPort);
		await expect(
			auth().executeWithRetry(
				() => {
					attempts += 1;
					return fn();
				},
				ctx,
				{ method: 'POST' },
			),
		).rejects.toMatchObject({ code: 'ECONNREFUSED' });
		expect(attempts).toBe(3);
	});

	it('POST + DNS failure (EAI_AGAIN) -> retried', async () => {
		let attempts = 0;
		await expect(
			auth().executeWithRetry(
				async () => {
					attempts += 1;
					throw Object.assign(new Error('getaddrinfo EAI_AGAIN observability.example.com'), { code: 'EAI_AGAIN' });
				},
				ctx,
				{ method: 'POST' },
			),
		).rejects.toBeDefined();
		expect(attempts).toBe(3);
	});
});

describe('classifiers', () => {
	it('only GET/HEAD/OPTIONS are idempotent', () => {
		for (const m of ['GET', 'head', 'OPTIONS']) expect(isIdempotentMethod(m)).toBe(true);
		for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'TRACE', '', undefined]) {
			expect(isIdempotentMethod(m as any)).toBe(false);
		}
	});

	it.each([
		[{ code: 'ECONNREFUSED' }, true],
		[{ code: 'ENOTFOUND' }, true],
		[{ code: 'EAI_AGAIN' }, true],
		[{ cause: { code: 'ECONNREFUSED' } }, true],
		[{ message: 'connect ECONNREFUSED 10.0.0.1:443' }, true],
		[{ code: 'ETIMEDOUT' }, false],
		[{ code: 'ECONNRESET' }, false],
		[{ code: 'EPIPE' }, false],
		[{ message: 'socket hang up' }, false],
		[{ code: 'ETIMEDOUT', message: 'connect ECONNREFUSED' }, false],
		[{ code: 'ECONNREFUSED', cause: { code: 'ECONNRESET' } }, false],
	])('isPreSendNetworkError(%j) === %s', (err, expected) => {
		expect(isPreSendNetworkError(Object.assign(new Error(''), err))).toBe(expected);
	});
});

describe('every call site declares its method', () => {
	// A missing method is treated as non-idempotent (fail-safe), so a call site that
	// forgets it silently loses GET retries; one that declares the wrong method could
	// re-send a write. Pin: declared method === the method the request sends.
	it('nodes/*/operations/*.ts pass { method } matching the request', () => {
		const fs = require('fs');
		const path = require('path');
		const nodesDir = path.join(__dirname, '../../nodes');
		let checked = 0;
		for (const node of fs.readdirSync(nodesDir)) {
			const opsDir = path.join(nodesDir, node, 'operations');
			if (!fs.existsSync(opsDir)) continue;
			for (const f of fs.readdirSync(opsDir).filter((n: string) => n.endsWith('.ts'))) {
				const src: string = fs.readFileSync(path.join(opsDir, f), 'utf8');
				for (const call of src.split('auth.executeWithRetry(').slice(1)) {
					const reqMethod = /method: "([A-Z]+)"/.exec(call)?.[1];
					const declared = /ctx,\s*\{ method: "([A-Z]+)" \}\s*,?\s*\)/.exec(call)?.[1];
					expect({ file: f, reqMethod, declared }).toEqual({ file: f, reqMethod, declared: reqMethod });
					checked += 1;
				}
			}
		}
		expect(checked).toBeGreaterThan(0);
	});
});
