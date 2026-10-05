import type { HostAPI } from "@wealthfolio/addon-sdk";
import { EXCHANGE_IDS, isExchangeId, type ExchangeId } from "../exchanges/types";
import { storageKey } from "./keys";

export interface AddonConfig {
  activeExchange: ExchangeId;
  exchanges: Record<ExchangeId, { accountId: string | null }>;
}

const CONFIG_KEY = storageKey("config");

function defaultConfig(): AddonConfig {
  return {
    activeExchange: "binance",
    exchanges: {
      binance: { accountId: null },
      okx: { accountId: null },
      bybit: { accountId: null },
      pionex: { accountId: null },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(raw: unknown): AddonConfig {
  if (!isRecord(raw)) return defaultConfig();

  const exchanges: Record<string, unknown> | null = isRecord(raw.exchanges) ? raw.exchanges : null;

  // Legacy single-account shape: migrate it onto the Binance slot.
  if (exchanges === null && typeof raw.accountId === "string") {
    const config = defaultConfig();
    config.exchanges.binance = { accountId: raw.accountId };
    return config;
  }

  const config = defaultConfig();
  if (isExchangeId(raw.activeExchange)) config.activeExchange = raw.activeExchange;
  if (exchanges !== null) {
    for (const id of EXCHANGE_IDS) {
      const entry: unknown = exchanges[id];
      if (isRecord(entry) && typeof entry.accountId === "string") {
        config.exchanges[id] = { accountId: entry.accountId };
      }
    }
  }
  return config;
}

export async function readConfig(api: HostAPI): Promise<AddonConfig> {
  const raw = await api.storage.get(CONFIG_KEY);
  if (!raw) return defaultConfig();

  try {
    return normalize(JSON.parse(raw));
  } catch (error) {
    // Falling back to an unmapped config sends the user back to the mapping
    // step, which is recoverable; throwing would brick the addon page.
    api.logger.error(`[binance] corrupt config, falling back to unmapped: ${String(error)}`);
    return defaultConfig();
  }
}

export async function writeConfig(api: HostAPI, config: AddonConfig): Promise<void> {
  await api.storage.set(CONFIG_KEY, JSON.stringify(config));
}
