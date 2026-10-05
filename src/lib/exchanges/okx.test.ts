import type { NetworkRequest, NetworkResponse } from "@wealthfolio/addon-sdk";
import { describe, expect, it, vi } from "vitest";

import { fetchBalances, okxClient } from "./okx";
import type { ExchangeCredentials } from "./types";

const API_KEY = "test-api-key";
const API_SECRET = "test-api-secret";
const PASSPHRASE = "test-passphrase";
const CREDENTIALS: ExchangeCredentials = {
  apiKey: API_KEY,
  apiSecret: API_SECRET,
  passphrase: PASSPHRASE,
};
const TIMESTAMP = 1712345678901;
const ISO_TIMESTAMP = "2024-04-05T19:34:38.901Z";
// base64 HMAC-SHA256 over `${ISO_TIMESTAMP}GET<path>` with API_SECRET.
const TRADING_SIGNATURE = "4mb8itn0Rv/6RXG+krBrFLb+6Rd/4y1lABC7AYGqk0Q=";
const FUNDING_SIGNATURE = "X98o49ezEnQqmMhc8ZAk2Pqcy9rVAYou+CyWS5xrzPw=";

const TRADING_PATH = "/api/v5/account/balance";
const FUNDING_PATH = "/api/v5/asset/balances";

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

function okxSuccess(body: unknown): NetworkResponse {
  return { status: 200, headers: {}, body: JSON.stringify(body) };
}

const TRADING_RESPONSE = okxSuccess({
  code: "0",
  data: [
    {
      details: [
        { ccy: "USDT", availBal: "100.5", frozenBal: "0.5" },
        { ccy: "BTC", availBal: "0.5", frozenBal: "0.1" },
        { ccy: "XRP", availBal: "0", frozenBal: "0" },
      ],
    },
  ],
});

const FUNDING_RESPONSE = okxSuccess({
  code: "0",
  data: [
    { ccy: "USDT", availBal: "10", frozenBal: "0" },
    { ccy: "ETH", bal: "3" },
    { ccy: "SOL", availBal: "2.5" },
  ],
});

describe("fetchBalances", () => {
  it("signs both requests with the injected timestamp and merges trading and funding rows", async () => {
    const { request, sent } = respondWith({
      [TRADING_PATH]: TRADING_RESPONSE,
      [FUNDING_PATH]: FUNDING_RESPONSE,
    });

    const balances = await fetchBalances(request, CREDENTIALS, TIMESTAMP);

    expect(sent).toHaveLength(2);
    const [trading, funding] = sent;
    expect(trading.method).toBe("GET");
    expect(trading.url).toBe(`https://www.okx.com${TRADING_PATH}`);
    expect(trading.headers).toEqual({
      "OK-ACCESS-KEY": API_KEY,
      "OK-ACCESS-SIGN": TRADING_SIGNATURE,
      "OK-ACCESS-TIMESTAMP": ISO_TIMESTAMP,
      "OK-ACCESS-PASSPHRASE": PASSPHRASE,
    });

    expect(funding.method).toBe("GET");
    expect(funding.url).toBe(`https://www.okx.com${FUNDING_PATH}`);
    expect(funding.headers).toEqual({
      "OK-ACCESS-KEY": API_KEY,
      "OK-ACCESS-SIGN": FUNDING_SIGNATURE,
      "OK-ACCESS-TIMESTAMP": ISO_TIMESTAMP,
      "OK-ACCESS-PASSPHRASE": PASSPHRASE,
    });

    // The secret never travels with the request.
    expect(JSON.stringify(sent)).not.toContain(API_SECRET);

    // Both row sets are returned; duplicate ccys (USDT) stay separate for the
    // shared mapping to sum, and zero totals are skipped.
    expect(balances).toEqual([
      { asset: "USDT", free: "100.5", locked: "0.5" },
      { asset: "BTC", free: "0.5", locked: "0.1" },
      { asset: "USDT", free: "10", locked: "0" },
      { asset: "ETH", free: "3", locked: "0" },
      { asset: "SOL", free: "2.5", locked: "0" },
    ]);
  });

  it("throws with the OKX code and message when the API reports failure", async () => {
    const { request } = respondWith({
      [TRADING_PATH]: okxSuccess({ code: "50113", msg: "Invalid OK-ACCESS-SIGN" }),
      [FUNDING_PATH]: FUNDING_RESPONSE,
    });

    const caught: unknown = await fetchBalances(request, CREDENTIALS, TIMESTAMP).catch(
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("50113");
    expect(message).toContain("Invalid OK-ACCESS-SIGN");
    expect(message).not.toContain(API_SECRET);
    expect(message).not.toContain(PASSPHRASE);
  });

  it("throws with the HTTP status on non-200 responses", async () => {
    const { request } = respondWith({
      [TRADING_PATH]: {
        status: 401,
        headers: {},
        body: JSON.stringify({ code: "50113", msg: "Invalid OK-ACCESS-KEY" }),
      },
      [FUNDING_PATH]: FUNDING_RESPONSE,
    });

    const caught: unknown = await fetchBalances(request, CREDENTIALS, TIMESTAMP).catch(
      (error: unknown) => error,
    );
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("HTTP 401");
    expect(message).toContain("code=50113");
    expect(message).toContain("Invalid OK-ACCESS-KEY");
  });

  it("throws a clear error when a 200 body is not valid JSON", async () => {
    const { request } = respondWith({
      [TRADING_PATH]: { status: 200, headers: {}, body: "<html>gateway error</html>" },
      [FUNDING_PATH]: FUNDING_RESPONSE,
    });

    await expect(fetchBalances(request, CREDENTIALS, TIMESTAMP)).rejects.toThrow(/not valid JSON/);
  });

  it("fails before any request when the passphrase is missing", async () => {
    const { request, sent } = respondWith({
      [TRADING_PATH]: TRADING_RESPONSE,
      [FUNDING_PATH]: FUNDING_RESPONSE,
    });

    await expect(
      fetchBalances(request, { apiKey: API_KEY, apiSecret: API_SECRET }, TIMESTAMP),
    ).rejects.toThrow(/passphrase/);
    expect(sent).toHaveLength(0);
  });

  it("wires the client to sign with the current time", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(TIMESTAMP);
    try {
      const { request, sent } = respondWith({
        [TRADING_PATH]: okxSuccess({ code: "0", data: [] }),
        [FUNDING_PATH]: okxSuccess({ code: "0", data: [] }),
      });
      await okxClient.fetchBalances(request, CREDENTIALS);
      expect(sent[0]?.headers?.["OK-ACCESS-TIMESTAMP"]).toBe(ISO_TIMESTAMP);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
