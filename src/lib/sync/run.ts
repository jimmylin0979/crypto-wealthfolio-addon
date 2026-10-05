import type { HostAPI } from "@wealthfolio/addon-sdk";
import { secretKeys } from "../constants";
import { getExchangeClient } from "../exchanges/registry";
import { EXCHANGE_META, type ExchangeId } from "../exchanges/types";
import { readConfig } from "../storage/config";
import { buildSnapshot } from "./mapping";

export interface UpdateResult {
  snapshotDate: string;
  positionCount: number;
  cashUsdTotal: string;
  accountValue?: string;
  warnings: string[];
}

function todayInUserTimezone(): string {
  const now = new Date();
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runUpdate(api: HostAPI, exchangeId: ExchangeId): Promise<UpdateResult> {
  const { label, credentialFields } = EXCHANGE_META[exchangeId];

  const config = await readConfig(api);
  const accountId = config.exchanges[exchangeId].accountId;
  if (accountId === null) {
    throw new Error(`No ${label} account mapped yet`);
  }

  const keys = secretKeys(exchangeId);
  const apiKey = await api.secrets.get(keys.apiKey);
  if (!apiKey) {
    throw new Error(`${label} API key is missing — save it on this page first.`);
  }
  const apiSecret = await api.secrets.get(keys.apiSecret);
  if (!apiSecret) {
    throw new Error(`${label} API secret is missing — save it on this page first.`);
  }
  let passphrase: string | undefined;
  if (credentialFields.includes("passphrase")) {
    passphrase = (await api.secrets.get(keys.passphrase)) ?? undefined;
    if (!passphrase) {
      throw new Error(`${label} API passphrase is missing — save it on this page first.`);
    }
  }

  const client = getExchangeClient(exchangeId);
  const balances = await client.fetchBalances((request) => api.network.request(request), {
    apiKey,
    apiSecret,
    ...(passphrase !== undefined ? { passphrase } : {}),
  });

  const { holdings, cashBalances } = buildSnapshot(balances);

  // snapshotDate deliberately omitted: the host stamps today in the user's
  // timezone, and save() is an upsert, so a repeat press overwrites the day.
  await api.snapshots.save(accountId, holdings, cashBalances);

  const warnings: string[] = [];

  // The snapshot is already stored, so everything below is best-effort: a
  // failure degrades what the update reports, it does not fail the update.
  try {
    await api.portfolio.recalculate();
  } catch (error) {
    const message = `Portfolio recalculation failed: ${errorMessage(error)}`;
    api.logger.warn(message);
    warnings.push(message);
  }

  try {
    const accountHoldings = await api.portfolio.getHoldings(accountId);
    const assetIds = [
      ...new Set(
        accountHoldings
          .map((holding) => holding.instrument?.id)
          .filter((assetId): assetId is string => assetId !== undefined),
      ),
    ];
    if (assetIds.length > 0) {
      await api.market.sync(assetIds, false);
    }
  } catch (error) {
    const message = `Price refresh failed: ${errorMessage(error)}`;
    api.logger.warn(message);
    warnings.push(message);
  }

  let accountValue: string | undefined;
  try {
    const [valuation] = await api.portfolio.getLatestValuations([accountId]);
    if (valuation) accountValue = String(valuation.totalValueBase);
  } catch (error) {
    const message = `Valuation read failed: ${errorMessage(error)}`;
    api.logger.warn(message);
    warnings.push(message);
  }

  return {
    snapshotDate: todayInUserTimezone(),
    positionCount: holdings.length,
    cashUsdTotal: cashBalances.USD ?? "0",
    ...(accountValue !== undefined ? { accountValue } : {}),
    warnings,
  };
}
