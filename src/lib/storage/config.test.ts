import { describe, expect, it, vi } from "vitest";
import type { HostAPI } from "@wealthfolio/addon-sdk";
import { readConfig, writeConfig, type AddonConfig } from "./config";
import { storageKey } from "./keys";

function createApi(): HostAPI {
  const stored = new Map<string, string>();
  return {
    storage: {
      get: vi.fn(async (key: string) => stored.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => void stored.set(key, value)),
      delete: vi.fn(async (key: string) => void stored.delete(key)),
    },
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() },
  } as unknown as HostAPI;
}

const DEFAULT: AddonConfig = {
  activeExchange: "binance",
  exchanges: {
    binance: { accountId: null },
    okx: { accountId: null },
    bybit: { accountId: null },
    pionex: { accountId: null },
  },
};

describe("config", () => {
  it("round-trips a multi-exchange config under the binance.config key", async () => {
    const api = createApi();
    const config: AddonConfig = {
      activeExchange: "okx",
      exchanges: {
        binance: { accountId: "WF-1" },
        okx: { accountId: "WF-2" },
        bybit: { accountId: null },
        pionex: { accountId: null },
      },
    };

    await writeConfig(api, config);

    expect(api.storage.set).toHaveBeenCalledWith(storageKey("config"), JSON.stringify(config));
    await expect(readConfig(api)).resolves.toEqual(config);
  });

  it("returns defaults when nothing is stored", async () => {
    await expect(readConfig(createApi())).resolves.toEqual(DEFAULT);
  });

  it("migrates the legacy {accountId} shape onto the Binance slot", async () => {
    const api = createApi();
    vi.mocked(api.storage.get).mockResolvedValue(JSON.stringify({ accountId: "WF-1" }));

    await expect(readConfig(api)).resolves.toEqual({
      activeExchange: "binance",
      exchanges: {
        binance: { accountId: "WF-1" },
        okx: { accountId: null },
        bybit: { accountId: null },
        pionex: { accountId: null },
      },
    });
  });

  it("falls back to defaults when the stored value is corrupt", async () => {
    const api = createApi();
    vi.mocked(api.storage.get).mockResolvedValue("not json");

    await expect(readConfig(api)).resolves.toEqual(DEFAULT);
    expect(api.logger.error).toHaveBeenCalled();
  });

  it("falls back to defaults when a legacy accountId is not a string", async () => {
    const api = createApi();
    vi.mocked(api.storage.get).mockResolvedValue(JSON.stringify({ accountId: 42 }));

    await expect(readConfig(api)).resolves.toEqual(DEFAULT);
  });

  it("fills missing exchanges and rejects an unknown activeExchange", async () => {
    const api = createApi();
    vi.mocked(api.storage.get).mockResolvedValue(
      JSON.stringify({
        activeExchange: "kraken",
        exchanges: { okx: { accountId: "WF-OKX" }, binance: {} },
      }),
    );

    await expect(readConfig(api)).resolves.toEqual({
      activeExchange: "binance",
      exchanges: {
        binance: { accountId: null },
        okx: { accountId: "WF-OKX" },
        bybit: { accountId: null },
        pionex: { accountId: null },
      },
    });
  });
});
