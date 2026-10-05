import type { NetworkRequest, NetworkResponse } from "@wealthfolio/addon-sdk";

import { hmacSha256Base64 } from "../signing";
import { hasPositiveBalance } from "./balances";
import type {
  ExchangeBalance,
  ExchangeClient,
  ExchangeCredentials,
  NetworkRequestFn,
} from "./types";

const OKX_HOST = "https://www.okx.com";
const TRADING_BALANCE_PATH = "/api/v5/account/balance";
const FUNDING_BALANCE_PATH = "/api/v5/asset/balances";
const SAVINGS_BALANCE_PATH = "/api/v5/finance/savings/balance";

interface OkxBalanceRequests {
  trading: NetworkRequest;
  funding: NetworkRequest;
  savings: NetworkRequest;
}

/**
 * Build the three signed OKX balance requests (trading + funding + savings)
 * from one millisecond timestamp. The secret is used only as the HMAC key; the
 * passphrase travels only in its dedicated header.
 */
export function buildBalanceRequests(
  credentials: ExchangeCredentials,
  timestamp: number,
): OkxBalanceRequests {
  const passphrase = credentials.passphrase;
  if (!passphrase) {
    throw new Error("OKX API passphrase is missing");
  }
  const isoTimestamp = new Date(timestamp).toISOString();

  const signedGet = (path: string): NetworkRequest => ({
    url: `${OKX_HOST}${path}`,
    method: "GET",
    headers: {
      "OK-ACCESS-KEY": credentials.apiKey,
      "OK-ACCESS-SIGN": hmacSha256Base64(credentials.apiSecret, `${isoTimestamp}GET${path}`),
      "OK-ACCESS-TIMESTAMP": isoTimestamp,
      "OK-ACCESS-PASSPHRASE": passphrase,
    },
  });

  return {
    trading: signedGet(TRADING_BALANCE_PATH),
    funding: signedGet(FUNDING_BALANCE_PATH),
    savings: signedGet(SAVINGS_BALANCE_PATH),
  };
}

/**
 * Fetch trading (`/api/v5/account/balance`), funding
 * (`/api/v5/asset/balances`) and Simple Earn flexible savings
 * (`/api/v5/finance/savings/balance`) balances and merge all three row sets;
 * duplicate ccys are left for the shared mapping to sum. Savings rows are
 * additive, not overlapping: OKX debits subscribed savings out of the funding
 * account into a separate Earn account (docs: "Only the assets in the funding
 * account can be used for saving"; asset valuation reports `funding` and
 * `earn` as distinct buckets), so the same ccy can legitimately appear in both
 * the funding and savings responses with disjoint amounts. Bot/strategy funds
 * need no extra request: OKX reports them inside the trading response
 * (`stgyEq` sits within `frozenBal`, verified against the live API) — merging
 * `tradingBot` rows here would double-count them.
 */
export async function fetchBalances(
  request: NetworkRequestFn,
  credentials: ExchangeCredentials,
  timestamp: number,
): Promise<ExchangeBalance[]> {
  const { trading, funding, savings } = buildBalanceRequests(credentials, timestamp);
  const [tradingResponse, fundingResponse, savingsResponse] = await Promise.all([
    request(trading),
    request(funding),
    request(savings),
  ]);

  const rows = [
    ...extractTradingRows(parseOkxResponse(tradingResponse)),
    ...extractDataRows(parseOkxResponse(fundingResponse)),
    ...extractDataRows(parseOkxResponse(savingsResponse)),
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
function parseOkxResponse(response: NetworkResponse): unknown {
  if (response.status !== 200) {
    throw new Error(
      `OKX API request failed: HTTP ${response.status} ${errorDetail(response.body)}`,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(response.body);
  } catch {
    throw new Error("OKX API returned a body that is not valid JSON");
  }

  const succeeded =
    typeof payload === "object" && payload !== null && "code" in payload && payload.code === "0";
  if (!succeeded) {
    throw new Error(`OKX API request failed: ${errorDetail(response.body)}`);
  }
  return payload;
}

/** Describe an error body as OKX `code`/`msg`, falling back to the raw body. */
function errorDetail(body: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return body;
  }
  if (typeof payload === "object" && payload !== null && "code" in payload && "msg" in payload) {
    return `code=${String(payload.code)} msg=${String(payload.msg)}`;
  }
  return body;
}

/** Trading rows: `data[0].details[]`. Anything unexpected is empty. */
function extractTradingRows(payload: unknown): unknown[] {
  if (typeof payload !== "object" || payload === null || !("data" in payload)) {
    return [];
  }
  const data: unknown = payload.data;
  if (!Array.isArray(data)) {
    return [];
  }
  const first: unknown = data[0];
  if (typeof first !== "object" || first === null || !("details" in first)) {
    return [];
  }
  const details: unknown = first.details;
  if (!Array.isArray(details)) {
    return [];
  }
  return details;
}

/** Funding and savings rows: `data[]`. */
function extractDataRows(payload: unknown): unknown[] {
  if (typeof payload !== "object" || payload === null || !("data" in payload)) {
    return [];
  }
  const data: unknown = payload.data;
  if (!Array.isArray(data)) {
    return [];
  }
  return data;
}

/**
 * Split a row into free/locked when the API reports both; otherwise fall back
 * to the total in `free` with `locked` at zero so `free + locked` still equals
 * the row's total. Savings rows carry their total in `amt` (the amount held in
 * Simple Earn, principal plus accrued earnings) instead of `bal`.
 */
function toBalance(value: unknown): ExchangeBalance | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("ccy" in value) ||
    typeof value.ccy !== "string"
  ) {
    return null;
  }
  const asset = value.ccy;

  const free =
    "availBal" in value && typeof value.availBal === "string" ? value.availBal : undefined;
  const locked =
    "frozenBal" in value && typeof value.frozenBal === "string" ? value.frozenBal : undefined;
  if (free !== undefined && locked !== undefined) {
    return { asset, free, locked };
  }

  if ("bal" in value && typeof value.bal === "string") {
    return { asset, free: value.bal, locked: "0" };
  }
  if ("amt" in value && typeof value.amt === "string") {
    return { asset, free: value.amt, locked: "0" };
  }

  const total = free ?? locked;
  if (total === undefined) {
    return null;
  }
  return { asset, free: total, locked: "0" };
}

export const okxClient: ExchangeClient = {
  id: "okx",
  fetchBalances: (request, credentials) => fetchBalances(request, credentials, Date.now()),
};
