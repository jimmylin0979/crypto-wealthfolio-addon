import { describe, expect, it, vi } from 'vitest';
import type { HostAPI } from '@wealthfolio/addon-sdk';
import { readConfig, writeConfig } from './config';
import { storageKey } from './keys';

function createApi(): HostAPI {
  const stored = new Map<string, string>();
  return {
    storage: {
      get: vi.fn(async (key: string) => stored.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => void stored.set(key, value)),
      delete: vi.fn(async (key: string) => void stored.delete(key)),
    },
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() },
  } as unknown as HostAPI;
}

describe('config', () => {
  it('round-trips the mapped account under the binance.config key', async () => {
    const api = createApi();

    await writeConfig(api, { accountId: 'WF-1' });

    expect(api.storage.set).toHaveBeenCalledWith(
      storageKey('config'),
      JSON.stringify({ accountId: 'WF-1' }),
    );
    await expect(readConfig(api)).resolves.toEqual({ accountId: 'WF-1' });
  });

  it('returns an unmapped config when nothing is stored', async () => {
    await expect(readConfig(createApi())).resolves.toEqual({ accountId: null });
  });

  it('falls back to unmapped when the stored value is corrupt', async () => {
    const api = createApi();
    vi.mocked(api.storage.get).mockResolvedValue('not json');

    await expect(readConfig(api)).resolves.toEqual({ accountId: null });
    expect(api.logger.error).toHaveBeenCalled();
  });

  it('treats a non-string accountId as unmapped', async () => {
    const api = createApi();
    vi.mocked(api.storage.get).mockResolvedValue(JSON.stringify({ accountId: 42 }));

    await expect(readConfig(api)).resolves.toEqual({ accountId: null });
  });
});
