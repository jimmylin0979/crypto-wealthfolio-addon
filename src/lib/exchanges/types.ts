import type { NetworkRequest, NetworkResponse } from "@wealthfolio/addon-sdk";

export const EXCHANGE_IDS = ["binance", "okx", "bybit", "pionex"] as const;

export type ExchangeId = (typeof EXCHANGE_IDS)[number];

export type CredentialField = "apiKey" | "apiSecret" | "passphrase";

export interface ExchangeMeta {
  readonly label: string;
  readonly credentialFields: readonly CredentialField[];
}

export const EXCHANGE_META: Record<ExchangeId, ExchangeMeta> = {
  binance: { label: "Binance", credentialFields: ["apiKey", "apiSecret"] },
  okx: { label: "OKX", credentialFields: ["apiKey", "apiSecret", "passphrase"] },
  bybit: { label: "Bybit", credentialFields: ["apiKey", "apiSecret"] },
  pionex: { label: "Pionex", credentialFields: ["apiKey", "apiSecret"] },
};

export function isExchangeId(value: unknown): value is ExchangeId {
  return typeof value === "string" && (EXCHANGE_IDS as readonly string[]).includes(value);
}

export interface ExchangeBalance {
  asset: string;
  free: string;
  locked: string;
}

export interface ExchangeCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
}

export type NetworkRequestFn = (req: NetworkRequest) => Promise<NetworkResponse>;

export interface ExchangeClient {
  readonly id: ExchangeId;
  fetchBalances(
    request: NetworkRequestFn,
    credentials: ExchangeCredentials,
  ): Promise<ExchangeBalance[]>;
}
