import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountValuation, Holding, HostAPI } from "@wealthfolio/addon-sdk";
import { getExchangeClient } from "../exchanges/registry";
import type { ExchangeBalance, ExchangeClient, ExchangeId } from "../exchanges/types";
import { runUpdate, runUpdateAll } from "./run";

vi.mock("../exchanges/registry", () => ({
  getExchangeClient: vi.fn(),
}));

const ACCOUNT_ID = "WF-BINANCE-1";

function createApi(): HostAPI {
  return {
    storage: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    },
    secrets: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    },
    network: {
      request: vi.fn(async () => ({ status: 200, headers: {}, body: "" })),
    },
    snapshots: { save: vi.fn(async () => {}) },
    portfolio: {
      recalculate: vi.fn(async () => {}),
      getHoldings: vi.fn(async () => []),
      getLatestValuations: vi.fn(async () => []),
    },
    market: { sync: vi.fn(async () => {}) },
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() },
  } as unknown as HostAPI;
}

function configJson(accounts: Partial<Record<ExchangeId, string>>): string {
  return JSON.stringify({
    activeExchange: "binance",
    exchanges: {
      binance: { accountId: accounts.binance ?? null },
      okx: { accountId: accounts.okx ?? null },
      bybit: { accountId: accounts.bybit ?? null },
      pionex: { accountId: accounts.pionex ?? null },
    },
  });
}

function mappedApi(): HostAPI {
  const api = createApi();
  vi.mocked(api.storage.get).mockResolvedValue(configJson({ binance: ACCOUNT_ID }));
  vi.mocked(api.secrets.get).mockImplementation(async (key: string) =>
    key === "binance.apiKey" ? "test-key" : key === "binance.apiSecret" ? "test-secret" : null,
  );
  return api;
}

function multiMappedApi(): HostAPI {
  const api = createApi();
  vi.mocked(api.storage.get).mockResolvedValue(
    configJson({ binance: ACCOUNT_ID, okx: "WF-OKX-1" }),
  );
  vi.mocked(api.secrets.get).mockImplementation(async (key: string) =>
    key === "okx.passphrase"
      ? "test-passphrase"
      : key.endsWith(".apiKey") || key.endsWith(".apiSecret")
        ? "test-value"
        : null,
  );
  return api;
}

function mockAnyClient(balances: ExchangeBalance[]) {
  vi.mocked(getExchangeClient).mockImplementation((exchangeId: ExchangeId) => ({
    id: exchangeId,
    fetchBalances: async () => balances,
  }));
}

function mockClient(exchangeId: ExchangeId, balances: ExchangeBalance[]) {
  const fetchBalances = vi.fn(async () => balances);
  vi.mocked(getExchangeClient).mockReturnValue({
    id: exchangeId,
    fetchBalances,
  } satisfies ExchangeClient);
  return fetchBalances;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("runUpdate", () => {
  it("writes one today-dated snapshot with USD cash and a CRYPTO holding", async () => {
    const api = mappedApi();
    const fetchBalances = mockClient("binance", [
      { asset: "USDT", free: "100.5", locked: "0.5" },
      { asset: "USDC", free: "10", locked: "0" },
      { asset: "BTC", free: "0.5", locked: "0.1" },
      { asset: "ETH", free: "0", locked: "0" },
    ]);
    vi.mocked(api.portfolio.getHoldings).mockResolvedValue([
      { id: "h1", instrument: { id: "asset-btc" } },
      { id: "h2", instrument: null },
    ] as unknown as Holding[]);
    vi.mocked(api.portfolio.getLatestValuations).mockResolvedValue([
      { accountId: ACCOUNT_ID, totalValueBase: 1234.5 },
    ] as unknown as AccountValuation[]);

    const result = await runUpdate(api, "binance");

    expect(getExchangeClient).toHaveBeenCalledWith("binance");
    expect(fetchBalances).toHaveBeenCalledWith(expect.any(Function), {
      apiKey: "test-key",
      apiSecret: "test-secret",
    });
    expect(api.snapshots.save).toHaveBeenCalledWith(
      ACCOUNT_ID,
      [
        {
          symbol: "BTC",
          quantity: "0.6",
          currency: "USD",
          quoteCcy: "USD",
          instrumentType: "CRYPTO",
        },
      ],
      { USD: "111" },
    );
    expect(api.portfolio.recalculate).toHaveBeenCalled();
    expect(api.market.sync).toHaveBeenCalledWith(["asset-btc"], false);
    expect(result.snapshotDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.positionCount).toBe(1);
    expect(result.cashUsdTotal).toBe("111");
    expect(result.accountValue).toBe("1234.5");
    expect(result.warnings).toEqual([]);
  });

  it("sends the passphrase to OKX when one is stored", async () => {
    const api = createApi();
    vi.mocked(api.storage.get).mockResolvedValue(configJson({ okx: "WF-OKX-1" }));
    vi.mocked(api.secrets.get).mockImplementation(async (key: string) =>
      key === "okx.apiKey"
        ? "test-key"
        : key === "okx.apiSecret"
          ? "test-secret"
          : key === "okx.passphrase"
            ? "test-passphrase"
            : null,
    );
    const fetchBalances = mockClient("okx", [{ asset: "USDT", free: "5", locked: "0" }]);

    await runUpdate(api, "okx");

    expect(fetchBalances).toHaveBeenCalledWith(expect.any(Function), {
      apiKey: "test-key",
      apiSecret: "test-secret",
      passphrase: "test-passphrase",
    });
    expect(api.snapshots.save).toHaveBeenCalledWith("WF-OKX-1", [], { USD: "5" });
  });

  it("throws before fetching when no account is mapped", async () => {
    const api = createApi();

    await expect(runUpdate(api, "binance")).rejects.toThrow("No Binance account mapped yet");
    expect(getExchangeClient).not.toHaveBeenCalled();
  });

  it("throws when the API key is missing, without echoing secrets", async () => {
    const api = mappedApi();
    vi.mocked(api.secrets.get).mockResolvedValue(null);

    const failure = runUpdate(api, "binance");
    await expect(failure).rejects.toThrow(/API key is missing/);
    await expect(failure).rejects.not.toThrow(/test-/);
    expect(getExchangeClient).not.toHaveBeenCalled();
  });

  it("throws when the API secret is missing", async () => {
    const api = mappedApi();
    vi.mocked(api.secrets.get).mockImplementation(async (key: string) =>
      key === "binance.apiKey" ? "test-key" : null,
    );

    const failure = runUpdate(api, "binance");
    await expect(failure).rejects.toThrow(/API secret is missing/);
    await expect(failure).rejects.not.toThrow(/test-key/);
    expect(getExchangeClient).not.toHaveBeenCalled();
  });

  it("throws when the OKX passphrase is missing", async () => {
    const api = createApi();
    vi.mocked(api.storage.get).mockResolvedValue(configJson({ okx: "WF-OKX-1" }));
    vi.mocked(api.secrets.get).mockImplementation(async (key: string) =>
      key === "okx.apiKey" ? "test-key" : key === "okx.apiSecret" ? "test-secret" : null,
    );

    await expect(runUpdate(api, "okx")).rejects.toThrow(
      "OKX API passphrase is missing — save it on this page first.",
    );
    expect(getExchangeClient).not.toHaveBeenCalled();
  });

  it("records warnings instead of throwing when best-effort steps fail", async () => {
    const api = mappedApi();
    mockClient("binance", [
      { asset: "USDT", free: "10", locked: "0" },
      { asset: "BTC", free: "1", locked: "0" },
    ]);
    vi.mocked(api.portfolio.recalculate).mockRejectedValue(new Error("calc backend down"));
    vi.mocked(api.portfolio.getHoldings).mockResolvedValue([
      { id: "h1", instrument: { id: "asset-btc" } },
    ] as unknown as Holding[]);
    vi.mocked(api.market.sync).mockRejectedValue(new Error("quote backend down"));

    const result = await runUpdate(api, "binance");

    expect(api.snapshots.save).toHaveBeenCalledTimes(1);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toMatch(/Portfolio recalculation failed/);
    expect(result.warnings[1]).toMatch(/Price refresh failed/);
    expect(result.cashUsdTotal).toBe("10");
  });

  it("throws when the balance fetch fails", async () => {
    const api = mappedApi();
    const fetchBalances = mockClient("binance", []);
    fetchBalances.mockRejectedValue(new Error("Binance API: Invalid API-key"));

    await expect(runUpdate(api, "binance")).rejects.toThrow(/Invalid API-key/);
    expect(api.snapshots.save).not.toHaveBeenCalled();
  });
});

describe("runUpdateAll", () => {
  it("syncs the given exchanges strictly one at a time and reports all as succeeded", async () => {
    const api = multiMappedApi();
    const timeline: string[] = [];
    let releaseBinance!: () => void;
    const binanceGate = new Promise<void>((resolve) => {
      releaseBinance = resolve;
    });
    vi.mocked(getExchangeClient).mockImplementation((exchangeId: ExchangeId) => ({
      id: exchangeId,
      fetchBalances: async () => {
        if (exchangeId === "binance") {
          timeline.push("binance:start");
          await binanceGate;
          timeline.push("binance:end");
        } else {
          timeline.push("okx:start");
          timeline.push("okx:end");
        }
        return [{ asset: "USDT", free: "5", locked: "0" }];
      },
    }));

    const summaryPromise = runUpdateAll(api, ["binance", "okx"]);
    // Drain the microtask queue: a parallel run would already have started
    // OKX while Binance's fetch is gated, a sequential one must not have.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(timeline).toEqual(["binance:start"]);

    releaseBinance();
    const summary = await summaryPromise;

    expect(timeline).toEqual(["binance:start", "binance:end", "okx:start", "okx:end"]);
    expect(summary.succeeded).toEqual(["binance", "okx"]);
    expect(summary.failed).toEqual([]);
    expect(api.snapshots.save).toHaveBeenCalledTimes(2);
  });

  it("isolates a failing exchange so later ones still run", async () => {
    const api = createApi();
    vi.mocked(api.storage.get).mockResolvedValue(
      configJson({ binance: ACCOUNT_ID, okx: "WF-OKX-1" }),
    );
    vi.mocked(api.secrets.get).mockImplementation(async (key: string) =>
      key === "okx.passphrase"
        ? "test-passphrase"
        : key.startsWith("okx.")
          ? "test-value"
          : null,
    );
    mockAnyClient([{ asset: "USDT", free: "5", locked: "0" }]);

    const summary = await runUpdateAll(api, ["binance", "okx"]);

    expect(summary.succeeded).toEqual(["okx"]);
    expect(summary.failed).toEqual([
      { exchangeId: "binance", message: expect.stringMatching(/API key is missing/) },
    ]);
    expect(getExchangeClient).toHaveBeenCalledWith("okx");
    expect(api.snapshots.save).toHaveBeenCalledTimes(1);
  });

  it("fires onStarted and onSettled once per exchange, in order", async () => {
    const api = multiMappedApi();
    mockAnyClient([{ asset: "USDT", free: "5", locked: "0" }]);
    const events: string[] = [];

    const summary = await runUpdateAll(api, ["binance", "okx"], {
      onStarted: (exchangeId, index, total) =>
        events.push(`start ${exchangeId} ${index}/${total}`),
      onSettled: (exchangeId, outcome) =>
        events.push(
          outcome.ok
            ? `settle ${exchangeId} ok:${outcome.result.cashUsdTotal}`
            : `settle ${exchangeId} err:${outcome.error}`,
        ),
    });

    expect(events).toEqual([
      "start binance 0/2",
      "settle binance ok:5",
      "start okx 1/2",
      "settle okx ok:5",
    ]);
    expect(summary.succeeded).toEqual(["binance", "okx"]);
  });

  it("returns an empty summary without running anything for an empty exchange list", async () => {
    const api = multiMappedApi();

    const summary = await runUpdateAll(api, []);

    expect(summary).toEqual({ succeeded: [], failed: [] });
    expect(api.storage.get).not.toHaveBeenCalled();
    expect(getExchangeClient).not.toHaveBeenCalled();
  });
});
