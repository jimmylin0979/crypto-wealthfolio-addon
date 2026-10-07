import type { HostAPI } from "@wealthfolio/addon-sdk";
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui";
import { Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { EXCHANGE_META, type ExchangeId } from "../lib/exchanges/types";
import { runUpdate, runUpdateAll, type UpdateResult } from "../lib/sync/run";

export interface UpdatePanelProps {
  api: HostAPI;
  loading: boolean;
  exchangeId: ExchangeId;
  accountId: string | null;
  credentialsReady: boolean;
  syncableExchanges: ExchangeId[];
}

export function UpdatePanel({
  api,
  loading,
  exchangeId,
  accountId,
  credentialsReady,
  syncableExchanges,
}: UpdatePanelProps) {
  const [pendingExchange, setPendingExchange] = useState<ExchangeId | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [allProgress, setAllProgress] = useState<{
    label: string;
    index: number;
    total: number;
  } | null>(null);
  const [results, setResults] = useState<Partial<Record<ExchangeId, UpdateResult>>>({});
  const [errors, setErrors] = useState<Partial<Record<ExchangeId, string>>>({});

  const label = EXCHANGE_META[exchangeId].label;
  const article = /^[AEIOU]/i.test(label) ? "an" : "a";
  // Results, warnings, and errors are keyed per exchange so switching tabs
  // shows each exchange's own last outcome instead of someone else's.
  const result = results[exchangeId];
  const error = errors[exchangeId] ?? null;
  const pending = pendingExchange === exchangeId;
  const busy = pendingExchange !== null || syncingAll;

  const missingSteps: string[] = [];
  if (!credentialsReady) missingSteps.push(`save your ${label} API credentials`);
  if (accountId === null) missingSteps.push(`map ${article} ${label} account`);
  const blockedReason = loading
    ? "Loading configuration…"
    : missingSteps.length > 0
      ? `To enable Update, ${missingSteps.join(" and ")} below.`
      : null;

  async function handleUpdate() {
    setPendingExchange(exchangeId);
    setErrors((prev) => {
      const next = { ...prev };
      delete next[exchangeId];
      return next;
    });
    setResults((prev) => {
      const next = { ...prev };
      delete next[exchangeId];
      return next;
    });
    try {
      const update = await runUpdate(api, exchangeId);
      setResults((prev) => {
        const next: Partial<Record<ExchangeId, UpdateResult>> = { ...prev };
        next[exchangeId] = update;
        return next;
      });
      api.toast.success(`Updated ${update.positionCount} positions for ${update.snapshotDate}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrors((prev) => {
        const next: Partial<Record<ExchangeId, string>> = { ...prev };
        next[exchangeId] = message;
        return next;
      });
      api.toast.error(message);
    } finally {
      setPendingExchange(null);
    }
  }

  async function handleSyncAll() {
    setSyncingAll(true);
    // Prior outcomes for other exchanges are left untouched: onSettled
    // overwrites each synced exchange's own entry as it lands, so a run over
    // a subset never wipes results of exchanges it did not sync.
    try {
      const summary = await runUpdateAll(api, syncableExchanges, {
        onStarted: (startedId, index, total) => {
          setPendingExchange(startedId);
          setAllProgress({ label: EXCHANGE_META[startedId].label, index, total });
        },
        onSettled: (settledId, outcome) => {
          if (outcome.ok) {
            setResults((prev) => ({ ...prev, [settledId]: outcome.result }));
            setErrors((prev) => {
              const next = { ...prev };
              delete next[settledId];
              return next;
            });
          } else {
            setErrors((prev) => ({ ...prev, [settledId]: outcome.error }));
            setResults((prev) => {
              const next = { ...prev };
              delete next[settledId];
              return next;
            });
          }
        },
      });
      if (summary.failed.length === 0) {
        api.toast.success(`Synced ${summary.succeeded.length} exchange(s).`);
      } else {
        const total = summary.succeeded.length + summary.failed.length;
        // Cap the detail: exchange errors can be whole response bodies.
        const detail = summary.failed
          .slice(0, 3)
          .map(
            ({ exchangeId: failedId, message }) =>
              `${EXCHANGE_META[failedId].label}: ${truncateForToast(message)}`,
          )
          .join("; ");
        const overflow =
          summary.failed.length > 3 ? `; and ${summary.failed.length - 3} more` : "";
        api.toast.error(`${summary.failed.length} of ${total} exchanges failed: ${detail}${overflow}`);
      }
    } finally {
      setPendingExchange(null);
      setAllProgress(null);
      setSyncingAll(false);
    }
  }

  return (
    <Card className="border-primary/40">
      <CardHeader>
        <CardTitle>Update</CardTitle>
        <CardDescription>
          Fetch your current {label} balances and import them into Wealthfolio.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button size="lg" onClick={handleUpdate} disabled={busy || blockedReason !== null}>
            {pending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Updating…
              </>
            ) : (
              <>
                <RefreshCw className="h-4 w-4" />
                Update
              </>
            )}
          </Button>
          <Button
            variant="outline"
            size="lg"
            onClick={handleSyncAll}
            disabled={busy || loading || syncableExchanges.length === 0}
          >
            {syncingAll ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Syncing…
              </>
            ) : (
              <>
                <RefreshCw className="h-4 w-4" />
                Sync All
              </>
            )}
          </Button>
          {blockedReason && <p className="text-muted-foreground text-sm">{blockedReason}</p>}
          {!loading && syncableExchanges.length === 0 && (
            <p className="text-muted-foreground text-sm">
              No configured exchanges yet — save credentials and map an account first.
            </p>
          )}
          {pending && (
            <p className="text-muted-foreground text-sm">Fetching balances from {label}…</p>
          )}
          {syncingAll && allProgress && (
            <p className="text-muted-foreground text-sm">
              Syncing {allProgress.label}… ({allProgress.index + 1}/{allProgress.total})
            </p>
          )}
        </div>
        {result && <ResultSummary result={result} />}
      </CardContent>
    </Card>
  );
}

function truncateForToast(message: string): string {
  const MAX_TOAST_MESSAGE = 80;
  return message.length > MAX_TOAST_MESSAGE ? `${message.slice(0, MAX_TOAST_MESSAGE)}…` : message;
}

function ResultSummary({ result }: { result: UpdateResult }) {
  return (
    <div className="space-y-2 rounded-md border p-4">
      <p className="text-sm font-medium">Last update</p>
      <dl className="space-y-1 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Snapshot date</dt>
          <dd>{result.snapshotDate}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Positions</dt>
          <dd>{result.positionCount}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Cash (USD)</dt>
          <dd>{result.cashUsdTotal}</dd>
        </div>
        {result.accountValue !== undefined && (
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Account value</dt>
            <dd>{result.accountValue}</dd>
          </div>
        )}
      </dl>
      {result.warnings.length > 0 && (
        <div className="space-y-1">
          <p className="text-warning text-sm font-medium">Warnings</p>
          <ul className="text-warning list-disc pl-5 text-sm">
            {result.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
