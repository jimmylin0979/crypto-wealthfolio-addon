import { describe, expect, it } from "vitest";

import { EXCHANGE_CLIENTS, getExchangeClient } from "./registry";
import type { ExchangeId } from "./types";

describe("registry", () => {
  it("maps every known exchange id to a client with a matching id", () => {
    const ids: ExchangeId[] = ["binance", "okx", "bybit", "pionex"];
    expect(Object.keys(EXCHANGE_CLIENTS).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(EXCHANGE_CLIENTS[id].id).toBe(id);
    }
  });

  it("returns the client for a known id", () => {
    expect(getExchangeClient("binance")).toBe(EXCHANGE_CLIENTS.binance);
    expect(getExchangeClient("okx")).toBe(EXCHANGE_CLIENTS.okx);
    expect(getExchangeClient("bybit")).toBe(EXCHANGE_CLIENTS.bybit);
    expect(getExchangeClient("pionex")).toBe(EXCHANGE_CLIENTS.pionex);
  });

  it("throws for an id that has no client", () => {
    expect(() => getExchangeClient("ghost" as ExchangeId)).toThrow(/Unknown exchange/);
  });
});
