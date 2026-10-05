import type { NetworkRequest, NetworkResponse } from "@wealthfolio/addon-sdk";
import { describe, expect, it, vi } from "vitest";

import { fetchBalances, pionexClient } from "./pionex";
import type { ExchangeCredentials } from "./types";

const API_KEY = "test-api-key";
const API_SECRET = "test-api-secret";
const CREDENTIALS: ExchangeCredentials = { apiKey: API_KEY, apiSecret: API_SECRET };
const TIMESTAMP = 1712345678901;
// HMAC-SHA256 of `GET/api/v1/account/balances?timestamp=1712345678901` with
// API_SECRET (method concatenated with the path, no space, no other query).
const SIGNATURE = "b26f1d2ce3bc243247d717316097c19c69dcf034bba8802ad3c7164242193ef5";
// Same scheme over the bot-orders prehash (query params alphabetically sorted,
// page 1 without / page 2 with `pageToken=page2`).
const BOT_SIGNATURE = "f431c88f225baebfdc1db2b2423204045d834f08b40836e196738671f420659b";
const BOT_PAGE2_SIGNATURE = "d7d3ad67ea79194ad34e2b0e0a112bf25cfb5bd78ff729d8fbefc833e25e2907";

const PATH = "/api/v1/account/balances";
const BOT_PATH = "/api/v1/bot/orders";
const BOT_URL = `https://api.pionex.com${BOT_PATH}?buOrderTypes=spot_grid&status=running&timestamp=${TIMESTAMP}`;

function respondWith(routes: Record<string, NetworkResponse>): {
  request: (req: NetworkRequest) => Promise<NetworkResponse>;
  sent: NetworkRequest[];
} {
  const sent: NetworkRequest[] = [];
  const request = async (req: NetworkRequest): Promise<NetworkResponse> => {
    sent.push(req);
    const response = routes[new URL(req.url).pathname];
    if (!response) {
      throw new Error(`Unexpected request URL: ${req.url}`);
    }
    return response;
  };
  return { request, sent };
}

function pionexSuccess(body: unknown): NetworkResponse {
  return { status: 200, headers: {}, body: JSON.stringify(body) };
}

const SUCCESS_RESPONSE = pionexSuccess({
  result: true,
  data: {
    balances: [
      { coin: "USDT", free: "100.5", frozen: "0.5" },
      { coin: "BTC", free: "0.5", frozen: "0" },
      { coin: "XRP", free: "0", frozen: "0" },
    ],
  },
});

const EMPTY_BOT_RESPONSE = pionexSuccess({ result: true, data: { results: [] } });

describe("fetchBalances", () => {
  it("signs both requests with the injected timestamp and converts free/frozen rows", async () => {
    const { request, sent } = respondWith({
      [PATH]: SUCCESS_RESPONSE,
      [BOT_PATH]: EMPTY_BOT_RESPONSE,
    });

    const balances = await fetchBalances(request, CREDENTIALS, TIMESTAMP);

    expect(sent).toHaveLength(2);
    const [req, botReq] = sent;
    expect(req.method).toBe("GET");
    expect(req.url).toBe(`https://api.pionex.com${PATH}?timestamp=${TIMESTAMP}`);
    expect(req.headers).toEqual({
      "PIONEX-KEY": API_KEY,
      "PIONEX-SIGNATURE": SIGNATURE,
    });

    expect(botReq?.url).toBe(BOT_URL);
    expect(botReq?.headers).toEqual({
      "PIONEX-KEY": API_KEY,
      "PIONEX-SIGNATURE": BOT_SIGNATURE,
    });

    // The secret never travels with the request.
    expect(JSON.stringify(sent)).not.toContain(API_SECRET);

    // free + frozen equals the reported total; zero totals are skipped.
    expect(balances).toEqual([
      { asset: "USDT", free: "100.5", locked: "0.5" },
      { asset: "BTC", free: "0.5", locked: "0" },
    ]);
  });

  it("merges running spot-grid bot holdings and excludes gridProfit", async () => {
    const { request, sent } = respondWith({
      [PATH]: SUCCESS_RESPONSE,
      [BOT_PATH]: pionexSuccess({
        result: true,
        data: {
          results: [
            {
              base: "BTC",
              quote: "USDT",
              buOrderData: { baseAmount: "0.01", quoteAmount: "10", gridProfit: "0.5" },
            },
            { base: "ETH", quote: "USDT" },
            {
              base: "SOL",
              quote: "USDT",
              buOrderData: { baseAmount: "0", quoteAmount: "0" },
            },
          ],
        },
      }),
    });

    const balances = await fetchBalances(request, CREDENTIALS, TIMESTAMP);

    expect(sent).toHaveLength(2);
    // gridProfit ("0.5") is already inside quoteAmount, so USDT locked stays "10".
    expect(balances).toEqual([
      { asset: "USDT", free: "100.5", locked: "0.5" },
      { asset: "BTC", free: "0.5", locked: "0" },
      { asset: "BTC", free: "0", locked: "0.01" },
      { asset: "USDT", free: "0", locked: "10" },
    ]);
  });

  it("walks the bot-order pages, signing each page's own query", async () => {
    const sent: NetworkRequest[] = [];
    const request = async (req: NetworkRequest): Promise<NetworkResponse> => {
      sent.push(req);
      const url = new URL(req.url);
      if (url.pathname === PATH) {
        return SUCCESS_RESPONSE;
      }
      if (url.searchParams.get("pageToken") === null) {
        return pionexSuccess({
          result: true,
          data: {
            results: [
              { base: "BTC", quote: "USDT", buOrderData: { baseAmount: "0.01", quoteAmount: "0" } },
            ],
            nextPageToken: "page2",
          },
        });
      }
      return pionexSuccess({
        result: true,
        data: {
          results: [
            { base: "ETH", quote: "USDT", buOrderData: { baseAmount: "0.5", quoteAmount: "0" } },
          ],
        },
      });
    };

    const balances = await fetchBalances(request, CREDENTIALS, TIMESTAMP);

    expect(sent).toHaveLength(3);
    const [, page1, page2] = sent;
    expect(page1?.url).toBe(BOT_URL);
    expect(page1?.headers?.["PIONEX-SIGNATURE"]).toBe(BOT_SIGNATURE);
    expect(page2?.url).toBe(
      `https://api.pionex.com${BOT_PATH}?buOrderTypes=spot_grid&pageToken=page2&status=running&timestamp=${TIMESTAMP}`,
    );
    expect(page2?.headers?.["PIONEX-SIGNATURE"]).toBe(BOT_PAGE2_SIGNATURE);

    expect(balances).toEqual([
      { asset: "USDT", free: "100.5", locked: "0.5" },
      { asset: "BTC", free: "0.5", locked: "0" },
      { asset: "BTC", free: "0", locked: "0.01" },
      { asset: "ETH", free: "0", locked: "0.5" },
    ]);
  });

  it("stops after the page cap instead of looping forever", async () => {
    const sent: NetworkRequest[] = [];
    let botCalls = 0;
    const request = async (req: NetworkRequest): Promise<NetworkResponse> => {
      sent.push(req);
      if (new URL(req.url).pathname === PATH) {
        return SUCCESS_RESPONSE;
      }
      botCalls += 1;
      return pionexSuccess({
        result: true,
        data: { results: [], nextPageToken: `t${botCalls}` },
      });
    };

    await expect(fetchBalances(request, CREDENTIALS, TIMESTAMP)).rejects.toThrow(
      /exceeded 20 pages/,
    );
    expect(botCalls).toBe(20);
  });

  it("throws with the Bot reading hint when the bot endpoint rejects the key", async () => {
    const { request } = respondWith({
      [PATH]: SUCCESS_RESPONSE,
      [BOT_PATH]: pionexSuccess({ result: false, code: 40300, message: "Permission denied" }),
    });

    const caught: unknown = await fetchBalances(request, CREDENTIALS, TIMESTAMP).catch(
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("40300");
    expect(message).toContain("Permission denied");
    expect(message).toContain("Bot reading");
    expect(message).not.toContain(API_SECRET);
  });

  it("throws with the code and message when result is false", async () => {
    const { request } = respondWith({
      [PATH]: pionexSuccess({ result: false, code: 40001, message: "Invalid signature" }),
      [BOT_PATH]: EMPTY_BOT_RESPONSE,
    });

    const caught: unknown = await fetchBalances(request, CREDENTIALS, TIMESTAMP).catch(
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("40001");
    expect(message).toContain("Invalid signature");
    expect(message).not.toContain(API_SECRET);
  });

  it("throws with the HTTP status on non-200 responses", async () => {
    const { request } = respondWith({
      [PATH]: {
        status: 401,
        headers: {},
        body: JSON.stringify({ result: false, code: 40003, message: "Unauthorized" }),
      },
      [BOT_PATH]: EMPTY_BOT_RESPONSE,
    });

    const caught: unknown = await fetchBalances(request, CREDENTIALS, TIMESTAMP).catch(
      (error: unknown) => error,
    );
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("HTTP 401");
    expect(message).toContain("code=40003");
    expect(message).toContain("Unauthorized");
  });

  it("throws a clear error when a 200 body is not valid JSON", async () => {
    const { request } = respondWith({
      [PATH]: {
        status: 200,
        headers: {},
        body: "<html>gateway error</html>",
      },
      [BOT_PATH]: EMPTY_BOT_RESPONSE,
    });

    await expect(fetchBalances(request, CREDENTIALS, TIMESTAMP)).rejects.toThrow(/not valid JSON/);
  });

  it("returns an empty list when the payload has no balances", async () => {
    const { request } = respondWith({
      [PATH]: pionexSuccess({ result: true, data: {} }),
      [BOT_PATH]: EMPTY_BOT_RESPONSE,
    });

    await expect(fetchBalances(request, CREDENTIALS, TIMESTAMP)).resolves.toEqual([]);
  });

  it("wires the client to sign with the current time", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(TIMESTAMP);
    try {
      const { request, sent } = respondWith({
        [PATH]: pionexSuccess({ result: true, data: { balances: [] } }),
        [BOT_PATH]: EMPTY_BOT_RESPONSE,
      });
      await pionexClient.fetchBalances(request, CREDENTIALS);
      expect(sent[0]?.headers?.["PIONEX-SIGNATURE"]).toBe(SIGNATURE);
      expect(sent[0]?.url).toBe(`https://api.pionex.com${PATH}?timestamp=${TIMESTAMP}`);
      expect(sent[1]?.headers?.["PIONEX-SIGNATURE"]).toBe(BOT_SIGNATURE);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
