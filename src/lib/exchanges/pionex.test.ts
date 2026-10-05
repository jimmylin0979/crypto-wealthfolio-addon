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

const PATH = "/api/v1/account/balances";

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

describe("fetchBalances", () => {
  it("signs the request with the injected timestamp and converts free/frozen rows", async () => {
    const { request, sent } = respondWith(SUCCESS_RESPONSE);

    const balances = await fetchBalances(request, CREDENTIALS, TIMESTAMP);

    expect(sent).toHaveLength(1);
    const [req] = sent;
    expect(req.method).toBe("GET");
    expect(req.url).toBe(`https://api.pionex.com${PATH}?timestamp=${TIMESTAMP}`);
    expect(req.headers).toEqual({
      "PIONEX-KEY": API_KEY,
      "PIONEX-SIGNATURE": SIGNATURE,
    });

    // The secret never travels with the request.
    expect(JSON.stringify(req)).not.toContain(API_SECRET);

    // free + frozen equals the reported total; zero totals are skipped.
    expect(balances).toEqual([
      { asset: "USDT", free: "100.5", locked: "0.5" },
      { asset: "BTC", free: "0.5", locked: "0" },
    ]);
  });

  it("throws with the code and message when result is false", async () => {
    const { request } = respondWith(
      pionexSuccess({ result: false, code: 40001, message: "Invalid signature" }),
    );

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
      status: 401,
      headers: {},
      body: JSON.stringify({ result: false, code: 40003, message: "Unauthorized" }),
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
      status: 200,
      headers: {},
      body: "<html>gateway error</html>",
    });

    await expect(fetchBalances(request, CREDENTIALS, TIMESTAMP)).rejects.toThrow(/not valid JSON/);
  });

  it("returns an empty list when the payload has no balances", async () => {
    const { request } = respondWith(pionexSuccess({ result: true, data: {} }));

    await expect(fetchBalances(request, CREDENTIALS, TIMESTAMP)).resolves.toEqual([]);
  });

  it("wires the client to sign with the current time", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(TIMESTAMP);
    try {
      const { request, sent } = respondWith(
        pionexSuccess({ result: true, data: { balances: [] } }),
      );
      await pionexClient.fetchBalances(request, CREDENTIALS);
      expect(sent[0]?.headers?.["PIONEX-SIGNATURE"]).toBe(SIGNATURE);
      expect(sent[0]?.url).toBe(`https://api.pionex.com${PATH}?timestamp=${TIMESTAMP}`);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
