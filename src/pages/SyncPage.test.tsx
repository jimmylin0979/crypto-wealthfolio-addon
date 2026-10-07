import type { Account, HostAPI } from "@wealthfolio/addon-sdk";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { secretKeys } from "../lib/constants";
import { EXCHANGE_META, type ExchangeId } from "../lib/exchanges/types";
import { runUpdate, runUpdateAll, type UpdateAllSummary } from "../lib/sync/run";
import { storageKey } from "../lib/storage/keys";
import { SyncPage } from "./SyncPage";

vi.mock("../lib/sync/run", () => ({
  runUpdate: vi.fn(async () => ({
    snapshotDate: "2026-10-04",
    positionCount: 3,
    cashUsdTotal: "1234.56",
    accountValue: "5678.90",
    warnings: ["Price refresh failed: provider offline"],
  })),
  runUpdateAll: vi.fn(
    async (): Promise<UpdateAllSummary> => ({ succeeded: [], failed: [] }),
  ),
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

function makeAccount(id = "acc-1", name = "Binance"): Account {
  return {
    id,
    name,
    accountType: "CRYPTOCURRENCY",
    balance: 0,
    currency: "USD",
    isDefault: false,
    isActive: true,
    isArchived: false,
    trackingMode: "HOLDINGS",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function seedConfig(
  storage: Map<string, string>,
  activeExchange: ExchangeId,
  exchanges: Partial<Record<ExchangeId, { accountId: string | null }>> = {},
): void {
  storage.set(
    storageKey("config"),
    JSON.stringify({
      activeExchange,
      exchanges: {
        binance: { accountId: null },
        okx: { accountId: null },
        bybit: { accountId: null },
        pionex: { accountId: null },
        ...exchanges,
      },
    }),
  );
}

function seedCredentials(secrets: Map<string, string>, exchangeId: ExchangeId): void {
  const keys = secretKeys(exchangeId);
  secrets.set(keys.apiKey, `${exchangeId}-key`);
  secrets.set(keys.apiSecret, `${exchangeId}-secret`);
  if (EXCHANGE_META[exchangeId].credentialFields.includes("passphrase")) {
    secrets.set(keys.passphrase, `${exchangeId}-passphrase`);
  }
}

describe("SyncPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists all four exchanges and persists the active exchange on switch", async () => {
    const { api, storage } = createApi();

    render(<SyncPage api={api} />);

    // Wait for the initial load to settle before switching tabs, otherwise the
    // in-flight config read could overwrite the selection we click.
    expect(await screen.findByText("No Binance account mapped yet.")).toBeInTheDocument();
    for (const name of ["Binance", "OKX", "Bybit", "Pionex"]) {
      expect(screen.getByRole("tab", { name })).toBeInTheDocument();
    }

    await userEvent.click(screen.getByRole("tab", { name: "OKX" }));

    expect(await screen.findByRole("heading", { name: "OKX sync" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "OKX" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("No OKX account mapped yet.")).toBeInTheDocument();
    expect(
      screen.getByText("Read-only OKX API key used to fetch your current balances."),
    ).toBeInTheDocument();
    await waitFor(() => {
      const stored = JSON.parse(storage.get(storageKey("config")) ?? "{}") as {
        activeExchange?: string;
      };
      expect(stored.activeExchange).toBe("okx");
    });
  });

  it("shows a passphrase field only for OKX and stores it under the OKX secret key", async () => {
    const { api, secrets } = createApi();

    render(<SyncPage api={api} />);

    await screen.findByText("No Binance account mapped yet.");
    expect(screen.getByLabelText("API key")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("API secret")).toHaveAttribute("type", "password");
    expect(screen.queryByLabelText("Passphrase")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "OKX" }));
    expect(screen.getByLabelText("Passphrase")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("API key"), "okx-key");
    await userEvent.type(screen.getByLabelText("API secret"), "okx-secret");
    await userEvent.type(screen.getByLabelText("Passphrase"), "okx-pass");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(secrets.get(secretKeys("okx").apiKey)).toBe("okx-key");
      expect(secrets.get(secretKeys("okx").apiSecret)).toBe("okx-secret");
      expect(secrets.get(secretKeys("okx").passphrase)).toBe("okx-pass");
    });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    // Values are cleared after saving — never echoed back into the inputs.
    expect(screen.getByLabelText("API key")).toHaveValue("");
    expect(screen.queryByDisplayValue("okx-key")).not.toBeInTheDocument();
  });

  it("marks credentials Saved only when every required key for the exchange exists", async () => {
    const { api, secrets } = createApi();
    secrets.set(secretKeys("binance").apiKey, "key-without-secret");

    render(<SyncPage api={api} />);

    expect(await screen.findByText("Not configured")).toBeInTheDocument();
  });

  it("disables Update while no account is mapped and no credentials are saved", async () => {
    const { api } = createApi();

    render(<SyncPage api={api} />);

    const updateButton = await screen.findByRole("button", { name: /update/i });
    expect(updateButton).toBeDisabled();
    expect(
      await screen.findByText(
        "To enable Update, save your Binance API credentials and map a Binance account below.",
      ),
    ).toBeInTheDocument();
  });

  it("disables Update per exchange until that exchange is fully configured", async () => {
    const { api, storage, secrets } = createApi();
    seedConfig(storage, "binance", { binance: { accountId: "acc-1" } });
    seedCredentials(secrets, "binance");
    api.accounts.getAll = vi.fn(async () => [makeAccount()]);

    render(<SyncPage api={api} />);

    // Binance has credentials and a mapped account → Update enabled.
    expect(await screen.findByText("Currently mapped: Binance (USD)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /update/i })).toBeEnabled();

    // OKX has neither step done → still disabled, with an OKX-specific hint.
    await userEvent.click(screen.getByRole("tab", { name: "OKX" }));
    expect(screen.getByRole("button", { name: /update/i })).toBeDisabled();
    expect(
      screen.getByText(
        "To enable Update, save your OKX API credentials and map an OKX account below.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("No OKX account mapped yet.")).toBeInTheDocument();
  });

  it("never renders stored secret values back into the credential inputs", async () => {
    const { api, secrets } = createApi();
    secrets.set(secretKeys("binance").apiKey, "stored-key-value");
    secrets.set(secretKeys("binance").apiSecret, "stored-secret-value");

    render(<SyncPage api={api} />);

    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(screen.getByLabelText("API key")).toHaveValue("");
    expect(screen.getByLabelText("API secret")).toHaveValue("");
    expect(screen.queryByDisplayValue("stored-key-value")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("stored-secret-value")).not.toBeInTheDocument();
  });

  it("preserves each exchange’s last result when switching tabs", async () => {
    const { api, storage, secrets } = createApi();
    seedConfig(storage, "binance", { binance: { accountId: "acc-1" } });
    seedCredentials(secrets, "binance");
    api.accounts.getAll = vi.fn(async () => [makeAccount()]);

    render(<SyncPage api={api} />);

    await screen.findByText("Currently mapped: Binance (USD)");
    await userEvent.click(screen.getByRole("button", { name: /update/i }));
    await waitFor(() => expect(runUpdate).toHaveBeenCalledWith(api, "binance"));
    expect(await screen.findByText("2026-10-04")).toBeInTheDocument();
    expect(screen.getByText("1234.56")).toBeInTheDocument();
    expect(screen.getByText("Price refresh failed: provider offline")).toBeInTheDocument();

    // Switching away must not show Binance's result under OKX…
    await userEvent.click(screen.getByRole("tab", { name: "OKX" }));
    expect(screen.queryByText("2026-10-04")).not.toBeInTheDocument();
    expect(screen.queryByText("1234.56")).not.toBeInTheDocument();
    expect(screen.queryByText("Price refresh failed: provider offline")).not.toBeInTheDocument();

    // …and coming back must still show it.
    await userEvent.click(screen.getByRole("tab", { name: "Binance" }));
    expect(await screen.findByText("2026-10-04")).toBeInTheDocument();
    expect(screen.getByText("1234.56")).toBeInTheDocument();
    expect(screen.getByText("Price refresh failed: provider offline")).toBeInTheDocument();
  });

  it("calls runUpdate with the active exchange id", async () => {
    const { api, storage, secrets } = createApi();
    seedConfig(storage, "binance", {
      binance: { accountId: "acc-1" },
      okx: { accountId: "acc-2" },
    });
    seedCredentials(secrets, "binance");
    seedCredentials(secrets, "okx");
    api.accounts.getAll = vi.fn(async () => [
      makeAccount("acc-1", "Binance"),
      makeAccount("acc-2", "OKX"),
    ]);

    render(<SyncPage api={api} />);

    await screen.findByText("Currently mapped: Binance (USD)");
    await userEvent.click(screen.getByRole("button", { name: /update/i }));
    await waitFor(() => expect(runUpdate).toHaveBeenCalledWith(api, "binance"));

    await userEvent.click(screen.getByRole("tab", { name: "OKX" }));
    expect(await screen.findByText("Currently mapped: OKX (USD)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /update/i }));
    await waitFor(() => expect(runUpdate).toHaveBeenCalledWith(api, "okx"));
  });

  it("disables Sync All and shows a hint while nothing is configured", async () => {
    const { api } = createApi();

    render(<SyncPage api={api} />);

    expect(await screen.findByRole("button", { name: "Sync All" })).toBeDisabled();
    expect(
      await screen.findByText(
        "No configured exchanges yet — save credentials and map an account first.",
      ),
    ).toBeInTheDocument();
  });

  it("runs Sync All over exactly the exchanges with credentials and a mapped account", async () => {
    const { api, storage, secrets } = createApi();
    seedConfig(storage, "binance", {
      binance: { accountId: "acc-1" },
      bybit: { accountId: "acc-3" },
    });
    seedCredentials(secrets, "binance");
    seedCredentials(secrets, "okx"); // credentials but no account → not eligible
    api.accounts.getAll = vi.fn(async () => [makeAccount()]);

    render(<SyncPage api={api} />);

    await screen.findByText("Currently mapped: Binance (USD)");
    const syncAllButton = screen.getByRole("button", { name: "Sync All" });
    expect(syncAllButton).toBeEnabled();
    await userEvent.click(syncAllButton);

    // Only Binance has both prerequisites: OKX lacks an account, Bybit lacks credentials.
    await waitFor(() =>
      expect(runUpdateAll).toHaveBeenCalledWith(api, ["binance"], expect.anything()),
    );
    expect(runUpdateAll).toHaveBeenCalledTimes(1);
  });

  it("disables Sync All, Update, and shows progress while a sync-all run is active", async () => {
    const { api, storage, secrets } = createApi();
    seedConfig(storage, "binance", { binance: { accountId: "acc-1" } });
    seedCredentials(secrets, "binance");
    api.accounts.getAll = vi.fn(async () => [makeAccount()]);

    let finish!: (summary: UpdateAllSummary) => void;
    vi.mocked(runUpdateAll).mockImplementationOnce(
      (_api, _exchangeIds, callbacks) => {
        callbacks?.onStarted?.("binance", 0, 1);
        return new Promise<UpdateAllSummary>((resolve) => {
          finish = resolve;
        });
      },
    );

    render(<SyncPage api={api} />);

    await screen.findByText("Currently mapped: Binance (USD)");
    await userEvent.click(screen.getByRole("button", { name: "Sync All" }));

    expect(await screen.findByRole("button", { name: /Syncing/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Updat/ })).toBeDisabled();
    expect(await screen.findByText("Syncing Binance… (1/1)")).toBeInTheDocument();

    await act(async () => {
      finish({ succeeded: ["binance"], failed: [] });
    });

    expect(await screen.findByRole("button", { name: "Sync All" })).toBeEnabled();
    expect(api.toast.success).toHaveBeenCalledWith("Synced 1 exchange(s).");
  });
});
