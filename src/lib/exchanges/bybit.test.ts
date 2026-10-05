import type { NetworkRequest, NetworkResponse } from "@wealthfolio/addon-sdk";
import { describe, expect, it, vi } from "vitest";

import { bybitClient, fetchBalances } from "./bybit";
import type { ExchangeCredentials } from "./types";

const API_KEY = "test-api-key";
const API_SECRET = "test-api-secret";
const CREDENTIALS: ExchangeCredentials = { apiKey: API_KEY, apiSecret: API_SECRET };
const TIMESTAMP = 1712345678901;
// HMAC-SHA256 of `${TIMESTAMP}${API_KEY}5000<queryString>` with API_SECRET.
const UNIFIED_SIGNATURE = "19b1aff287a2579fd9453330e4bb7cda9c6f6fb6ec97afda85ac4011ca946fc1";
const FUND_SIGNATURE = "2b924f42bbadb0e17a39762dfd6e583870bea2204d85f4d90e9613dccd3c049f";

const UNIFIED_PATH = "/v5/account/wallet-balance";
const FUND_PATH = "/v5/asset/transfer/query-account-coins-balance";

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

function bybitSuccess(body: unknown): NetworkResponse {
  return { status: 200, headers: {}, body: JSON.stringify(body) };
}

const UNIFIED_RESPONSE = bybitSuccess({
  retCode: 0,
  retMsg: "OK",
  result: {
    list: [
      {
        accountType: "UNIFIED",
        coin: [
          { coin: "BTC", walletBalance: "0.5", locked: "0.1" },
          { coin: "ETH", walletBalance: "0", locked: "0" },
          { coin: "USDT", walletBalance: "100.25", locked: "0" },
        ],
      },
    ],
  },
});

const FUND_RESPONSE = bybitSuccess({
  retCode: 0,
  retMsg: "OK",
  result: {
    balance: [
      { coin: "USDT", walletBalance: "10" },
      { coin: "SOL", walletBalance: "0" },
    ],
  },
});

describe("fetchBalances", () => {
  it("signs both requests with the injected timestamp and merges UNIFIED and FUND rows", async () => {
    const { request, sent } = respondWith({
      [UNIFIED_PATH]: UNIFIED_RESPONSE,
      [FUND_PATH]: FUND_RESPONSE,
    });

    const balances = await fetchBalances(request, CREDENTIALS, TIMESTAMP);

    expect(sent).toHaveLength(2);
    const [unified, fund] = sent;
    expect(unified.method).toBe("GET");
    expect(unified.url).toBe(`https://api.bybit.com${UNIFIED_PATH}?accountType=UNIFIED`);
    expect(unified.headers).toEqual({
      "X-BAPI-API-KEY": API_KEY,
      "X-BAPI-TIMESTAMP": String(TIMESTAMP),
      "X-BAPI-SIGN": UNIFIED_SIGNATURE,
      "X-BAPI-RECV-WINDOW": "5000",
    });

    expect(fund.method).toBe("GET");
    expect(fund.url).toBe(`https://api.bybit.com${FUND_PATH}?accountType=FUND`);
    expect(fund.headers).toEqual({
      "X-BAPI-API-KEY": API_KEY,
      "X-BAPI-TIMESTAMP": String(TIMESTAMP),
      "X-BAPI-SIGN": FUND_SIGNATURE,
      "X-BAPI-RECV-WINDOW": "5000",
    });

    // The secret never travels with the request.
    expect(JSON.stringify(sent)).not.toContain(API_SECRET);

    // walletBalance already includes locked, so the total sits in `free`;
    // duplicate coins (USDT) stay separate for the shared mapping to sum and
    // zero wallet balances are skipped.
    expect(balances).toEqual([
      { asset: "BTC", free: "0.5", locked: "0" },
      { asset: "USDT", free: "100.25", locked: "0" },
      { asset: "USDT", free: "10", locked: "0" },
    ]);
  });

  it("throws with the retMsg when the API reports a non-zero retCode", async () => {
    const { request } = respondWith({
      [UNIFIED_PATH]: bybitSuccess({ retCode: 10001, retMsg: "invalid api key,invalid sign" }),
      [FUND_PATH]: FUND_RESPONSE,
    });

    const caught: unknown = await fetchBalances(request, CREDENTIALS, TIMESTAMP).catch(
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("10001");
    expect(message).toContain("invalid api key,invalid sign");
    expect(message).not.toContain(API_SECRET);
  });

  it("throws with the HTTP status on non-200 responses", async () => {
    const { request } = respondWith({
      [UNIFIED_PATH]: {
        status: 400,
        headers: {},
        body: JSON.stringify({ retCode: 10003, retMsg: "timestamp out of recv window" }),
      },
      [FUND_PATH]: FUND_RESPONSE,
    });

    const caught: unknown = await fetchBalances(request, CREDENTIALS, TIMESTAMP).catch(
      (error: unknown) => error,
    );
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("HTTP 400");
    expect(message).toContain("retCode=10003");
    expect(message).toContain("timestamp out of recv window");
  });

  it("throws a clear error when a 200 body is not valid JSON", async () => {
    const { request } = respondWith({
      [UNIFIED_PATH]: { status: 200, headers: {}, body: "<html>gateway error</html>" },
      [FUND_PATH]: FUND_RESPONSE,
    });

    await expect(fetchBalances(request, CREDENTIALS, TIMESTAMP)).rejects.toThrow(/not valid JSON/);
  });

  it("wires the client to sign with the current time", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(TIMESTAMP);
    try {
      const { request, sent } = respondWith({
        [UNIFIED_PATH]: bybitSuccess({ retCode: 0, result: { list: [] } }),
        [FUND_PATH]: bybitSuccess({ retCode: 0, result: { balance: [] } }),
      });
      await bybitClient.fetchBalances(request, CREDENTIALS);
      expect(sent[0]?.headers?.["X-BAPI-TIMESTAMP"]).toBe(String(TIMESTAMP));
    } finally {
      nowSpy.mockRestore();
    }
  });
});
