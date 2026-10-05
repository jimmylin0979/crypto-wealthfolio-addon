import type { NetworkRequest, NetworkResponse } from "@wealthfolio/addon-sdk";

import { hmacSha256Hex } from "../signing";
import { hasPositiveBalance } from "./balances";
import type {
  ExchangeBalance,
  ExchangeClient,
  ExchangeCredentials,
  NetworkRequestFn,
} from "./types";

const PIONEX_HOST = "https://api.pionex.com";
const BALANCES_PATH = "/api/v1/account/balances";

/**
 * Build the signed `GET /api/v1/account/balances` request for `timestamp`.
 *
 * Pionex prehash: `GET` + path + `?` + queryString (no space, query encoded as
 * sent). With no other query parameters the string is exactly
 * `GET/api/v1/account/balances?timestamp=<ms>`.
 */
export function buildBalanceRequest(
  credentials: ExchangeCredentials,
  timestamp: number,
): NetworkRequest {
  const queryString = `timestamp=${timestamp}`;
  const prehash = `GET${BALANCES_PATH}?${queryString}`;
  const signature = hmacSha256Hex(prehash, credentials.apiSecret);

  return {
    url: `${PIONEX_HOST}${BALANCES_PATH}?${queryString}`,
    method: "GET",
    headers: {
      "PIONEX-KEY": credentials.apiKey,
      "PIONEX-SIGNATURE": signature,
    },
  };
}

/**
 * Fetch balances from Pionex. The endpoint reports spot balances only — bot
 * and earn funds are excluded by the exchange.
 */
export async function fetchBalances(
  request: NetworkRequestFn,
  credentials: ExchangeCredentials,
  timestamp: number,
): Promise<ExchangeBalance[]> {
  const response = await request(buildBalanceRequest(credentials, timestamp));
  const rows = extractRows(parsePionexResponse(response));

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
function parsePionexResponse(response: NetworkResponse): unknown {
  if (response.status !== 200) {
    throw new Error(
      `Pionex API request failed: HTTP ${response.status} ${errorDetail(response.body)}`,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(response.body);
  } catch {
    throw new Error("Pionex API returned a body that is not valid JSON");
  }

  const succeeded =
    typeof payload === "object" &&
    payload !== null &&
    "result" in payload &&
    payload.result === true;
  if (!succeeded) {
    throw new Error(`Pionex API request failed: ${errorDetail(response.body)}`);
  }
  return payload;
}

/** Describe an error body as Pionex `code`/`message`, falling back to the raw body. */
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
    "code" in payload &&
    "message" in payload
  ) {
    return `code=${String(payload.code)} message=${String(payload.message)}`;
  }
  return body;
}

/** Rows: `data.balances[]`. Anything unexpected is empty. */
function extractRows(payload: unknown): unknown[] {
  if (typeof payload !== "object" || payload === null || !("data" in payload)) {
    return [];
  }
  const data: unknown = payload.data;
  if (typeof data !== "object" || data === null || !("balances" in data)) {
    return [];
  }
  const balances: unknown = data.balances;
  if (!Array.isArray(balances)) {
    return [];
  }
  return balances;
}

/** `free` + `frozen` adds up to the reported total with no subtraction needed. */
function toBalance(value: unknown): ExchangeBalance | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("coin" in value) ||
    typeof value.coin !== "string" ||
    !("free" in value) ||
    typeof value.free !== "string" ||
    !("frozen" in value) ||
    typeof value.frozen !== "string"
  ) {
    return null;
  }
  return { asset: value.coin, free: value.free, locked: value.frozen };
}

export const pionexClient: ExchangeClient = {
  id: "pionex",
  fetchBalances: (request, credentials) => fetchBalances(request, credentials, Date.now()),
};
