# binance-wealthfolio-addon

Fetch your current **Binance, OKX, Bybit, or Pionex** balances into
[Wealthfolio](https://wealthfolio.app) as a portfolio snapshot — pick the
exchange, press **Update**, done. Runs entirely inside Wealthfolio as an addon;
no separate service to deploy.

> The addon id and route stay `binance-wealthfolio-addon` (storage keys and the
> sidebar route are prefixed `binance.`), but the UI and manifest present it as
> **Exchange Sync**.

## What it does

- Signs each exchange's balance endpoint locally through Wealthfolio's brokered
  network layer — the secret never leaves the keyring:

  | Exchange | Requests (per Update)                                                                                                      | Auth                                                                                |
  | -------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
  | Binance  | `GET https://api.binance.com/api/v3/account`                                                                               | HMAC-SHA256 hex query `signature`, header `X-MBX-APIKEY`, `recvWindow=5000`         |
  | OKX      | `GET /api/v5/account/balance` + `GET /api/v5/asset/balances` + `GET /api/v5/finance/savings/balance` on `www.okx.com`                | HMAC-SHA256 **base64** `OK-ACCESS-SIGN`, ISO-8601 `OK-ACCESS-TIMESTAMP`, passphrase |
  | Bybit    | `GET /v5/account/wallet-balance?accountType=UNIFIED` + `…/query-account-coins-balance?accountType=FUND` on `api.bybit.com` | HMAC-SHA256 hex `X-BAPI-SIGN` over `timestamp + apiKey + recvWindow + queryString`  |
  | Pionex   | `GET /api/v1/account/balances` + `GET /api/v1/bot/orders` (spot grid) on `api.pionex.com`                                  | HMAC-SHA256 hex `PIONEX-SIGNATURE` over `GET<path>?<sorted-query>`                  |

- **Trading-bot funds are included.** Running spot-grid bots hold coins outside
  the plain balance endpoints, so the Update accounts for them per exchange:
  **Pionex** explicitly excludes bot funds from its balance response, so the
  Update reads `GET /api/v1/bot/orders?status=running` and merges
  `buOrderData.baseAmount` + `buOrderData.quoteAmount` into the same snapshot
  (additive — no double-counting). **OKX** needs no extra request: the trading
  balance endpoint already reports bot funds as strategy equity inside
  `frozenBal` (verified live), so they arrive with the normal rows — merging
  `tradingBot` details on top would double-count them. **Binance and Bybit
  expose no official API to list bots** (see
  [Known limitations](#known-limitations)).
- **Simple Earn (OKX flexible savings) is included.** Subscribed savings are
  debited out of the funding account into a separate Earn account, so the
  Update reads a third endpoint, `GET /api/v5/finance/savings/balance`, and
  merges its rows additively: `amt` is the total held (principal plus accrued
  earnings), reported with `locked: "0"`. The same ccy appearing in both the
  funding and savings responses means disjoint amounts, not double-counting.
  Fixed-term (定期) savings are not synced (see
  [Known limitations](#known-limitations)).
- **Stablecoins** (`USDT`, `USDC`, `FDUSD`, `TUSD`, `DAI`, `USDP`, `PYUSD`,
  `BUSD`, `USD1`) → imported as **USD cash** at the 1:1 peg, so no price feed is
  needed for them.
- **Binance Simple Earn receipt tokens** (`LD` + underlying, e.g. `LDUSDT`,
  `LDBTC`, `LDHOME`) → remapped onto their underlying asset (`USDT`, `BTC`,
  `HOME`, …) before the rules above apply. Receipt and spot balances of the same
  asset are merged into one holding (`BTC` + `LDBTC` → one `BTC` position).
  `LDO` (Lido DAO) is a real spot asset and is never stripped.
- **Everything else** → imported as **CRYPTO holdings** quoted in USD
  (`instrumentType: 'CRYPTO'`, no cost basis — balance endpoints do not report
  it).
- Writes **today's snapshot** via `snapshots.save()`, which is an upsert:
  pressing **Update** again overwrites the same day instead of duplicating it.
- Then best-effort `portfolio.recalculate()` and a quote refresh
  (`market.sync`). Failures there are shown as warnings — they never fail the
  update, because the snapshot is already stored.
- **Manual trigger only.** Addon code runs while the Exchange Sync page is
  mounted; the addon runtime has no background/cron hook.
- Each exchange maps to **its own Wealthfolio account**; credentials, mapping,
  and the last result are kept per exchange, so you can flip between tabs
  without losing state.

## Requirements

- **Wealthfolio 3.6.2+** (declared as `minWealthfolioVersion` in
  `manifest.json`).
- An account on whichever exchange you want to sync, with API access.

## Creating API keys

Grant **read-only** permission only. This addon only ever calls the balance GET
endpoints listed above — it cannot trade or withdraw even if the key allowed it.

- **Binance** — profile icon → **API Management**
  (`www.binance.com/en/my/settings/api-management`) → **Create API key** →
  system-generated → **Enable Reading** only. Copy the API key and Secret key
  (the secret is shown only once).
- **OKX** — **Profile → API** (`www.okx.com/app/api`) → create a key with
  **Read** permission. You will need three values: **API key**, **Secret key**,
  and the **Passphrase** you set when creating the key.
- **Bybit** — **Account & Security → API Management** → create an API key with
  **Read only** permission. Copy the API key and secret.
- **Pionex** — **Account → API Management** (`www.pionex.com/my-account/api`) →
  **Create API** with **Enable reading** _and_ **Bot reading** both checked —
  the bot-order endpoint requires `Bot reading` separately; a read-only key
  without it makes Update fail on the bot request. Copy the API key and secret.

IP restriction is optional; if you enable it, include the public IP of the
machine that runs Wealthfolio (or your self-hosted server), because the signed
request originates from there. Bybit additionally invalidates keys with no IP
bound after 90 days of inactivity; OKX expires unbound keys that carry
trade/withdraw permission after 14 days.

## Providing credentials to the addon

The addon does **not** read any `.env` file. Credentials are entered once in the
UI:

1. Open Wealthfolio → **Exchange Sync** in the sidebar.
2. Pick the exchange tab (Binance / OKX / Bybit / Pionex).
3. In the **API credentials** card, paste the values (OKX also asks for the
   **passphrase**) → **Save**.
4. The badge flips to _Saved_. Values are stored in the operating system's
   keyring through the addon `secrets` API under `<exchange>.apiKey`,
   `<exchange>.apiSecret`, and (OKX) `<exchange>.passphrase` — never on disk,
   never in logs, and never rendered back (all inputs are password fields and
   are cleared after saving).

To rotate credentials, paste the new values and Save again — it overwrites the
stored ones.

> If you keep a copy in a local `.env` for convenience: the addon never reads
> it, and it is plaintext. Delete it after pasting.

## Using it

1. Choose the exchange tab.
2. **API credentials** → Save (badge shows _Saved_).
3. **Account** → either pick an existing Wealthfolio account from the select, or
   click **Create** to make one named after the exchange (type `CRYPTOCURRENCY`,
   holdings tracking, currency `USD`). The selection is persisted per exchange
   in the addon's `storage` under `binance.config`.
4. Press **Update**. On success you get:
   - a result summary: snapshot date, position count, cash USD total, optional
     account value;
   - a success toast;
   - any warnings (price refresh, recalculation) listed inline — non-fatal.

The **Update** button stays disabled until credentials are saved _and_ an
account is mapped for the active exchange; the hint under the button names the
missing step(s).

## Debugging

### Commands

```bash
npx pnpm install        # once (plain `pnpm` may not be on PATH)
npx pnpm type-check     # tsc --noEmit
npx pnpm test           # vitest unit tests
npx pnpm build          # -> dist/addon.js
npx pnpm dev:server     # hot-reload dev server for a live Wealthfolio
npx pnpm bundle         # clean + build + zip (dist/binance-wealthfolio-addon.zip)
```

### Live debugging

1. Start the addon dev server in this directory: `npx pnpm dev:server`.
2. From the repository root, start Wealthfolio in addon dev mode:

   ```bash
   VITE_ENABLE_ADDON_DEV_MODE=true pnpm tauri dev   # desktop
   pnpm dev:addons                                  # browser-only alternative
   ```

3. Open DevTools (F12 or right-click → **Inspect**) → **Console**. Addon logs
   are prefixed with `[binance]` (e.g. `[binance] SyncPage opened`). Runtime
   errors also surface as a red alert on the page and as toasts. After editing
   `manifest.json`, run `discoverAddons()` / `reloadAddons()` in the console to
   re-discover without restarting (dev discovery scans port **3001** only).
4. For a packaged test: `npx pnpm bundle`, then **Settings → Addons → Install
   from file** → pick `dist/binance-wealthfolio-addon.zip` and approve the
   declared permissions.

### Verify your credentials outside the addon

When **Update** fails, first rule the key/secret in or out with a direct request
(needs `openssl`).

**Binance:**

```bash
export BINANCE_API_KEY=...        # API key
export BINANCE_API_SECRET=...     # Secret key

QUERY="timestamp=$(date +%s)000&recvWindow=5000"
SIG=$(printf '%s' "$QUERY" | openssl dgst -sha256 -hmac "$BINANCE_API_SECRET" | awk '{print $2}')
curl -s -H "X-MBX-APIKEY: $BINANCE_API_KEY" \
  "https://api.binance.com/api/v3/account?$QUERY&signature=$SIG"
```

**Bybit:**

```bash
export BYBIT_API_KEY=...
export BYBIT_API_SECRET=...

TS=$(date +%s%3N); RECV=5000; QS="accountType=UNIFIED"
SIG=$(printf '%s' "${TS}${BYBIT_API_KEY}${RECV}${QS}" | openssl dgst -sha256 -hmac "$BYBIT_API_SECRET" | awk '{print $2}')
curl -s -H "X-BAPI-API-KEY: $BYBIT_API_KEY" -H "X-BAPI-TIMESTAMP: $TS" \
  -H "X-BAPI-RECV-WINDOW: $RECV" -H "X-BAPI-SIGN: $SIG" \
  "https://api.bybit.com/v5/account/wallet-balance?$QS"
```

**Pionex:**

```bash
export PIONEX_API_KEY=...
export PIONEX_API_SECRET=...

TS=$(date +%s%3N)
SIG=$(printf '%s' "GET/api/v1/account/balances?timestamp=$TS" | openssl dgst -sha256 -hmac "$PIONEX_API_SECRET" | awk '{print $2}')
curl -s -H "PIONEX-KEY: $PIONEX_API_KEY" -H "PIONEX-SIGNATURE: $SIG" \
  "https://api.pionex.com/api/v1/account/balances?timestamp=$TS"
```

**OKX** (three calls — trading, funding, savings; add `x-simulated-trading: 1`
only for demo keys). The same signing scheme applies to every path — swap
`/api/v5/account/balance` for `/api/v5/asset/balances` or
`/api/v5/finance/savings/balance` and recompute `SIG` over `${TS}GET<path>`:

```bash
export OKX_API_KEY=...
export OKX_API_SECRET=...
export OKX_PASSPHRASE=...

TS=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)          # ISO-8601 UTC, ms
SIG=$(printf '%s' "${TS}GET/api/v5/account/balance" | openssl dgst -sha256 -hmac "$OKX_API_SECRET" | awk '{print $2}' | xxd -r -p | base64)
curl -s -H "OK-ACCESS-KEY: $OKX_API_KEY" -H "OK-ACCESS-TIMESTAMP: $TS" \
  -H "OK-ACCESS-PASSPHRASE: $OKX_PASSPHRASE" -H "OK-ACCESS-SIGN: $SIG" \
  "https://www.okx.com/api/v5/account/balance"
```

A response containing balances (`"balances":[…]`, `"details":[…]`, `"coin":[…]`,
or `"data.balances":[…]`) → the credentials work; debug the addon side (mapping,
account, permissions) instead.

### Common errors

| Symptom                                                                          | Cause / fix                                                                                                                           |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Binance `HTTP 401/403 code=-1022 msg=Signature for this request is not valid`    | Wrong secret key, or local clock off by more than `recvWindow` (5 s). Sync the system clock and re-check the secret.                  |
| Binance `code=-1021 msg=Timestamp for this request is outside of the recvWindow` | System clock skew > 5 s vs. Binance. Enable NTP/time sync.                                                                            |
| Binance `code=-2015 msg=Invalid API-key, IP, or permissions for action`          | Key lacks **Enable Reading**, the calling IP is not in the key's restriction list, or key/secret pair does not match.                 |
| OKX `50103 Request header OK-ACCESS-KEY can not be empty` / `50102` / `50110`    | Missing/wrong key; `50102` = clock skew > 30 s (sync time); `50110` = calling IP not in the key's whitelist.                          |
| Bybit `retCode 10006 Too many visits!`                                           | Rate limited — wait and retry.                                                                                                        |
| Bybit `retCode 10001 sign error` / `10004`                                       | Wrong secret, clock skew beyond `recvWindow` (5 s), or key/secret mismatch.                                                           |
| Pionex `INVALID_SIGNATURE` / `INVALID_TIMESTAMP`                                 | Wrong secret, or clock skew > 20 s vs. Pionex (no `recvWindow` — the window is fixed).                                                |
| `<Exchange> API key is missing — save it on this page first.`                    | Save credentials in the **API credentials** card for the active exchange tab.                                                         |
| `<Exchange> API passphrase is missing — save it on this page first.`             | OKX only — save the passphrase along with key and secret.                                                                             |
| `No <Exchange> account mapped yet`                                               | Map or create an account in the **Account** card.                                                                                     |
| Update button disabled                                                           | The hint under it lists exactly which prerequisite(s) are missing for the active exchange.                                            |
| Broker rejects the request before it leaves                                      | Only `api.binance.com`, `www.okx.com`, `api.bybit.com`, `api.pionex.com` are allowlisted in `manifest.json` → `network.allowedHosts`. |
| `snapshots.save` fails                                                           | The mapped account must use holdings tracking mode — the **Create** button configures this correctly.                                 |
| Holdings show no price                                                           | Quote refresh is best-effort; check the warnings in the result panel, or trigger a market sync from Wealthfolio itself.               |

### Unit tests

`npx pnpm test` covers: HMAC-SHA256 against RFC 4231 test vectors (hex and
base64), per-exchange request signing and error shaping (Binance, OKX, Bybit,
Pionex fixtures), Pionex spot-grid bot merging (pagination + per-page
signatures + page cap), balance filtering, exact decimal-string addition, the
balance → snapshot mapping (stablecoins → cash, Binance `LD*` receipts →
underlying, `LDO` kept, `instrumentType: 'CRYPTO'`), `runUpdate` orchestration
against a mocked `HostAPI`, per-exchange config persistence with legacy
migration, and the page's disabled-until-configured behavior.

Set `LIVE_VERIFY=1` to additionally run `src/test/live-verify.test.ts`, which
calls the real exchange APIs with credentials from `.env` (never runs in CI —
skipped otherwise).

## Known limitations

- **Binance** has no official API for listing trading bots (grid/DCA), so bot
  funds are not synced — only spot balances.
- **Bybit**'s grid API (`POST /v5/grid/query-grid-detail`) fetches a single bot
  by its known `grid_id`; there is no list endpoint, so bots cannot be
  discovered and their funds are not synced.
- **OKX** spot-grid funds need no extra API call — they are reported inside the
  standard trading balance response (strategy equity in `frozenBal`); positions
  held outside the spot balance endpoint (e.g. contract/futures grids) are not
  synced.
- **OKX** fixed-term Simple Earn (定期) positions are not synced — only
  flexible savings are. The old `finance/fixed-loan/*` endpoints went offline
  on 2025-03-03, and the relaunched `finance/simple-earn-fixed/*` endpoints are
  not yet published in OKX's public API docs.
- **Pionex** syncs running **spot-grid** bots only; other bot types are out of
  scope.
- **Pionex Earn** (savings) products are excluded by the balance endpoint and
  are not synced — only spot balances plus running spot-grid bots.
- Pionex bot holdings are added as `locked` amounts with `free: "0"` (OKX bot
  funds already arrive inside the trading rows' `frozenBal`); the snapshot's
  mapping sums duplicate assets, but per-bot detail (which bot holds what) is
  not preserved.

## Security

- API keys (and the OKX passphrase) live only in the OS keyring via the addon
  `secrets` API.
- Secrets are used solely as HMAC signing keys — they never appear in URLs,
  headers, logs, or error messages.
- Network egress is brokered by Wealthfolio and restricted to the four hosts in
  `network.allowedHosts`.
- Grant keys **read-only** permission; this addon cannot trade or withdraw.

## License

MIT
