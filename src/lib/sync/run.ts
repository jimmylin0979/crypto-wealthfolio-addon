import type { HostAPI } from '@wealthfolio/addon-sdk';
import { fetchAccountBalances } from '../binance/client';
import { SECRET_API_KEY, SECRET_API_SECRET } from '../constants';
import { readConfig } from '../storage/config';
import { buildSnapshot } from './mapping';

export interface UpdateResult {
  snapshotDate: string;
  positionCount: number;
  cashUsdTotal: string;
  accountValue?: string;
  warnings: string[];
}

function todayInUserTimezone(): string {
  const now = new Date();
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runUpdate(api: HostAPI): Promise<UpdateResult> {
  const config = await readConfig(api);
  if (config.accountId === null) {
    throw new Error('No Binance account mapped yet');
  }
  const accountId = config.accountId;

  const apiKey = await api.secrets.get(SECRET_API_KEY);
  if (!apiKey) {
    throw new Error('Binance API key is missing — save it in the Binance Sync page first.');
  }
  const apiSecret = await api.secrets.get(SECRET_API_SECRET);
  if (!apiSecret) {
    throw new Error('Binance API secret is missing — save it in the Binance Sync page first.');
  }

  const balances = await fetchAccountBalances(
    (request) => api.network.request(request),
    apiKey,
    apiSecret,
  );

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
    cashUsdTotal: cashBalances.USD ?? '0',
    ...(accountValue !== undefined ? { accountValue } : {}),
    warnings,
  };
}
