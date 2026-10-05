import { describe, expect, it } from "vitest";
import type { ExchangeBalance } from "../exchanges/types";
import { addDecimalStrings, buildSnapshot } from "./mapping";

function balance(asset: string, free: string, locked: string): ExchangeBalance {
  return { asset, free, locked };
}

describe("addDecimalStrings", () => {
  it("sums decimals without float error", () => {
    expect(addDecimalStrings("0.1", "0.2")).toBe("0.3");
  });

  it("keeps precision past float-safe integers", () => {
    expect(addDecimalStrings("1", "0.00000001")).toBe("1.00000001");
    expect(addDecimalStrings("12345678901234567890.5", "0.5")).toBe("12345678901234567891");
  });

  it("handles integers and mismatched fractional lengths", () => {
    expect(addDecimalStrings("1", "2")).toBe("3");
    expect(addDecimalStrings("1.5", "2.25")).toBe("3.75");
    expect(addDecimalStrings("0.00000000", "0")).toBe("0");
  });

  it("rejects values that are not plain decimals", () => {
    expect(() => addDecimalStrings("1e3", "1")).toThrow(/not a decimal/);
    expect(() => addDecimalStrings("abc", "1")).toThrow(/not a decimal/);
  });
});

describe("buildSnapshot", () => {
  it("maps stablecoins to USD cash only, never to positions", () => {
    const { holdings, cashBalances } = buildSnapshot([
      balance("USDT", "100.5", "0.5"),
      balance("USDC", "10", "0"),
      balance("FDUSD", "0", "4"),
    ]);

    expect(holdings).toEqual([]);
    expect(cashBalances).toEqual({ USD: "115" });
  });

  it("maps non-stable balances to CRYPTO positions quoted in USD", () => {
    const { holdings, cashBalances } = buildSnapshot([balance("BTC", "0.5", "0.1")]);

    expect(holdings).toEqual([
      {
        symbol: "BTC",
        quantity: "0.6",
        currency: "USD",
        quoteCcy: "USD",
        instrumentType: "CRYPTO",
      },
    ]);
    expect(cashBalances).toEqual({});
    expect(holdings[0]).not.toHaveProperty("exchangeMic");
    expect(holdings[0]).not.toHaveProperty("averageCost");
  });

  it("skips zero balances entirely", () => {
    const { holdings, cashBalances } = buildSnapshot([
      balance("ETH", "0", "0"),
      balance("USDT", "0.00000000", "0"),
      balance("BTC", "1", "0"),
    ]);

    expect(holdings).toHaveLength(1);
    expect(holdings[0]?.symbol).toBe("BTC");
    expect(cashBalances).toEqual({});
  });

  it("combines cash and positions in one snapshot", () => {
    const { holdings, cashBalances } = buildSnapshot([
      balance("USDT", "50", "0"),
      balance("ETH", "2", "3"),
      balance("SOL", "0", "0.25"),
    ]);

    expect(cashBalances).toEqual({ USD: "50" });
    expect(holdings.map((h) => ({ symbol: h.symbol, quantity: h.quantity }))).toEqual([
      { symbol: "ETH", quantity: "5" },
      { symbol: "SOL", quantity: "0.25" },
    ]);
  });

  it("merges stablecoin rows from several endpoints into one cash total", () => {
    const { holdings, cashBalances } = buildSnapshot([
      balance("USDT", "0.10958000", "0"),
      balance("USDT", "1142.51025178", "0"),
      balance("USDC", "272.03719455", "0"),
    ]);

    expect(holdings).toEqual([]);
    expect(cashBalances).toEqual({ USD: "1414.65702633" });
  });

  it("merges duplicate asset rows into one holding", () => {
    const { holdings } = buildSnapshot([
      balance("BTC", "0.00000006", "0"),
      balance("BTC", "0.02234838", "0"),
    ]);

    expect(holdings).toHaveLength(1);
    expect(holdings[0]).toMatchObject({ symbol: "BTC", quantity: "0.02234844" });
  });
});
