import type { NetworkRequest, NetworkResponse } from '@wealthfolio/addon-sdk';
import { describe, expect, it } from 'vitest';

import { fetchAccountBalances, hmacSha256Hex } from './client';

const API_KEY = 'test-api-key';
const API_SECRET = 'test-api-secret';

function respondWith(response: NetworkResponse): {
  request: (req: NetworkRequest) => Promise<NetworkResponse>;
  sent: NetworkRequest[];
} {
  const sent: NetworkRequest[] = [];
  const request = async (req: NetworkRequest): Promise<NetworkResponse> => {
    sent.push(req);
    return response;
  };
  return { request, sent };
}

describe('hmacSha256Hex', () => {
  it('matches RFC 4231 test case 1', () => {
    // key = 0x0b repeated 20 times, data = "Hi There"
    expect(hmacSha256Hex('Hi There', '\x0b'.repeat(20))).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
  });

  it('matches RFC 4231 test case 2', () => {
    expect(hmacSha256Hex('what do ya want for nothing?', 'Jefe')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });
});

describe('fetchAccountBalances', () => {
  it('signs the query in the documented order and returns only funded balances', async () => {
    const { request, sent } = respondWith({
      status: 200,
      headers: {},
      body: JSON.stringify({
        balances: [
          { asset: 'BTC', free: '0.00000001', locked: '0.00000000' },
          { asset: 'ETH', free: '0.00000000', locked: '0.00000000' },
          { asset: 'USDT', free: '12.50000000', locked: '3.25000000' },
          { asset: 'SOL', free: '0.00000000', locked: '2.00000000' },
        ],
      }),
    });

    const balances = await fetchAccountBalances(request, API_KEY, API_SECRET);

    // Zero balances are dropped; original decimal strings are preserved.
    expect(balances).toEqual([
      { asset: 'BTC', free: '0.00000001', locked: '0.00000000' },
      { asset: 'USDT', free: '12.50000000', locked: '3.25000000' },
      { asset: 'SOL', free: '0.00000000', locked: '2.00000000' },
    ]);

    const [sentRequest] = sent;
    expect(sentRequest.method).toBe('GET');
    expect(sentRequest.headers).toEqual({ 'X-MBX-APIKEY': API_KEY });

    const url = new URL(sentRequest.url);
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://api.binance.com/api/v3/account',
    );

    const timestamp = url.searchParams.get('timestamp');
    expect(timestamp).toMatch(/^\d+$/);
    expect(url.searchParams.get('recvWindow')).toBe('5000');

    // The signature covers exactly `timestamp=...&recvWindow=5000`, in that order.
    const signedPayload = `timestamp=${timestamp}&recvWindow=5000`;
    expect(url.search.slice(1)).toBe(
      `${signedPayload}&signature=${hmacSha256Hex(signedPayload, API_SECRET)}`,
    );

    // The secret must never travel with the request.
    expect(sentRequest.url).not.toContain(API_SECRET);
    expect(JSON.stringify(sentRequest.headers)).not.toContain(API_SECRET);
  });

  it('throws with the HTTP status, Binance code, and message on error responses', async () => {
    const { request } = respondWith({
      status: 401,
      headers: {},
      body: JSON.stringify({ code: -1022, msg: 'Signature for this request is not valid.' }),
    });

    const caught: unknown = await fetchAccountBalances(request, API_KEY, API_SECRET).catch(
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain('HTTP 401');
    expect(message).toContain('-1022');
    expect(message).toContain('Signature for this request is not valid');
    expect(message).not.toContain(API_SECRET);
  });

  it('returns an empty list when the body has no balances array', async () => {
    const { request } = respondWith({
      status: 200,
      headers: {},
      body: JSON.stringify({ makerCommission: 10, takerCommission: 10 }),
    });

    await expect(fetchAccountBalances(request, API_KEY, API_SECRET)).resolves.toEqual([]);
  });

  it('returns an empty list when balances is an empty array', async () => {
    const { request } = respondWith({
      status: 200,
      headers: {},
      body: JSON.stringify({ balances: [] }),
    });

    await expect(fetchAccountBalances(request, API_KEY, API_SECRET)).resolves.toEqual([]);
  });

  it('throws a clear error when a 200 body is not valid JSON', async () => {
    const { request } = respondWith({ status: 200, headers: {}, body: '<html>gateway error</html>' });

    await expect(fetchAccountBalances(request, API_KEY, API_SECRET)).rejects.toThrow(
      /not valid JSON/,
    );
  });
});
