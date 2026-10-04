import type { HostAPI } from '@wealthfolio/addon-sdk';
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@wealthfolio/ui';
import { Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { runUpdate, type UpdateResult } from '../lib/sync/run';

export interface UpdatePanelProps {
  api: HostAPI;
  loading: boolean;
  accountId: string | null;
  credentialsReady: boolean;
}

export function UpdatePanel({ api, loading, accountId, credentialsReady }: UpdatePanelProps) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<UpdateResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const missingSteps: string[] = [];
  if (!credentialsReady) missingSteps.push('save your API credentials');
  if (accountId === null) missingSteps.push('map a Binance account');
  const blockedReason = loading
    ? 'Loading configuration…'
    : missingSteps.length > 0
      ? `To enable Update, ${missingSteps.join(' and ')} below.`
      : null;

  async function handleUpdate() {
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const update = await runUpdate(api);
      setResult(update);
      api.toast.success(`Updated ${update.positionCount} positions for ${update.snapshotDate}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      api.toast.error(message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="border-primary/40">
      <CardHeader>
        <CardTitle>Update</CardTitle>
        <CardDescription>
          Fetch your current Binance balances and import them into Wealthfolio.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button size="lg" onClick={handleUpdate} disabled={pending || blockedReason !== null}>
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
          {blockedReason && <p className="text-muted-foreground text-sm">{blockedReason}</p>}
          {pending && (
            <p className="text-muted-foreground text-sm">Fetching balances from Binance…</p>
          )}
        </div>
        {result && <ResultSummary result={result} />}
      </CardContent>
    </Card>
  );
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
