import type { Account, HostAPI } from '@wealthfolio/addon-sdk';
import { Alert, AlertDescription } from '@wealthfolio/ui';
import { useEffect, useState } from 'react';
import { SECRET_API_KEY, SECRET_API_SECRET } from '../lib/constants';
import { readConfig, writeConfig, type BinanceConfig } from '../lib/storage/config';
import { AccountCard } from './AccountCard';
import { CredentialsCard } from './CredentialsCard';
import { UpdatePanel } from './UpdatePanel';

export interface SyncPageProps {
  api: HostAPI;
}

interface PageState {
  loading: boolean;
  error: string | null;
  config: BinanceConfig;
  accounts: Account[];
  credentialsReady: boolean;
}

const INITIAL_STATE: PageState = {
  loading: true,
  error: null,
  config: { accountId: null },
  accounts: [],
  credentialsReady: false,
};

export function SyncPage({ api }: SyncPageProps) {
  const [state, setState] = useState<PageState>(INITIAL_STATE);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      readConfig(api),
      api.accounts.getAll(),
      api.secrets.get(SECRET_API_KEY),
      api.secrets.get(SECRET_API_SECRET),
    ])
      .then(([config, accounts, apiKey, apiSecret]) => {
        if (cancelled) return;
        setState({
          loading: false,
          error: null,
          config,
          accounts,
          credentialsReady: apiKey !== null && apiSecret !== null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState((prev) => ({ ...prev, loading: false, error: message }));
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function handleMapAccount(accountId: string | null) {
    const previous = state.config;
    setState((prev) => ({ ...prev, config: { accountId }, error: null }));
    try {
      await writeConfig(api, { accountId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState((prev) => ({ ...prev, config: previous, error: message }));
    }
  }

  function handleCredentialsSaved() {
    setState((prev) => ({ ...prev, credentialsReady: true }));
  }

  function handleAccountCreated(account: Account) {
    setState((prev) => ({ ...prev, accounts: [...prev.accounts, account] }));
  }

  return (
    <div className="space-y-4">
      {state.error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <UpdatePanel
        api={api}
        loading={state.loading}
        accountId={state.config.accountId}
        credentialsReady={state.credentialsReady}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <CredentialsCard
          api={api}
          loading={state.loading}
          ready={state.credentialsReady}
          onSaved={handleCredentialsSaved}
        />
        <AccountCard
          api={api}
          loading={state.loading}
          accounts={state.accounts}
          accountId={state.config.accountId}
          onMapped={handleMapAccount}
          onAccountCreated={handleAccountCreated}
        />
      </div>
    </div>
  );
}
