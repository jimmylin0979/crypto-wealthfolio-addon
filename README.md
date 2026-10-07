# Crypto-wealthfolio-addon

Fetch your current **Binance, OKX, Bybit, or Pionex** balances into
[Wealthfolio](https://wealthfolio.app) as a portfolio snapshot — pick the
exchange, press **Update**, done. Runs entirely inside Wealthfolio as an addon;
no separate service to deploy.

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
  Update reads `GET /api/v1/bot/orders?buOrderTypes=spot_grid&status=running`
  and merges `buOrderData.baseAmount` + `buOrderData.quoteAmount` into the same
  snapshot (additive — no double-counting). **OKX** needs no extra request: the
  trading balance endpoint already reports bot funds as strategy equity (the
  row's `stgyEq` field, which sits inside `frozenBal` — verified live), so they
  arrive with the normal rows — merging `tradingBot` details on top would
  double-count them. **Binance and Bybit
  expose no official API to list individual bots**, so bot-held funds are not
  synced on either exchange — both hold bot funds only as a lump sum in wider
  aggregate wallet endpoints the addon does not call (see
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

Per exchange: what is **not** synced, and whether that gap is a **no API** gap
or simply **not implemented** (the API exists — the addon does not call it).
Endpoint names were verified against the official API docs — Binance
(`developers.binance.com`), Bybit (`bybit-exchange.github.io`), OKX
(`okx.com/docs-v5` + the changelog) and Pionex (`pionex.com/docs` + the
official `pionex-official/pionex-open-api` specs) — on 2026-10-06.

### Binance

Syncs **spot only** (`GET /api/v3/account`), with `LD*` receipt tokens remapped
onto their underlying asset.

**Not synced — API exists, not implemented:**

| Balance category | Official endpoint |
| --- | --- |
| Funding (Binance Pay / Card / Gift Card / Stock Token) | `POST /sapi/v1/asset/get-funding-asset` — a **POST**, not GET |
| Every wallet in one call (Spot, Funding, Cross/Isolated Margin, USDⓈ-M, COIN-M, Earn, Options, **Trading Bots**, Copy Trading) | `GET /sapi/v1/asset/wallet/balance?needBalanceDetail=true` |
| Simple Earn aggregate / flexible / locked | `GET /sapi/v1/simple-earn/account`, `…/simple-earn/flexible/position`, `…/simple-earn/locked/position` |
| ETH / SOL / on-chain staking | `GET /sapi/v2/eth-staking/account`, `GET /sapi/v1/sol-staking/account`, `GET /sapi/v1/onchain-yields/account` |
| Dual Investment | `GET /sapi/v1/dci/product/positions`, `GET /sapi/v1/dci/product/accounts` |
| USDⓈ-M futures | `GET /fapi/v2/balance`, `GET /fapi/v3/balance` |
| COIN-M futures | `GET /dapi/v1/balance` |
| Options | `GET /eapi/v1/marginAccount` |
| Margin (cross / isolated) | `GET /sapi/v1/margin/account`, `GET /sapi/v1/margin/isolated/account` |
| Portfolio Margin / PM Pro | `GET /papi/v1/balance`, `GET /sapi/v1/portfolio/balance` |
| Auto Invest plans / holdings | `GET /sapi/v1/lending/auto-invest/plan/list`, `…/plan/id` |

**Not synced — no API exists:**

- **Individual trading bots** (grid/DCA name, parameters, PnL, status): none of
  the 27 official Postman collections contains a `grid` or `bot` endpoint, the
  official API product index has no Trading Bots section, and spot's
  `strategyType` is only a caller-supplied order label (≥ 1000000). Binance's
  futures `GRID_UPDATE` user-stream event is marked **Deprecated**.
- **Mining balance** — earnings only (`GET /sapi/v1/mining/payment/list`,
  `…/payment/uid`, `…/statistics/user/list`); there is no balance endpoint, and
  the string `aux/endCode` does not exist anywhere in the official API.
- **Binance Pay balance** — no dedicated balance endpoint; only trade history
  (`GET /sapi/v1/pay/transactions`). Pay balances surface through the funding /
  wallet endpoints above.
- **OTC / block-trade balance** — no public endpoint (only W3W Prediction OTC
  paths). Convert offers history only (`GET /sapi/v1/convert/tradeFlow`).

**Correction to the older wording:** bot-held funds are *not* undiscoverable —
the lump sum shows up as walletName `"Trading Bots"` in
`GET /sapi/v1/asset/wallet/balance` (per-asset with `needBalanceDetail=true`).
The addon simply does not call that endpoint. What truly has no API is the
**per-bot** list.

**`LDUSDT` caveat:** swapping USDT Simple Earn flexible assets yields `LDUSDT`,
which sits in the **USDⓈ-M futures** wallet while the **Earn** wallet shrinks —
it never appears in spot balances, so this addon's spot-only sync neither sees
it nor double-counts it. It becomes a double-count risk only if futures and
Earn are ever synced together. `LDUSDT` is the only `LD*` token documented in
official Binance sources.

### Bybit

Syncs **UNIFIED + FUND**
(`GET /v5/account/wallet-balance?accountType=UNIFIED` and
`GET /v5/asset/transfer/query-account-coins-balance?accountType=FUND`).

**Not synced — API exists, not implemented:**

| Balance category | Official endpoint |
| --- | --- |
| Earn positions (flexible / on-chain / fixed-term / token / RWA / liquidity-mining) | `GET /v5/earn/position`, `…/earn/fixed-term/position`, `…/earn/token/position`, `…/earn/rwa/position`, `…/earn/liquidity-mining/position` |
| Everything else in one call: `FundingAccount`, `UnifiedTradingAccount`, **`Earn`**, **`TradingBot`** (Futures Grid / Combo / Martingale), `CopyTrading`, `CryptoLoans`, `BybitPayLater`, **`Launchpool`**, `TradFi`, `MarginStakedSOL`, `Alpha` | `GET /v5/asset/asset-overview` — per-coin equity; optional `accountType` filter; **not supported on Bybit KZ/GE/EU accounts** |
| Earn withdrawable balance | `GET /v5/asset/withdraw/withdrawable-amount` → `EARN` object |
| Fiat balance | `GET /v5/fiat/balance-query` |
| Master + sub-account totals | `GET /v5/asset/total-members-assets` |

**Not synced — no API exists:**

- **Per-bot listing** for spot grid, futures grid, DCA, combo, and martingale
  bots: each family exposes only create / close / detail-by-id
  (`POST /v5/grid/query-grid-detail`, `POST /v5/fgridbot/detail`, etc.), so a
  bot can be fetched only when its id is already known. The docs' own wording
  ("grid list queries", "bot listing endpoints") refers to app-side queries
  that are not publicly documented.

**`wallet-balance` note:** the shared `accountType` enum is **`UNIFIED` /
`FUND` only**. `CONTRACT` was removed under UTA 2.0 ("inverse derivatives
account does not exist anymore"), the legacy Spot wallet is gone (`free` is
deprecated), and the `wallet-balance` docs now redirect Funding queries to
`query-account-coins-balance` — which is exactly what the addon calls.

**Uncertain:** the `assetCategory` enum has no Spot Grid Bot entry; where
spot-grid funds sit inside Bybit's wallet model is undocumented. `asset-overview`
only shows Futures Grid/Combo/Martingale under `TradingBot`.

### OKX

Syncs **trading + funding + flexible savings** (the three endpoints above).

**Not synced — API exists, not implemented:**

| Balance category | Official endpoint |
| --- | --- |
| On-chain DeFi staking (incl. ETH / SOL staking balances) | `GET /api/v5/finance/staking-defi/eth/balance`, `…/sol/balance`, `…/orders-active` |
| Stable Rewards | `GET /api/v5/finance/stable-rewards/balance` |
| OKUSD | `GET /api/v5/finance/okusd/account` |
| Flexible loan liabilities | `GET /api/v5/finance/flexible-loan/loan-info` |
| Cross-account valuation (`classic` / `earn` / `funding` / `trading` buckets) | `GET /api/v5/asset/asset-valuation` |
| Sub-account balances | `GET /api/v5/account/subaccount/balances`, `GET /api/v5/asset/subaccount/balances` |

**Not synced — no public API:**

- **Fixed-term Simple Earn (定期).** The old `finance/fixed-loan/*` endpoints
  went offline on 2025-03-03 (OKX changelog). Replacement
  `finance/simple-earn-fixed/*` endpoints exist and work — OKX's own
  `okx/agent-trade-kit` calls `/offers`, `/order-list`, `/purchase`,
  `/redeem` — but they are still **unpublished in the public docs** (0 hits in
  docs-v5 as of 2026-10-06), so the addon treats them as an unsupported
  contract. Only flexible savings are synced. (The legacy
  `GET /api/v5/asset/staking-balance` is likewise gone from the docs —
  staking moved to `finance/staking-defi/*`.)
- **Dual Investment (DCD) aggregate balance** — per-order endpoints only
  (`GET /api/v5/finance/sfp/dcd/order-status`, `…/order-history`), no balance
  endpoint.

**Bot funds need no extra API call:** OKX reports bot equity in the standard
trading balance response as `stgyEq` ("Total equity allocated to trading bots"
— covers Spot Grid, Futures Grid, Signal Bot, Spot/Futures Martingale,
Infinite Grid and Recurring Buy); live testing shows `stgyEq` sits within
`frozenBal`, and the addon sums `availBal + frozenBal` per row, so bot funds
arrive with the normal rows — merging `tradingBot` rows on top would
double-count them. Per-bot detail (e.g. `GET /api/v5/tradingBot/grid/positions`)
is not fetched.

### Pionex

Syncs **spot balances + running spot-grid bots** only
(`GET /api/v1/account/balances` + `GET /api/v1/bot/orders?buOrderTypes=spot_grid&status=running`,
bot pages capped at 20).

**Not synced — no API exists:**

- **Flexible Earn (活期賺幣).** None of the 13 official spec files
  (`pionex-official/pionex-open-api`) exposes a savings/flexible-earn endpoint;
  `GET /api/v1/account/balances` is documented as *"excludes bot and earn
  accounts"*, and even the aggregate `GET /api/v1/wallet/balancesFull` covers
  only Spot (Bot Account) + Futures (Trader Account). Term-Arbitrage and Dual
  Investment earn have *Beta* balance endpoints
  (`GET /api/v1/earn/arbitrage/fetchUserBalances`,
  `GET /api/v1/earn/dual/balances`) that require Beta access by email
  application — not implemented.
- **Mining pool and staking balances** — no endpoints in any official spec.
- **DCA bots** — the official bot API has no DCA endpoints at all.

**Not synced — API exists, not implemented:**

| Balance category | Official endpoint |
| --- | --- |
| Futures / contract wallet | `GET /uapi/v1/account/balances`, `GET /uapi/v1/account/detail`, `GET /uapi/v1/account/positions` |
| Aggregate spot-bot + futures overview (still no Earn) | `GET /api/v1/wallet/balancesFull` |
| Non-spot-grid bots — `GET /api/v1/bot/orders` accepts `buOrderTypes` = `spot_grid`, `futures_grid`, `future_hedge_grid`, `smart_copy`; the addon requests `spot_grid` only (futures-bot funds also sit in the `uapi` wallet above) | `GET /api/v1/bot/orders?buOrderTypes=…`, `GET /api/v1/bot/orders/{spotGrid,futuresGrid,smartCopy}/order` |

Pionex bot holdings are added as `locked` amounts with `free: "0"` (OKX bot
funds already arrive inside the trading rows via `stgyEq` within `frozenBal`);
the snapshot's mapping sums duplicate assets, but per-bot detail (which bot
holds what) is not preserved.

### Cross-cutting notes

- **Unsynced categories are silent.** Balance categories the addon never
  requests produce no runtime warning — the gap is documented only in this
  section. Warnings shown during Update cover post-snapshot steps only
  (recalculation, price refresh, valuation).
- **Per-exchange fetches are all-or-nothing.** OKX (3 endpoints), Bybit (2)
  and Pionex (2+) fetch in parallel with `Promise.all`; if any single endpoint
  fails, the whole Update for that exchange fails and **no snapshot is
  written**. Partial success exists only across exchanges (Sync All records a
  failure and continues with the rest).
- **No per-category toggles** — configuration is per exchange (credentials +
  mapped account) only; you cannot enable/disable individual balance
  categories.
- Balance endpoints report **amounts only**, never cost basis, so every CRYPTO
  holding is imported without cost basis (stablecoins excepted — they map to
  USD cash at the 1:1 peg).
- OKX's three row sets and Bybit's UNIFIED + FUND pair are disjoint; the
  mapping sums duplicate assets defensively. If Binance wallet-level endpoints
  or Bybit `asset-overview` were adopted later, the same treatment applies to
  `Earn` vs futures (`LDUSDT`) and to `Earn` vs `TradingBot` rows.

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
