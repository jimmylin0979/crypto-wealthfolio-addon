import type { SnapshotHoldingInput } from "@wealthfolio/addon-sdk";
import type { BinanceBalance } from "../binance/client";

const STABLECOINS: ReadonlySet<string> = new Set([
  "USDT",
  "USDC",
  "FDUSD",
  "TUSD",
  "DAI",
  "USDP",
  "PYUSD",
  "BUSD",
  "USD1",
]);

const DECIMAL_PATTERN = /^[+-]?\d+(\.\d+)?$/;
const ZERO_PATTERN = /^0(\.0*)?$/;

// Simple Earn receipt tokens arrive from /api/v3/account as "LD" + underlying
// (LDUSDT, LDBTC, LDHOME, ...) and have no market price of their own, so they
// are remapped onto the underlying asset. LDO (Lido DAO) is the only real spot
// asset whose name starts with "LD" — verified against the full
// /api/v3/exchangeInfo listing — and must never be stripped.
const REAL_LD_ASSETS: ReadonlySet<string> = new Set(["LDO"]);

function resolveAsset(asset: string): string {
  if (asset.length > 2 && asset.startsWith("LD") && !REAL_LD_ASSETS.has(asset)) {
    return asset.slice(2);
  }
  return asset;
}

interface DecimalParts {
  negative: boolean;
  whole: string;
  frac: string;
}

function parseDecimal(value: string): DecimalParts {
  const trimmed = value.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new Error(`"${value}" is not a decimal number`);
  }
  const negative = trimmed.startsWith("-");
  const [whole, frac = ""] = trimmed.replace(/^[-+]/, "").split(".");
  return { negative, whole, frac };
}

/**
 * Exact decimal-string addition on scaled BigInt — never through `Number`,
 * which rounds past 2^53 and mis-sums 0.1 + 0.2. The result carries the
 * wider operand's precision with trailing fractional zeros trimmed.
 */
export function addDecimalStrings(a: string, b: string): string {
  const pa = parseDecimal(a);
  const pb = parseDecimal(b);
  const decimalPlaces = Math.max(pa.frac.length, pb.frac.length);

  const scaled = (p: DecimalParts): bigint => {
    const magnitude = BigInt(`${p.whole}${p.frac.padEnd(decimalPlaces, "0")}`);
    return p.negative ? -magnitude : magnitude;
  };

  const sum = scaled(pa) + scaled(pb);
  const sign = sum < 0n ? "-" : "";
  const digits = (sum < 0n ? -sum : sum).toString().padStart(decimalPlaces + 1, "0");

  if (decimalPlaces === 0) return `${sign}${digits}`;

  const whole = digits.slice(0, -decimalPlaces);
  const frac = digits.slice(-decimalPlaces).replace(/0+$/, "");
  return frac ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}

export function buildSnapshot(balances: BinanceBalance[]): {
  holdings: SnapshotHoldingInput[];
  cashBalances: Record<string, string>;
} {
  const holdingsBySymbol = new Map<string, SnapshotHoldingInput>();
  let stablecoinTotal = "0";

  for (const balance of balances) {
    const quantity = addDecimalStrings(balance.free, balance.locked);
    if (ZERO_PATTERN.test(quantity)) continue;

    const asset = resolveAsset(balance.asset);

    if (STABLECOINS.has(asset)) {
      stablecoinTotal = addDecimalStrings(stablecoinTotal, quantity);
      continue;
    }

    const existing = holdingsBySymbol.get(asset);
    if (existing) {
      // Spot and its LD receipt remap onto the same symbol (BTC + LDBTC);
      // merge quantities instead of emitting duplicate holdings rows.
      existing.quantity = addDecimalStrings(existing.quantity, quantity);
      continue;
    }

    // instrumentType 'CRYPTO' is load-bearing: without it the host infers
    // Equity for a bare ticker and prices USDT against an unrelated listing.
    holdingsBySymbol.set(asset, {
      symbol: asset,
      quantity,
      currency: "USD",
      quoteCcy: "USD",
      instrumentType: "CRYPTO",
    });
  }

  const holdings = [...holdingsBySymbol.values()];

  return {
    holdings,
    cashBalances: ZERO_PATTERN.test(stablecoinTotal) ? {} : { USD: stablecoinTotal },
  };
}
