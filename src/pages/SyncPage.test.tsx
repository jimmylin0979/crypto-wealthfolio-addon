import type { Account, HostAPI } from '@wealthfolio/addon-sdk';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SECRET_API_KEY, SECRET_API_SECRET } from '../lib/constants';
import { runUpdate } from '../lib/sync/run';
import { storageKey } from '../lib/storage/keys';
import { SyncPage } from './SyncPage';

vi.mock('../lib/sync/run', () => ({
  runUpdate: vi.fn(async () => ({
    snapshotDate: '2026-10-04',
    positionCount: 3,
    cashUsdTotal: '1234.56',
    accountValue: '5678.90',
    warnings: ['Price refresh failed: provider offline'],
  })),
}));

// Partial HostAPI stand-in: only the domains SyncPage touches. Same pattern as
// the SimpleFIN addon's test/mockHost.ts.
function createApi() {
  const storage = new Map<string, string>();
  const secrets = new Map<string, string>();
  const api = {
    accounts: { getAll: vi.fn(async () => []), create: vi.fn() },
    storage: {
      get: vi.fn(async (key: string) => storage.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
    secrets: {
      get: vi.fn(async (key: string) => secrets.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        secrets.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        secrets.delete(key);
      }),
    },
    toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn() },
  } as unknown as HostAPI;
  return { api, storage, secrets };
}

function makeAccount(): Account {
  return {
    id: 'acc-1',
    name: 'Binance',
    accountType: 'CRYPTOCURRENCY',
    balance: 0,
    currency: 'USD',
    isDefault: false,
    isActive: true,
    isArchived: false,
    trackingMode: 'HOLDINGS',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('SyncPage', () => {
  it('disables Update while no account is mapped and no credentials are saved', async () => {
    const { api } = createApi();

    render(<SyncPage api={api} />);

    const updateButton = await screen.findByRole('button', { name: /update/i });
    expect(updateButton).toBeDisabled();
    expect(
      await screen.findByText(
        'To enable Update, save your API credentials and map a Binance account below.',
      ),
    ).toBeInTheDocument();
  });

  it('enables Update when credentials are saved and an account is mapped', async () => {
    const { api, storage, secrets } = createApi();
    storage.set(storageKey('config'), JSON.stringify({ accountId: 'acc-1' }));
    secrets.set(SECRET_API_KEY, 'stored-key');
    secrets.set(SECRET_API_SECRET, 'stored-secret');
    api.accounts.getAll = vi.fn(async () => [makeAccount()]);

    render(<SyncPage api={api} />);

    const updateButton = await screen.findByRole('button', { name: /update/i });
    expect(updateButton).toBeEnabled();
    expect(await screen.findByText('Currently mapped: Binance (USD)')).toBeInTheDocument();
  });

  it('never renders stored secret values back into the credential inputs', async () => {
    const { api, secrets } = createApi();
    secrets.set(SECRET_API_KEY, 'stored-key-value');
    secrets.set(SECRET_API_SECRET, 'stored-secret-value');

    render(<SyncPage api={api} />);

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.getByLabelText('API key')).toHaveValue('');
    expect(screen.getByLabelText('API secret')).toHaveValue('');
    expect(screen.queryByDisplayValue('stored-key-value')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('stored-secret-value')).not.toBeInTheDocument();
  });

  it('runs the update and shows the result summary when Update is pressed', async () => {
    const { api, storage, secrets } = createApi();
    storage.set(storageKey('config'), JSON.stringify({ accountId: 'acc-1' }));
    secrets.set(SECRET_API_KEY, 'stored-key');
    secrets.set(SECRET_API_SECRET, 'stored-secret');
    api.accounts.getAll = vi.fn(async () => [makeAccount()]);

    render(<SyncPage api={api} />);

    const updateButton = await screen.findByRole('button', { name: /update/i });
    await userEvent.click(updateButton);

    await waitFor(() => expect(runUpdate).toHaveBeenCalledWith(api));
    expect(await screen.findByText('2026-10-04')).toBeInTheDocument();
    expect(screen.getByText('1234.56')).toBeInTheDocument();
    expect(api.toast.success).toHaveBeenCalled();
  });
});
