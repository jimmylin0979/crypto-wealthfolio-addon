import type { HostAPI } from "@wealthfolio/addon-sdk";
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
} from "@wealthfolio/ui";
import { useState } from "react";
import { secretKeys } from "../lib/constants";
import { EXCHANGE_META, type CredentialField, type ExchangeId } from "../lib/exchanges/types";

export interface CredentialsCardProps {
  api: HostAPI;
  loading: boolean;
  exchangeId: ExchangeId;
  ready: boolean;
  onSaved: () => void;
}

const FIELD_LABELS: Record<CredentialField, string> = {
  apiKey: "API key",
  apiSecret: "API secret",
  passphrase: "Passphrase",
};

const FIELD_IDS: Record<CredentialField, string> = {
  apiKey: "api-key",
  apiSecret: "api-secret",
  passphrase: "passphrase",
};

const EMPTY_VALUES: Record<CredentialField, string> = {
  apiKey: "",
  apiSecret: "",
  passphrase: "",
};

/**
 * Credentials are written to the OS keyring through the host's Secrets API.
 * Only a boolean "saved" flag is ever read back — the stored values are never
 * rendered into an input.
 */
export function CredentialsCard({
  api,
  loading,
  exchangeId,
  ready,
  onSaved,
}: CredentialsCardProps) {
  const [values, setValues] = useState<Record<CredentialField, string>>(EMPTY_VALUES);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = EXCHANGE_META[exchangeId].label;
  const fields = EXCHANGE_META[exchangeId].credentialFields;
  const canSave = !saving && fields.every((field) => values[field].length > 0);

  function handleValueChange(field: CredentialField, value: string) {
    setValues((prev) => {
      const next: Record<CredentialField, string> = { ...prev };
      next[field] = value;
      return next;
    });
  }

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const keys = secretKeys(exchangeId);
      for (const field of fields) {
        await api.secrets.set(keys[field], values[field]);
      }
      setValues(EMPTY_VALUES);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const statusLabel = loading ? "Checking…" : ready ? "Saved" : "Not configured";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>API credentials</CardTitle>
          <Badge variant={loading || !ready ? "secondary" : "success"}>{statusLabel}</Badge>
        </div>
        <CardDescription>
          Read-only {label} API key used to fetch your current balances.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {fields.map((field) => (
          <div key={field} className="space-y-2">
            <Label htmlFor={`${exchangeId}-${FIELD_IDS[field]}`}>{FIELD_LABELS[field]}</Label>
            <Input
              id={`${exchangeId}-${FIELD_IDS[field]}`}
              type="password"
              autoComplete="off"
              value={values[field]}
              onChange={(event) => handleValueChange(field, event.target.value)}
              disabled={saving}
            />
          </div>
        ))}
        <Button onClick={handleSave} disabled={!canSave}>
          {saving ? "Saving…" : "Save"}
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
