import { binanceClient } from "./binance";
import { bybitClient } from "./bybit";
import { okxClient } from "./okx";
import { pionexClient } from "./pionex";
import type { ExchangeClient, ExchangeId } from "./types";

export const EXCHANGE_CLIENTS: Record<ExchangeId, ExchangeClient> = {
  binance: binanceClient,
  okx: okxClient,
  bybit: bybitClient,
  pionex: pionexClient,
};

export function getExchangeClient(id: ExchangeId): ExchangeClient {
  const client = EXCHANGE_CLIENTS[id];
  if (!client) {
    throw new Error(`Unknown exchange: ${id}`);
  }
  return client;
}
