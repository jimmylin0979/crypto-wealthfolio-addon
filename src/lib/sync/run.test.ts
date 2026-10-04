import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountValuation, Holding, HostAPI } from '@wealthfolio/addon-sdk';
import { fetchAccountBalances } from '../binance/client';
import { SECRET_API_KEY, SECRET_API_SECRET } from '../constants';
import { runUpdate } from './run';

vi.mock('../binance/client', () => ({
  fetchAccountBalances: vi.fn(),
}));

const ACCOUNT_ID = 'WF-BINANCE-1';

function createApi(): HostAPI {
  return {
    storage: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    },
    secrets: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    },
    network: {
      request: vi.fn(async () => ({ status: 200, headers: {}, body: '' })),
    },
    snapshots: { save: vi.fn(async () => {}) },
    portfolio: {
      recalculate: vi.fn(async () => {}),
      getHoldings: vi.fn(async () => []),
      getLatestValuations: vi.fn(async () => []),
    },
    market: { sync: vi.fn(async () => {}) },
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() },
  } as unknown as HostAPI;
}

function mappedApi(): HostAPI {
  const api = createApi();
  vi.mocked(api.storage.get).mockResolvedValue(JSON.stringify({ accountId: ACCOUNT_ID }));
  vi.mocked(api.secrets.get).mockImplementation(async (key: string) =>
    key === SECRET_API_KEY ? 'test-key' : key === SECRET_API_SECRET ? 'test-secret' : null,
  );
  return api;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('runUpdate', () => {
  it('writes one today-dated snapshot with USD cash and a CRYPTO holding', async () => {
    const api = mappedApi();
    vi.mocked(fetchAccountBalances).mockResolvedValue([
      { asset: 'USDT', free: '100.5', locked: '0.5' },
      { asset: 'USDC', free: '10', locked: '0' },
      { asset: 'BTC', free: '0.5', locked: '0.1' },
      { asset: 'ETH', free: '0', locked: '0' },
    ]);
    vi.mocked(api.portfolio.getHoldings).mockResolvedValue([
      { id: 'h1', instrument: { id: 'asset-btc' } },
      { id: 'h2', instrument: null },
    ] as unknown as Holding[]);
    vi.mocked(api.portfolio.getLatestValuations).mockResolvedValue([
      { accountId: ACCOUNT_ID, totalValueBase: 1234.5 },
    ] as unknown as AccountValuation[]);

    const result = await runUpdate(api);

    expect(fetchAccountBalances).toHaveBeenCalledWith(expect.any(Function), 'test-key', 'test-secret');
    expect(api.snapshots.save).toHaveBeenCalledWith(ACCOUNT_ID, [
      {
        symbol: 'BTC',
        quantity: '0.6',
        currency: 'USD',
        quoteCcy: 'USD',
        instrumentType: 'CRYPTO',
      },
    ], { USD: '111' });
    expect(api.portfolio.recalculate).toHaveBeenCalled();
    expect(api.market.sync).toHaveBeenCalledWith(['asset-btc'], false);
    expect(result.snapshotDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.positionCount).toBe(1);
    expect(result.cashUsdTotal).toBe('111');
    expect(result.accountValue).toBe('1234.5');
    expect(result.warnings).toEqual([]);
  });

  it('throws before fetching when no account is mapped', async () => {
    const api = createApi();

    await expect(runUpdate(api)).rejects.toThrow('No Binance account mapped yet');
    expect(fetchAccountBalances).not.toHaveBeenCalled();
  });

  it('throws when the API key is missing, without echoing secrets', async () => {
    const api = mappedApi();
    vi.mocked(api.secrets.get).mockResolvedValue(null);

    const failure = runUpdate(api);
    await expect(failure).rejects.toThrow(/API key is missing/);
    await expect(failure).rejects.not.toThrow(/test-/);
    expect(fetchAccountBalances).not.toHaveBeenCalled();
  });

  it('throws when the API secret is missing', async () => {
    const api = mappedApi();
    vi.mocked(api.secrets.get).mockImplementation(async (key: string) =>
      key === SECRET_API_KEY ? 'test-key' : null,
    );

    const failure = runUpdate(api);
    await expect(failure).rejects.toThrow(/API secret is missing/);
    await expect(failure).rejects.not.toThrow(/test-key/);
    expect(fetchAccountBalances).not.toHaveBeenCalled();
  });

  it('records warnings instead of throwing when best-effort steps fail', async () => {
    const api = mappedApi();
    vi.mocked(fetchAccountBalances).mockResolvedValue([
      { asset: 'USDT', free: '10', locked: '0' },
      { asset: 'BTC', free: '1', locked: '0' },
    ]);
    vi.mocked(api.portfolio.recalculate).mockRejectedValue(new Error('calc backend down'));
    vi.mocked(api.portfolio.getHoldings).mockResolvedValue([
      { id: 'h1', instrument: { id: 'asset-btc' } },
    ] as unknown as Holding[]);
    vi.mocked(api.market.sync).mockRejectedValue(new Error('quote backend down'));

    const result = await runUpdate(api);

    expect(api.snapshots.save).toHaveBeenCalledTimes(1);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toMatch(/Portfolio recalculation failed/);
    expect(result.warnings[1]).toMatch(/Price refresh failed/);
    expect(result.cashUsdTotal).toBe('10');
  });

  it('throws when the balance fetch fails', async () => {
    const api = mappedApi();
    vi.mocked(fetchAccountBalances).mockRejectedValue(new Error('Binance API: Invalid API-key'));

    await expect(runUpdate(api)).rejects.toThrow(/Invalid API-key/);
    expect(api.snapshots.save).not.toHaveBeenCalled();
  });
});
