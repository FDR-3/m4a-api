import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import BN from 'bn.js';
import worker, { buildOraclePricePayload, readResponseErrorMessage } from '../src/index';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Hello World worker', () => {
	it('responds with Hello World! (unit style)', async () => {
		const request = new IncomingRequest('http://example.com');
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
	});

	it('responds with Hello World! (integration style)', async () => {
		const response = await SELF.fetch('https://example.com');
		expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
	});

	it('builds the oracle payload using the IDL field name expected by Anchor', () => {
		const slot = new BN(463969888);
		const data = [
			{ tokenId: 2, normalizedPrice18Decimals: new BN('de0b6b3a7640000', 16) },
			{ tokenId: 1, normalizedPrice18Decimals: new BN('e8d619bfd0') },
		];

		const payload = buildOraclePricePayload(data, slot);

		expect(payload).toEqual({
			data,
			slot,
		});
		expect(Object.keys(payload)).toEqual(['data', 'slot']);
	});

	it('reads a failed response body safely without reusing a consumed stream', async () => {
		const response = new Response(JSON.stringify({ error: 'rate limited' }), {
			status: 429,
			headers: { 'Content-Type': 'application/json' },
		});

		await response.text();

		const errorMessage = await readResponseErrorMessage(response);
		expect(errorMessage).toContain('rate limited');
	});
});
