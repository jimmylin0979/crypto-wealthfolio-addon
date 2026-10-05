import type { NetworkRequest, NetworkResponse } from "@wealthfolio/addon-sdk";

import { hmacSha256Hex } from "../signing";
import { hasPositiveBalance } from "./balances";
import type {
  ExchangeBalance,
  ExchangeClient,
  ExchangeCredentials,
  NetworkRequestFn,
} from "./types";

const BYBIT_HOST = "https://api.bybit.com";
const RECV_WINDOW = "5000";
const UNIFIED_WALLET_TARGET = "/v5/account/wallet-balance?accountType=UNIFIED";
const FUND_COINS_TARGET = "/v5/asset/transfer/query-account-coins-balance?accountType=FUND";

interface BybitBalanceRequests {
  unified: NetworkRequest;
  fund: NetworkRequest;
}

export function buildBalanceRequests(
  credentials: ExchangeCredentials,
  timestamp: number,
): BybitBalanceRequests {
  return {
    unified: signedGet(credentials, timestamp, UNIFIED_WALLET_TARGET),
    fund: signedGet(credentials, timestamp, FUND_COINS_TARGET),
  };
}

/**
 * Bybit GET prehash: `timestamp + apiKey + recvWindow + queryString` — no HTTP
 * method and no leading `?`. The query string is derived from the same target
 * string the URL uses, so the signature always covers what is actually sent.
 */
function signedGet(
  credentials: ExchangeCredentials,
  timestamp: number,
  target: string,
): NetworkRequest {
  const separator = target.indexOf("?");
  const queryString = separator === -1 ? "" : target.slice(separator + 1);
  const prehash = `${timestamp}${credentials.apiKey}${RECV_WINDOW}${queryString}`;
  const signature = hmacSha256Hex(prehash, credentials.apiSecret);

  return {
    url: `${BYBIT_HOST}${target}`,
    method: "GET",
    headers: {
      "X-BAPI-API-KEY": credentials.apiKey,
      "X-BAPI-TIMESTAMP": String(timestamp),
      "X-BAPI-SIGN": signature,
      "X-BAPI-RECV-WINDOW": RECV_WINDOW,
    },
  };
}

/**
 * Fetch UNIFIED wallet and FUND coin balances and merge both row sets;
 * duplicate coins are left for the shared mapping to sum.
 */
export async function fetchBalances(
  request: NetworkRequestFn,
  credentials: ExchangeCredentials,
  timestamp: number,
): Promise<ExchangeBalance[]> {
  const { unified, fund } = buildBalanceRequests(credentials, timestamp);
  const [unifiedResponse, fundResponse] = await Promise.all([request(unified), request(fund)]);

  const rows = [
    ...extractUnifiedRows(parseBybitResponse(unifiedResponse)),
    ...extractFundRows(parseBybitResponse(fundResponse)),
  ];

  const balances: ExchangeBalance[] = [];
  for (const row of rows) {
    const balance = toBalance(row);
    if (balance !== null && hasPositiveBalance(balance)) {
      balances.push(balance);
    }
  }
  return balances;
}

/** Boundary parse: throws on HTTP or API-level failure, returns the payload. */
function parseBybitResponse(response: NetworkResponse): unknown {
  if (response.status !== 200) {
    throw new Error(
      `Bybit API request failed: HTTP ${response.status} ${errorDetail(response.body)}`,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(response.body);
  } catch {
    throw new Error("Bybit API returned a body that is not valid JSON");
  }

  const succeeded =
    typeof payload === "object" &&
    payload !== null &&
    "retCode" in payload &&
    payload.retCode === 0;
  if (!succeeded) {
    throw new Error(`Bybit API request failed: ${errorDetail(response.body)}`);
  }
  return payload;
}

/** Describe an error body as Bybit `retCode`/`retMsg`, falling back to the raw body. */
function errorDetail(body: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return body;
  }
  if (
    typeof payload === "object" &&
    payload !== null &&
    "retCode" in payload &&
    "retMsg" in payload
  ) {
    return `retCode=${String(payload.retCode)} retMsg=${String(payload.retMsg)}`;
  }
  return body;
}

/** UNIFIED rows: `result.list[0].coin[]`. Anything unexpected is empty. */
function extractUnifiedRows(payload: unknown): unknown[] {
  if (typeof payload !== "object" || payload === null || !("result" in payload)) {
    return [];
  }
  const result: unknown = payload.result;
  if (typeof result !== "object" || result === null || !("list" in result)) {
    return [];
  }
  const list: unknown = result.list;
  if (!Array.isArray(list)) {
    return [];
  }
  const first: unknown = list[0];
  if (typeof first !== "object" || first === null || !("coin" in first)) {
    return [];
  }
  const coins: unknown = first.coin;
  if (!Array.isArray(coins)) {
    return [];
  }
  return coins;
}

/** FUND rows: `result.balance[]`. */
function extractFundRows(payload: unknown): unknown[] {
  if (typeof payload !== "object" || payload === null || !("result" in payload)) {
    return [];
  }
  const result: unknown = payload.result;
  if (typeof result !== "object" || result === null || !("balance" in result)) {
    return [];
  }
  const balance: unknown = result.balance;
  if (!Array.isArray(balance)) {
    return [];
  }
  return balance;
}

/**
 * `walletBalance` already includes `locked`, so the whole total goes into
 * `free` with `locked` at zero: `free + locked` equals the reported total
 * without needing subtraction.
 */
function toBalance(value: unknown): ExchangeBalance | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("coin" in value) ||
    typeof value.coin !== "string" ||
    !("walletBalance" in value) ||
    typeof value.walletBalance !== "string"
  ) {
    return null;
  }
  return { asset: value.coin, free: value.walletBalance, locked: "0" };
}

export const bybitClient: ExchangeClient = {
  id: "bybit",
  fetchBalances: (request, credentials) => fetchBalances(request, credentials, Date.now()),
};
