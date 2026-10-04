import type { NetworkRequest, NetworkResponse } from '@wealthfolio/addon-sdk';

import { hmacSha256Hex } from './signing';

export { hmacSha256Hex };

export interface BinanceBalance {
  asset: string;
  free: string;
  locked: string;
}

const ACCOUNT_URL = 'https://api.binance.com/api/v3/account';
const RECV_WINDOW_MS = 5000;

/**
 * Fetch spot account balances from Binance via the HMAC-SHA256 signed
 * `GET /api/v3/account` endpoint.
 *
 * The secret is used only as the HMAC key and never appears in the URL,
 * headers, or error messages.
 */
export async function fetchAccountBalances(
  request: (req: NetworkRequest) => Promise<NetworkResponse>,
  apiKey: string,
  apiSecret: string,
): Promise<BinanceBalance[]> {
  const query = `timestamp=${Date.now()}&recvWindow=${RECV_WINDOW_MS}`;
  const signature = hmacSha256Hex(query, apiSecret);

  const response = await request({
    url: `${ACCOUNT_URL}?${query}&signature=${signature}`,
    method: 'GET',
    headers: { 'X-MBX-APIKEY': apiKey },
  });

  if (response.status !== 200) {
    throw new Error(
      `Binance API request failed: HTTP ${response.status} ${errorDetail(response.body)}`,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(response.body);
  } catch {
    throw new Error('Binance API returned a body that is not valid JSON');
  }

  return parseBalances(payload).filter(hasPositiveBalance);
}

/** Describe an error body as Binance `code`/`msg`, falling back to the raw body. */
function errorDetail(body: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return body;
  }
  if (typeof payload === 'object' && payload !== null && 'code' in payload && 'msg' in payload) {
    return `code=${String(payload.code)} msg=${String(payload.msg)}`;
  }
  return body;
}

/** Boundary parse: the JSON body becomes typed balances; anything else is empty. */
function parseBalances(payload: unknown): BinanceBalance[] {
  if (typeof payload !== 'object' || payload === null || !('balances' in payload)) {
    return [];
  }
  const entries: unknown = payload.balances;
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.filter(isBalanceEntry);
}

function isBalanceEntry(value: unknown): value is BinanceBalance {
  return (
    typeof value === 'object' &&
    value !== null &&
    'asset' in value &&
    typeof value.asset === 'string' &&
    'free' in value &&
    typeof value.free === 'string' &&
    'locked' in value &&
    typeof value.locked === 'string'
  );
}

/**
 * Zero balances share the response with funded ones; only funded assets are
 * useful downstream. The sum is filtering only — the original decimal strings
 * are preserved on the returned objects.
 */
function hasPositiveBalance(balance: BinanceBalance): boolean {
  return Number(balance.free) + Number(balance.locked) > 0;
}
