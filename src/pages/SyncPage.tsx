import type { Account, HostAPI } from "@wealthfolio/addon-sdk";
import { Alert, AlertDescription, Tabs, TabsContent, TabsList, TabsTrigger } from "@wealthfolio/ui";
import { useEffect, useState } from "react";
import { secretKeys } from "../lib/constants";
import { EXCHANGE_IDS, EXCHANGE_META, isExchangeId, type ExchangeId } from "../lib/exchanges/types";
import { readConfig, writeConfig, type AddonConfig } from "../lib/storage/config";
import { AccountCard } from "./AccountCard";
import { CredentialsCard } from "./CredentialsCard";
import { UpdatePanel } from "./UpdatePanel";

export interface SyncPageProps {
  api: HostAPI;
}

type AccountMapping = { accountId: string | null };

const UNMAPPED_EXCHANGES: Record<ExchangeId, AccountMapping> = {
  binance: { accountId: null },
  okx: { accountId: null },
  bybit: { accountId: null },
  pionex: { accountId: null },
};

const NO_CREDENTIALS: Record<ExchangeId, boolean> = {
  binance: false,
  okx: false,
  bybit: false,
  pionex: false,
};

interface PageState {
  loading: boolean;
  error: string | null;
  config: AddonConfig;
  accounts: Account[];
  credentialsReady: Record<ExchangeId, boolean>;
}

const INITIAL_STATE: PageState = {
  loading: true,
  error: null,
  config: { activeExchange: "binance", exchanges: UNMAPPED_EXCHANGES },
  accounts: [],
  credentialsReady: NO_CREDENTIALS,
};

/**
 * Credentials count as saved only when every secret key the exchange requires
 * (API key + secret, plus the passphrase for OKX) exists in the keyring. Only
 * presence is ever read — never the stored values.
 */
async function readCredentialsReady(api: HostAPI): Promise<Record<ExchangeId, boolean>> {
  const ready: Record<ExchangeId, boolean> = { ...NO_CREDENTIALS };
  await Promise.all(
    EXCHANGE_IDS.map(async (exchangeId) => {
      const keys = secretKeys(exchangeId);
      const stored = await Promise.all(
        EXCHANGE_META[exchangeId].credentialFields.map((field) => api.secrets.get(keys[field])),
      );
      ready[exchangeId] = stored.every((value) => value !== null && value !== "");
    }),
  );
  return ready;
}

export function SyncPage({ api }: SyncPageProps) {
  const [state, setState] = useState<PageState>(INITIAL_STATE);

  useEffect(() => {
    let cancelled = false;
    Promise.all([readConfig(api), api.accounts.getAll(), readCredentialsReady(api)])
      .then(([config, accounts, credentialsReady]) => {
        if (cancelled) return;
        setState({ loading: false, error: null, config, accounts, credentialsReady });
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

  const activeExchange = state.config.activeExchange;
  const activeLabel = EXCHANGE_META[activeExchange].label;
  const activeAccountId = state.config.exchanges?.[activeExchange]?.accountId ?? null;
  // Sync All only touches exchanges runUpdate could succeed for: saved
  // credentials and a mapped Wealthfolio account, both required.
  const syncableExchanges = EXCHANGE_IDS.filter(
    (exchangeId) =>
      state.credentialsReady[exchangeId] === true &&
      (state.config.exchanges?.[exchangeId]?.accountId ?? null) !== null,
  );

  async function handleSelectExchange(exchangeId: ExchangeId) {
    if (exchangeId === state.config.activeExchange) return;
    const previous = state.config;
    const next: AddonConfig = { ...state.config, activeExchange: exchangeId };
    setState((prev) => ({ ...prev, config: next, error: null }));
    try {
      await writeConfig(api, next);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState((prev) => ({ ...prev, config: previous, error: message }));
    }
  }

  function handleExchangeChange(value: string) {
    if (!isExchangeId(value)) return;
    handleSelectExchange(value);
  }

  async function handleMapAccount(exchangeId: ExchangeId, accountId: string | null) {
    const previous = state.config;
    const exchanges: Record<ExchangeId, AccountMapping> = {
      ...(state.config.exchanges ?? UNMAPPED_EXCHANGES),
    };
    exchanges[exchangeId] = { accountId };
    const next: AddonConfig = { ...state.config, exchanges };
    setState((prev) => ({ ...prev, config: next, error: null }));
    try {
      await writeConfig(api, next);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState((prev) => ({ ...prev, config: previous, error: message }));
    }
  }

  function handleCredentialsSaved(exchangeId: ExchangeId) {
    setState((prev) => {
      const credentialsReady: Record<ExchangeId, boolean> = { ...prev.credentialsReady };
      credentialsReady[exchangeId] = true;
      return { ...prev, credentialsReady };
    });
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
      <Tabs value={activeExchange} onValueChange={handleExchangeChange}>
        <div className="space-y-4">
          <div className="space-y-2">
            <h1 className="text-lg font-semibold tracking-tight">{activeLabel} sync</h1>
            <TabsList>
              {EXCHANGE_IDS.map((exchangeId) => (
                <TabsTrigger key={exchangeId} value={exchangeId}>
                  {EXCHANGE_META[exchangeId].label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <UpdatePanel
            api={api}
            loading={state.loading}
            exchangeId={activeExchange}
            accountId={activeAccountId}
            credentialsReady={state.credentialsReady[activeExchange]}
            syncableExchanges={syncableExchanges}
          />
          {EXCHANGE_IDS.map((exchangeId) => (
            <TabsContent key={exchangeId} value={exchangeId} className="mt-0">
              <div className="grid gap-4 lg:grid-cols-2">
                <CredentialsCard
                  api={api}
                  loading={state.loading}
                  exchangeId={exchangeId}
                  ready={state.credentialsReady[exchangeId]}
                  onSaved={() => handleCredentialsSaved(exchangeId)}
                />
                <AccountCard
                  api={api}
                  loading={state.loading}
                  accounts={state.accounts}
                  exchangeId={exchangeId}
                  accountId={state.config.exchanges?.[exchangeId]?.accountId ?? null}
                  onMapped={(accountId) => handleMapAccount(exchangeId, accountId)}
                  onAccountCreated={handleAccountCreated}
                />
              </div>
            </TabsContent>
          ))}
        </div>
      </Tabs>
    </div>
  );
}
