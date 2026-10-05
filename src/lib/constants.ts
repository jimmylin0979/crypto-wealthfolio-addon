import type { ExchangeId } from "./exchanges/types";

/** Must match manifest `id`, `contributes.routes[].id`, and the route path segment. */
export const ADDON_ID = "binance-wealthfolio-addon";

/** Storage/secret key prefix. Charset is constrained to [A-Za-z0-9_.:-] by the host. */
export const KEY_PREFIX = "binance";

export function secretKeys(exchangeId: ExchangeId): {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
} {
  return {
    apiKey: `${exchangeId}.apiKey`,
    apiSecret: `${exchangeId}.apiSecret`,
    passphrase: `${exchangeId}.passphrase`,
  };
}
