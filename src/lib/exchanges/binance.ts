import type { NetworkRequest } from "@wealthfolio/addon-sdk";

import { hmacSha256Hex } from "../signing";
import { hasPositiveBalance } from "./balances";
import type {
  ExchangeBalance,
  ExchangeClient,
  ExchangeCredentials,
  NetworkRequestFn,
} from "./types";

const ACCOUNT_URL = "https://api.binance.com/api/v3/account";
const RECV_WINDOW_MS = 5000;

// Simple Earn receipt tokens arrive from /api/v3/account as "LD" + underlying
// (LDUSDT, LDBTC, LDHOME, ...) and have no market price of their own, so they
// are remapped onto the underlying asset. LDO (Lido DAO) is the only real spot
// asset whose name starts with "LD" — verified against the full
// /api/v3/exchangeInfo listing — and must never be stripped.
const REAL_LD_ASSETS: ReadonlySet<string> = new Set(["LDO"]);

function resolveAsset(asset: string): string {
  if (asset.length > 2 && asset.startsWith("LD") && !REAL_LD_ASSETS.has(asset)) {
    return asset.slice(2);
  }
  return asset;
}

/**
 * Build the signed `GET /api/v3/account` request. The secret is used only as
 * the HMAC key and never appears in the URL, headers, or error messages.
 * `timestamp` is injectable so tests stay deterministic.
 */
export function buildAccountRequest(
  credentials: ExchangeCredentials,
  timestamp: number,
): NetworkRequest {
  const query = `timestamp=${timestamp}&recvWindow=${RECV_WINDOW_MS}`;
  const signature = hmacSha256Hex(query, credentials.apiSecret);

  return {
    url: `${ACCOUNT_URL}?${query}&signature=${signature}`,
    method: "GET",
    headers: { "X-MBX-APIKEY": credentials.apiKey },
  };
}

/**
 * Fetch spot account balances via the HMAC-SHA256 signed
 * `GET /api/v3/account` endpoint, with Simple Earn `LD*` receipts resolved to
 * their underlying asset.
 */
export async function fetchBalances(
  request: NetworkRequestFn,
  credentials: ExchangeCredentials,
  timestamp: number,
): Promise<ExchangeBalance[]> {
  const response = await request(buildAccountRequest(credentials, timestamp));

  if (response.status !== 200) {
    throw new Error(
      `Binance API request failed: HTTP ${response.status} ${errorDetail(response.body)}`,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(response.body);
  } catch {
    throw new Error("Binance API returned a body that is not valid JSON");
  }

  return parseBalances(payload)
    .filter(hasPositiveBalance)
    .map((balance) => ({ ...balance, asset: resolveAsset(balance.asset) }));
}

/** Describe an error body as Binance `code`/`msg`, falling back to the raw body. */
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

/** Boundary parse: the JSON body becomes typed balances; anything else is empty. */
function parseBalances(payload: unknown): ExchangeBalance[] {
  if (typeof payload !== "object" || payload === null || !("balances" in payload)) {
    return [];
  }
  const entries: unknown = payload.balances;
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.filter(isBalanceEntry);
}

function isBalanceEntry(value: unknown): value is ExchangeBalance {
  return (
    typeof value === "object" &&
    value !== null &&
    "asset" in value &&
    typeof value.asset === "string" &&
    "free" in value &&
    typeof value.free === "string" &&
    "locked" in value &&
    typeof value.locked === "string"
  );
}

export const binanceClient: ExchangeClient = {
  id: "binance",
  fetchBalances: (request, credentials) => fetchBalances(request, credentials, Date.now()),
};
