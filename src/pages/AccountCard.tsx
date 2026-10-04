import type { Account, HostAPI } from '@wealthfolio/addon-sdk';
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
} from '@wealthfolio/ui';
import { useState } from 'react';

/**
 * A native `<select>` instead of `@wealthfolio/ui`'s Radix `Select` because
 * `userEvent.selectOptions` (how tests choose an option) does not work against
 * Radix's listbox in jsdom. The class string matches the UI kit's input styling.
 */
const nativeSelectClassName =
  'border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm';

export interface AccountCardProps {
  api: HostAPI;
  loading: boolean;
  accounts: Account[];
  accountId: string | null;
  onMapped: (accountId: string | null) => void;
  onAccountCreated: (account: Account) => void;
}

export function AccountCard({
  api,
  loading,
  accounts,
  accountId,
  onMapped,
  onAccountCreated,
}: AccountCardProps) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mapped = accounts.find((account) => account.id === accountId);

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      const account = await api.accounts.create({
        name: 'Binance',
        accountType: 'CRYPTOCURRENCY',
        trackingMode: 'HOLDINGS',
        currency: 'USD',
        isDefault: false,
        isActive: true,
      });
      onAccountCreated(account);
      onMapped(account.id);
      api.toast.success(`Created account "${account.name}"`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  const mappingSummary = loading
    ? 'Loading accounts…'
    : mapped
      ? `Currently mapped: ${mapped.name} (${mapped.currency})`
      : accountId
        ? `Currently mapped: account ${accountId} was not found.`
        : 'No account mapped yet.';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Account</CardTitle>
        <CardDescription>
          Wealthfolio account that receives your Binance balances as a holdings snapshot.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <Label htmlFor="binance-account">Mapped account</Label>
          <select
            id="binance-account"
            className={nativeSelectClassName}
            value={accountId ?? ''}
            onChange={(e) => onMapped(e.target.value || null)}
            disabled={loading}
          >
            <option value="">Select an account…</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} ({account.currency})
              </option>
            ))}
          </select>
          <p className="text-muted-foreground text-sm">{mappingSummary}</p>
        </div>
        <Button variant="outline" onClick={handleCreate} disabled={creating || loading}>
          {creating ? 'Creating…' : 'Create Binance account'}
        </Button>
      </CardContent>
    </Card>
  );
}
