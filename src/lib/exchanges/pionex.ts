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
const BOT_ORDERS_PATH = "/api/v1/bot/orders";
// The list endpoint is paginated; an unexpected runaway (or an API change that
// never terminates the page chain) must fail loudly rather than loop forever.
const MAX_BOT_PAGES = 20;
const BOT_PERMISSION_HINT = 'the "Bot reading" API permission is required for bot orders';

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
 * Build the signed `GET /api/v1/bot/orders` request for running spot-grid bots.
 * Query params travel alphabetically (`buOrderTypes`, `pageToken`, `status`,
 * `timestamp`) and the prehash covers the query exactly as sent.
 */
export function buildBotOrdersRequest(
  credentials: ExchangeCredentials,
  timestamp: number,
  pageToken?: string,
): NetworkRequest {
  const tokenPart = pageToken === undefined ? "" : `pageToken=${encodeURIComponent(pageToken)}&`;
  const queryString = `buOrderTypes=spot_grid&${tokenPart}status=running&timestamp=${timestamp}`;
  const prehash = `GET${BOT_ORDERS_PATH}?${queryString}`;
  const signature = hmacSha256Hex(prehash, credentials.apiSecret);

  return {
    url: `${PIONEX_HOST}${BOT_ORDERS_PATH}?${queryString}`,
    method: "GET",
    headers: {
      "PIONEX-KEY": credentials.apiKey,
      "PIONEX-SIGNATURE": signature,
    },
  };
}

/**
 * Fetch spot balances and running spot-grid bot holdings. The plain balance
 * endpoint explicitly excludes bot funds, so both row sets are returned side
 * by side — the shared mapping sums duplicates per asset.
 */
export async function fetchBalances(
  request: NetworkRequestFn,
  credentials: ExchangeCredentials,
  timestamp: number,
): Promise<ExchangeBalance[]> {
  const [balanceResponse, botBalances] = await Promise.all([
    request(buildBalanceRequest(credentials, timestamp)),
    fetchBotBalances(request, credentials, timestamp),
  ]);

  const balances: ExchangeBalance[] = [];
  for (const row of extractRows(parsePionexResponse(balanceResponse))) {
    const balance = toBalance(row);
    if (balance !== null && hasPositiveBalance(balance)) {
      balances.push(balance);
    }
  }
  return [...balances, ...botBalances];
}

/** Walk the paginated bot-order list and convert each order's holdings. */
async function fetchBotBalances(
  request: NetworkRequestFn,
  credentials: ExchangeCredentials,
  timestamp: number,
): Promise<ExchangeBalance[]> {
  const balances: ExchangeBalance[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_BOT_PAGES; page += 1) {
    const response = await request(buildBotOrdersRequest(credentials, timestamp, pageToken));
    const { results, nextPageToken } = extractBotPage(
      parsePionexResponse(response, "bot orders", BOT_PERMISSION_HINT),
    );

    for (const result of results) {
      for (const balance of toBotBalances(result)) {
        if (hasPositiveBalance(balance)) {
          balances.push(balance);
        }
      }
    }

    if (nextPageToken === undefined) {
      return balances;
    }
    pageToken = nextPageToken;
  }

  throw new Error(`Pionex bot orders exceeded ${MAX_BOT_PAGES} pages without finishing`);
}

/** Boundary parse: throws on HTTP or API-level failure, returns the payload. */
function parsePionexResponse(response: NetworkResponse, subject = "API", hint?: string): unknown {
  const suffix = hint === undefined ? "" : ` (${hint})`;
  if (response.status !== 200) {
    throw new Error(
      `Pionex ${subject} request failed: HTTP ${response.status} ${errorDetail(response.body)}${suffix}`,
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
    throw new Error(`Pionex ${subject} request failed: ${errorDetail(response.body)}${suffix}`);
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

/** Bot list page: `data.results[]` plus the next-page token when present. */
function extractBotPage(payload: unknown): {
  results: unknown[];
  nextPageToken?: string;
} {
  if (typeof payload !== "object" || payload === null || !("data" in payload)) {
    return { results: [] };
  }
  const data: unknown = payload.data;
  if (typeof data !== "object" || data === null) {
    return { results: [] };
  }
  const results = "results" in data && Array.isArray(data.results) ? data.results : [];
  const token =
    "nextPageToken" in data && typeof data.nextPageToken === "string" && data.nextPageToken !== ""
      ? data.nextPageToken
      : undefined;
  return token === undefined ? { results } : { results, nextPageToken: token };
}

/**
 * One bot order → its current holdings rows. `gridProfit` is deliberately not
 * added: docs state it is already reflected in `quoteAmount`, so including it
 * would double-count. Orders without a usable `buOrderData` are skipped.
 */
function toBotBalances(result: unknown): ExchangeBalance[] {
  if (typeof result !== "object" || result === null) {
    return [];
  }
  if (!("base" in result) || typeof result.base !== "string" || result.base === "") {
    return [];
  }
  if (!("quote" in result) || typeof result.quote !== "string" || result.quote === "") {
    return [];
  }
  if (!("buOrderData" in result)) {
    return [];
  }
  const orderData: unknown = result.buOrderData;
  if (typeof orderData !== "object" || orderData === null) {
    return [];
  }

  const balances: ExchangeBalance[] = [];
  if ("baseAmount" in orderData && typeof orderData.baseAmount === "string") {
    balances.push({ asset: result.base, free: "0", locked: orderData.baseAmount });
  }
  if ("quoteAmount" in orderData && typeof orderData.quoteAmount === "string") {
    balances.push({ asset: result.quote, free: "0", locked: orderData.quoteAmount });
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
