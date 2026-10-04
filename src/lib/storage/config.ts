import type { HostAPI } from '@wealthfolio/addon-sdk';
import { storageKey } from './keys';

export interface BinanceConfig {
  accountId: string | null;
}

const CONFIG_KEY = storageKey('config');

export async function readConfig(api: HostAPI): Promise<BinanceConfig> {
  const raw = await api.storage.get(CONFIG_KEY);
  if (!raw) return { accountId: null };

  try {
    const parsed = JSON.parse(raw) as Partial<BinanceConfig>;
    return { accountId: typeof parsed.accountId === 'string' ? parsed.accountId : null };
  } catch (error) {
    // Falling back to an unmapped config sends the user back to the mapping
    // step, which is recoverable; throwing would brick the addon page.
    api.logger.error(`[binance] corrupt config, falling back to unmapped: ${String(error)}`);
    return { accountId: null };
  }
}

export async function writeConfig(api: HostAPI, config: BinanceConfig): Promise<void> {
  await api.storage.set(CONFIG_KEY, JSON.stringify(config));
}
