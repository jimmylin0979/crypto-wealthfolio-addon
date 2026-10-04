import type { HostAPI } from '@wealthfolio/addon-sdk';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@wealthfolio/ui';
import { useState } from 'react';
import { SECRET_API_KEY, SECRET_API_SECRET } from '../lib/constants';

export interface CredentialsCardProps {
  api: HostAPI;
  loading: boolean;
  ready: boolean;
  onSaved: () => void;
}

/**
 * Credentials are written to the OS keyring through the host's Secrets API.
 * Only a boolean "saved" flag is ever read back — the stored values are never
 * rendered into an input.
 */
export function CredentialsCard({ api, loading, ready, onSaved }: CredentialsCardProps) {
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = apiKey.length > 0 && apiSecret.length > 0 && !saving;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await api.secrets.set(SECRET_API_KEY, apiKey);
      await api.secrets.set(SECRET_API_SECRET, apiSecret);
      setApiKey('');
      setApiSecret('');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const statusLabel = loading ? 'Checking…' : ready ? 'Saved' : 'Not configured';

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>API credentials</CardTitle>
          <Badge variant={loading || !ready ? 'secondary' : 'success'}>{statusLabel}</Badge>
        </div>
        <CardDescription>
          Read-only Binance API key used to fetch your current balances.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <Label htmlFor="binance-api-key">API key</Label>
          <Input
            id="binance-api-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={saving}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="binance-api-secret">API secret</Label>
          <Input
            id="binance-api-secret"
            type="password"
            autoComplete="off"
            value={apiSecret}
            onChange={(e) => setApiSecret(e.target.value)}
            disabled={saving}
          />
        </div>
        <Button onClick={handleSave} disabled={!canSave}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <p className="text-muted-foreground text-sm">
          Create a <strong>read-only</strong> API key with no trade or withdraw permission.
          Credentials are stored in your operating system's keyring through Wealthfolio and are
          never logged.
        </p>
      </CardContent>
    </Card>
  );
}
