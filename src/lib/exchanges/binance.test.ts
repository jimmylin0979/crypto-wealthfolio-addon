import type { NetworkRequest, NetworkResponse } from "@wealthfolio/addon-sdk";
import { describe, expect, it, vi } from "vitest";

import { binanceClient, fetchBalances } from "./binance";
import type { ExchangeCredentials } from "./types";

const API_KEY = "test-api-key";
const API_SECRET = "test-api-secret";
const CREDENTIALS: ExchangeCredentials = { apiKey: API_KEY, apiSecret: API_SECRET };
const TIMESTAMP = 1712345678901;
// HMAC-SHA256 of `timestamp=1712345678901&recvWindow=5000` with API_SECRET.
const EXPECTED_SIGNATURE = "8571cac9a741c3fdebd40131af0a5cde44643de7e92494f183e0048ed9770246";

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

function balancesResponse(balances: unknown[]): NetworkResponse {
  return { status: 200, headers: {}, body: JSON.stringify({ balances }) };
}

describe("fetchBalances", () => {
  it("signs the query in the documented order and returns only funded balances", async () => {
    const { request, sent } = respondWith(
      balancesResponse([
        { asset: "BTC", free: "0.00000001", locked: "0.00000000" },
        { asset: "ETH", free: "0.00000000", locked: "0.00000000" },
        { asset: "USDT", free: "12.50000000", locked: "3.25000000" },
        { asset: "SOL", free: "0.00000000", locked: "2.00000000" },
      ]),
    );

    const balances = await fetchBalances(request, CREDENTIALS, TIMESTAMP);

    // Zero balances are dropped; original decimal strings are preserved.
    expect(balances).toEqual([
      { asset: "BTC", free: "0.00000001", locked: "0.00000000" },
      { asset: "USDT", free: "12.50000000", locked: "3.25000000" },
      { asset: "SOL", free: "0.00000000", locked: "2.00000000" },
    ]);

    const [sentRequest] = sent;
    expect(sentRequest.method).toBe("GET");
    expect(sentRequest.headers).toEqual({ "X-MBX-APIKEY": API_KEY });

    // The signature covers exactly `timestamp=...&recvWindow=5000`, in that order.
    expect(sentRequest.url).toBe(
      `https://api.binance.com/api/v3/account?timestamp=${TIMESTAMP}` +
        `&recvWindow=5000&signature=${EXPECTED_SIGNATURE}`,
    );

    // The secret must never travel with the request.
    expect(sentRequest.url).not.toContain(API_SECRET);
    expect(JSON.stringify(sentRequest.headers)).not.toContain(API_SECRET);
  });

  it("throws with the HTTP status, Binance code, and message on error responses", async () => {
    const { request } = respondWith({
      status: 401,
      headers: {},
      body: JSON.stringify({ code: -1022, msg: "Signature for this request is not valid." }),
    });

    const caught: unknown = await fetchBalances(request, CREDENTIALS, TIMESTAMP).catch(
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("HTTP 401");
    expect(message).toContain("-1022");
    expect(message).toContain("Signature for this request is not valid");
    expect(message).not.toContain(API_SECRET);
  });

  it("returns an empty list when the body has no balances array", async () => {
    const { request } = respondWith({
      status: 200,
      headers: {},
      body: JSON.stringify({ makerCommission: 10, takerCommission: 10 }),
    });

    await expect(fetchBalances(request, CREDENTIALS, TIMESTAMP)).resolves.toEqual([]);
  });

  it("returns an empty list when balances is an empty array", async () => {
    const { request } = respondWith(balancesResponse([]));

    await expect(fetchBalances(request, CREDENTIALS, TIMESTAMP)).resolves.toEqual([]);
  });

  it("throws a clear error when a 200 body is not valid JSON", async () => {
    const { request } = respondWith({
      status: 200,
      headers: {},
      body: "<html>gateway error</html>",
    });

    await expect(fetchBalances(request, CREDENTIALS, TIMESTAMP)).rejects.toThrow(/not valid JSON/);
  });

  it("wires the client to sign with the current time", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(TIMESTAMP);
    try {
      const { request, sent } = respondWith(balancesResponse([]));
      await binanceClient.fetchBalances(request, CREDENTIALS);
      const [sentRequest] = sent;
      expect(sentRequest.url).toContain(`timestamp=${TIMESTAMP}&recvWindow=5000`);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("Simple Earn LD receipt resolution", () => {
  it("strips the Simple Earn LD prefix onto the underlying asset", async () => {
    const { request } = respondWith(
      balancesResponse([
        { asset: "LDBTC", free: "0.02", locked: "0" },
        { asset: "LDHOME", free: "141.20513310", locked: "0" },
        { asset: "LDWBETH", free: "0.00000001", locked: "0" },
      ]),
    );

    const balances = await fetchBalances(request, CREDENTIALS, TIMESTAMP);

    expect(balances).toEqual([
      { asset: "BTC", free: "0.02", locked: "0" },
      { asset: "HOME", free: "141.20513310", locked: "0" },
      { asset: "WBETH", free: "0.00000001", locked: "0" },
    ]);
  });

  it("resolves LD stablecoin receipts to their underlying stablecoin", async () => {
    const { request } = respondWith(
      balancesResponse([
        { asset: "USDT", free: "0.10958000", locked: "0" },
        { asset: "LDUSDT", free: "1142.51025178", locked: "0" },
        { asset: "LDUSDC", free: "272.03719455", locked: "0" },
      ]),
    );

    const balances = await fetchBalances(request, CREDENTIALS, TIMESTAMP);

    // Rows resolving to the same asset stay separate here; the shared mapping
    // merges duplicates.
    expect(balances.map((b) => b.asset)).toEqual(["USDT", "USDT", "USDC"]);
  });

  it("returns spot and receipt rows separately for the same underlying", async () => {
    const { request } = respondWith(
      balancesResponse([
        { asset: "BTC", free: "0.00000006", locked: "0" },
        { asset: "LDBTC", free: "0.02234838", locked: "0" },
      ]),
    );

    const balances = await fetchBalances(request, CREDENTIALS, TIMESTAMP);

    expect(balances).toEqual([
      { asset: "BTC", free: "0.00000006", locked: "0" },
      { asset: "BTC", free: "0.02234838", locked: "0" },
    ]);
  });

  it("never strips LDO, which is a real spot asset", async () => {
    const { request } = respondWith(balancesResponse([{ asset: "LDO", free: "3", locked: "0" }]));

    const balances = await fetchBalances(request, CREDENTIALS, TIMESTAMP);

    expect(balances).toEqual([{ asset: "LDO", free: "3", locked: "0" }]);
  });

  it("keeps a bare LD symbol intact", async () => {
    const { request } = respondWith(balancesResponse([{ asset: "LD", free: "2", locked: "0" }]));

    const balances = await fetchBalances(request, CREDENTIALS, TIMESTAMP);

    expect(balances).toEqual([{ asset: "LD", free: "2", locked: "0" }]);
  });
});
