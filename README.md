# binance-wealthfolio-addon

Fetch your current Binance spot balances into
[Wealthfolio](https://wealthfolio.app) as a portfolio snapshot — press
**Update**, done. Runs entirely inside Wealthfolio as an addon; no separate
service to deploy.

## What it does

- Signs `GET https://api.binance.com/api/v3/account` locally (HMAC-SHA256,
  `recvWindow=5000`) through Wealthfolio's brokered network layer.
- **Stablecoins** (`USDT`, `USDC`, `FDUSD`, `TUSD`, `DAI`, `USDP`, `PYUSD`,
  `BUSD`, `USD1`) → imported as **USD cash** at the 1:1 peg, so no price feed is
  needed for them.
- **Simple Earn receipt tokens** (`LD` + underlying, e.g. `LDUSDT`, `LDBTC`,
  `LDHOME`) → remapped onto their underlying asset (`USDT`, `BTC`, `HOME`, …)
  before the rules above apply, so they are valued at market like any other
  balance. Receipt and spot balances of the same asset are merged into one
  holding (`BTC` + `LDBTC` → one `BTC` position). `LDO` (Lido DAO) is a real
  spot asset and is never stripped.
- **Everything else** → imported as **CRYPTO holdings** quoted in USD
  (`instrumentType: 'CRYPTO'`, no cost basis — Binance's balance endpoint does
  not report it).
- Writes **today's snapshot** via `snapshots.save()`, which is an upsert:
  pressing **Update** again overwrites the same day instead of duplicating it.
- Then best-effort `portfolio.recalculate()` and a quote refresh
  (`market.sync`). Failures there are shown as warnings — they never fail the
  update, because the snapshot is already stored.
- **Manual trigger only.** Addon code runs while the Binance Sync page is
  mounted; the addon runtime has no background/cron hook.

## Requirements

- **Wealthfolio 3.6.2+** (declared as `minWealthfolioVersion` in
  `manifest.json`).
- A Binance account with API access.

## Creating a Binance API key

1. Sign in to Binance → profile icon → **API Management**
   (`www.binance.com/en/my/settings/api-management`).
2. **Create API key** → system-generated key → give it a label (e.g.
   `wealthfolio`).
3. Grant **Enable Reading** only. Do **not** enable spot/futures trading or
   withdrawals — this addon only ever calls `GET /api/v3/account`.
4. Optional IP restriction: if you turn it on, include the public IP of the
   machine that runs Wealthfolio (or your self-hosted server), because the
   signed request originates from there.
5. Save and copy the **API key** and the **Secret key**. The secret is shown
   only once — if you lose it, regenerate the key pair.

## Providing the key to the addon

The addon does **not** read any `.env` file. Credentials are entered once in the
UI:

1. Open Wealthfolio → **Binance Sync** in the sidebar.
2. In the **API credentials** card, paste the API key and secret → **Save**.
3. The badge flips to _Saved_. Values are stored in the operating system's
   keyring through the addon `secrets` API (keys `binance.apiKey` and
   `binance.apiSecret`) — never on disk, never in logs, and never rendered back
   (both inputs are password fields and are cleared after saving).

To rotate credentials, paste the new pair and Save again — it overwrites the
stored pair.

> If you keep a copy in a local `.env` for convenience: the addon never reads
> it, and it is plaintext. Delete it after pasting.

## Using it

1. **API credentials** → Save (badge shows _Saved_).
2. **Account** → either pick an existing Wealthfolio account from the select, or
   click **Create** to make one named _Binance_ (type `CRYPTOCURRENCY`, holdings
   tracking, currency `USD`). The selection is persisted in the addon's
   `storage` under `binance.config`.
3. Press **Update**. On success you get:
   - a result summary: snapshot date, position count, cash USD total, optional
     account value;
   - a success toast;
   - any warnings (price refresh, recalculation) listed inline — non-fatal.

The **Update** button stays disabled until credentials are saved _and_ an
account is mapped; the hint under the button names the missing step(s).

## Debugging

### Commands

```bash
pnpm install        # once
pnpm type-check     # tsc --noEmit
pnpm test           # vitest unit tests
pnpm build          # -> dist/addon.js
pnpm dev:server     # hot-reload dev server for a live Wealthfolio
pnpm bundle         # clean + build + zip (dist/binance-wealthfolio-addon.zip)
```

### Live debugging

1. Start the addon dev server in this directory: `pnpm dev:server`.
2. From the repository root, start Wealthfolio in addon dev mode:

   ```bash
   VITE_ENABLE_ADDON_DEV_MODE=true pnpm tauri dev   # desktop
   pnpm dev:addons                                  # browser-only alternative
   ```

3. Open DevTools (F12 or right-click → Inspect) → **Console**. Addon logs are
   prefixed with `[binance]` (e.g. `[binance] SyncPage opened`). Runtime errors
   also surface as a red alert on the page and as toasts.
4. For a packaged test: `pnpm bundle`, then **Settings → Addons → Install from
   file** → pick `dist/binance-wealthfolio-addon.zip` and approve the declared
   permissions.

### Verify your credentials outside the addon

When **Update** fails, first rule the key/secret in or out with a direct request
(needs `openssl`):

```bash
export BINANCE_API_KEY=...        # API key
export BINANCE_API_SECRET=...     # Secret key

QUERY="timestamp=$(date +%s)000&recvWindow=5000"
SIG=$(printf '%s' "$QUERY" | openssl dgst -sha256 -hmac "$BINANCE_API_SECRET" | awk '{print $2}')
curl -s -H "X-MBX-APIKEY: $BINANCE_API_KEY" \
  "https://api.binance.com/api/v3/account?$QUERY&signature=$SIG"
```

- Response contains `"balances":[...]` → the credentials work; debug the addon
  side (mapping, account, permissions).
- `{"code":-2015,...}` or `{"code":-1022,...}` → credential problem, see the
  table below.

### Common errors

| Symptom                                                                  | Cause / fix                                                                                                                |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `HTTP 401/403 code=-1022 msg=Signature for this request is not valid`    | Wrong secret key, or local clock off by more than `recvWindow` (5 seconds). Sync the system clock and re-check the secret. |
| `code=-1021 msg=Timestamp for this request is outside of the recvWindow` | System clock skew > 5 s vs. Binance. Enable NTP/time sync.                                                                 |
| `code=-2015 msg=Invalid API-key, IP, or permissions for action`          | Key lacks **Enable Reading**, the calling IP is not in the key's restriction list, or key/secret pair does not match.      |
| `code=-1003` rate limit                                                  | Too many requests — wait and retry.                                                                                        |
| `No Binance account mapped yet`                                          | Map or create an account in the **Account** card.                                                                          |
| `Binance API key is missing — save it in the Binance Sync page first`    | Save credentials in the **API credentials** card.                                                                          |
| Update button disabled                                                   | The hint under it lists exactly which of the two prerequisites is missing.                                                 |
| Broker rejects the request before it leaves                              | Only `api.binance.com` is allowlisted in `manifest.json` → `network.allowedHosts`.                                         |
| `snapshots.save` fails                                                   | The mapped account must use holdings tracking mode — the **Create** button configures this correctly.                      |
| Holdings show no price                                                   | Quote refresh is best-effort; check the warnings in the result panel, or trigger a market sync from Wealthfolio itself.    |

### Unit tests

`pnpm test` covers: HMAC-SHA256 against RFC 4231 test vectors, request signing
and error shaping, balance filtering, exact decimal-string addition, the balance
→ snapshot mapping (stablecoins → cash, `LD*` receipts → underlying, `LDO` kept,
`instrumentType: 'CRYPTO'`), `runUpdate` orchestration against a mocked
`HostAPI`, config persistence, and the page's disabled-until-configured
behavior.

## Security

- API key and secret live only in the OS keyring via the addon `secrets` API.
- The secret is used solely as the HMAC signing key — it never appears in URLs,
  headers, logs, or error messages.
- Network egress is brokered by Wealthfolio and restricted to `api.binance.com`.
- Grant the key **read-only** permission; this addon cannot trade or withdraw
  even if the key allowed it (it only calls `GET /api/v3/account`).

## License

MIT
