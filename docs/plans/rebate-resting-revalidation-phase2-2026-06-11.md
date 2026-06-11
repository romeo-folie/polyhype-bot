# Rebate farmer Phase-2: revalidate resting orders on de-selected markets (free stranded bids)

**Status:** SPEC — not started. Handoff doc.
**Author context:** written 2026-06-11, after the hold-resting change (PR #475/#476) shipped. This is the "Phase 2 (optional, defer)" item from `docs/plans/rebate-hold-resting-queue-priority-2026-06-11.md` §7.5, now promoted with real evidence.
**Owner decision captured:** user asked to spec it after we proved the no-fill cause is NOT thin books.

---

## 1. One-paragraph problem

The hold-resting change (PR #475) correctly stopped the 300s cancel-repost churn — resting orders now keep CLOB queue priority and are cancelled only at resolution / a 24h backstop / on price drift. But the price-drift cancel (the reprice pass, `rebateFarmer.ts`) **only runs for markets re-selected into the top-N this cycle**. A resting order on a market that drops out of the selection set is never re-priced — it just sits at its original placement price until resolution. On a **trending** market that price is quickly left far behind, so the bid is **stranded below the market, never fills, and ties up budget for hours**. We need a pass that re-validates *every* resting order's price against the current book (not just selected ones) and **cancels genuinely-stranded bids to free budget** — mirroring weather's per-maker FV-rule.

## 2. Evidence (today, 2026-06-11 — the markets that motivated this)

These are NOT thin books — they are among the most liquid on the platform, and we still didn't fill:

| Market | Liquidity | Volume | Spread | Our bid @ placement | Mid @ placement | Price @ resolution | Stranded by |
|---|---|---|---|---|---|---|---|
| "Will Mexico win on 2026-06-11?" (1897034) | $190k | **$7.23M** | 1¢ | YES @ **0.67** | 0.685 | **0.87** | **+18.5¢** |
| "Spread: Mexico (-1.5)" (2326841) | $395k | **$1.9M** | 1¢ | YES @ **0.39** | 0.405 | **0.55** | **+14.5¢** |

Mexico-win was first quoted at 06:15 (yesMid 0.685, we bid 0.67 — a correct 1.5¢-under-mid maker price), churned/re-posted ~6× under the *old* code until 08:55, then the hold code held that 0.67 bid **steadily for ~10 hours** while the market ran to 0.87. It never filled (no one sells YES @ 0.67 when it's worth 0.87) and was cancelled at resolution. Same shape on the spread (0.405→0.55 over 3h). **Capital sat dead on a stale price the whole time** — the reprice pass never touched it because Mexico fell out of the top-N selection after 08:55.

## 3. Root cause (precise — grep the anchors, line numbers may drift)

- The reprice pass (`src/cron/rebateFarmer.ts`, the `Step A` loop inside the `for (const candidate of candidates)` block, ~118–147) compares each resting order's price to a **freshly-selected candidate's** quote and cancels+reposts when drift > `REBATE_REPRICE_THRESHOLD`. **It is inside the `candidates` loop**, so it only ever sees markets returned by `selectRebateMarkets` this cycle (top-N by recent fee-equivalent flow, `REBATE_MAX_MARKETS`).
- `reconcileOrders` (`src/rebate/orderManager.ts`) iterates *all* resting orders but only checks fill / external-cancel / resolution / lifetime-backstop / assume-gone — **never price**.
- Net: a resting order on a de-selected market has **no code path that looks at its price** until resolution. It is held at its placement price indefinitely.

## 4. Design

### 4.1 What it does
A new **price-revalidation pass** over every tracked resting order whose market is **NOT in the current selection set** (selected ones are already handled by the reprice pass — don't double-process). For each such order: fetch the current book, recompute the maker target the selector *would* quote now, and **cancel the order if it is stranded** — i.e. the fresh target has risen well above our resting bid. Within-threshold orders are **left resting** (queue priority preserved — consistent with PR #475).

### 4.2 Directional cancel rule (IMPORTANT — not symmetric abs)
A resting order is a **BUY bid**. It fills only when a seller comes *down* to it. So only cancel when the market has moved *up and away*:

```
stranded  ⇔  freshTarget − order.price  >  REBATE_STALE_DRIFT_THRESHOLD
```

- `freshTarget` = the price `buildQuote` would produce now for this order's direction (see 4.4).
- If `freshTarget − price > threshold` (target rose; our bid left far below market) → **stranded, won't fill → CANCEL**.
- If `freshTarget ≈ price` (within threshold) → **HOLD** (still well-placed; keep queue priority).
- If `freshTarget < price` (market came *down* to/under our bid) → **HOLD** — we're at/above the maker target and about to fill; cancelling here would throw away a near-fill.

**Do NOT use `Math.abs(...)`** like the reprice pass does — symmetric drift would wrongly cancel about-to-fill orders. The reprice pass can be symmetric because it *re-posts*; this pass *cancels*, so it must be one-directional.

### 4.3 Cancel, don't reprice (for de-selected markets)
The de-selected market is, by definition, **not a top-N priority** this cycle. Re-posting there keeps capital on a low-flow market; **cancelling frees the budget** for the scanner to redeploy onto a currently-selected (livelier) market next cycle. So Phase-2 is **cancel-only**. (Re-pricing de-selected markets is a deliberately-rejected alternative — see §10.) The existing reprice pass continues to handle drift on *selected* markets by cancel+repost.

### 4.4 Computing `freshTarget` (reuse existing pieces — minimal new code)
Replicate the selector's per-market quoting (marketSelector.ts ~281–365) for ONE market:
1. `yesBook = await getClobOrderBook(order.clobTokenIds[0])`  (YES token)
2. `{ bestBid: yesBid, bestAsk: yesAsk } = getBookTouch(yesBook)` (handles CLOB REST best-at-END — see `project_clob_rest_book_best_at_end`)
3. `if (yesBid<=0 || yesAsk<=0 || yesAsk<=yesBid) → SKIP` (no usable book this cycle; conservative — never cancel on missing/degenerate data, like reconcile's transient handling)
4. `yesMid = (yesBid + yesAsk) / 2`
5. For the order's own token, fetch its book touch for clamping inputs (`bestBid/bestAsk` of `order.tokenId`); for the YES leg these are yesBid/yesAsk, for the NO leg fetch the NO book.
6. `fresh = buildQuote(order.direction, order.tokenId, order.direction==='YES' ? yesMid : 1 - yesMid, cfg.REBATE_QUOTE_EDGE, tick, tokBid, tokAsk)`
7. `freshTarget = fresh?.price` — if `null` (degenerate/crossing) → SKIP.

**Refactor:** `buildQuote` is currently a private fn in `marketSelector.ts`. Either (a) export it, or (b) add an exported `computeRestingTarget(order): Promise<number | null>` in `marketSelector.ts` that does steps 1–7 internally (preferred — keeps quoting logic co-located, exports a single purpose-built fn). `getClobOrderBook` + `getBookTouch` are already importable.

### 4.5 Where it runs
In `src/cron/rebateFarmer.ts` `main()`, **after `selectRebateMarkets` returns** (so we know the selected set) but as its own pass over `loadRestingOrders` — NOT inside the `candidates` loop. Build `const selectedIds = new Set(candidates.map(c => c.marketId))`; revalidate only orders whose `marketId ∉ selectedIds`. Reuse the existing `cancelForReprice(redis, order)` helper to do the cancel (it already does the cancel + always-recheck + fill-during-cancel accounting + `removeRestingOrder`); on success, `orders.delete(id)` and `remaining += order.sizeUsd` so freed budget is reusable this cycle.
- **Disabled-mode / no-candidates:** when farming is disabled or `candidates` is empty, `selectedIds` is empty → *all* resting orders are revalidated (pure cleanup of stranded budget). Acceptable and desirable. Gate the whole pass behind `REBATE_REVALIDATE_RESTING_ENABLED` so it can ship dark.
- **Shadow:** honor `REBATE_SHADOW_MODE` (and/or a dedicated shadow flag) — log `[rebate-shadow] would revalidate-cancel` with `{order.price, freshTarget, drift}` and place/cancel nothing. **Ship in shadow first** (this pass forfeits queue priority when it fires — we must confirm it only cuts genuinely-stranded orders, not good ones).

### 4.6 Threshold — wider than the reprice threshold, on purpose
New knob `REBATE_STALE_DRIFT_THRESHOLD` (default **0.05**). Cancelling forfeits queue priority, so only cut clearly-dead bids — a wider band than `REBATE_REPRICE_THRESHOLD=0.02` (which merely re-posts). The Mexico cases (18.5¢ / 14.5¢) are far past 0.05 → caught; routine 1–3¢ noise → held. Tunable in `.env`.

### 4.7 Pair / completion-leg coherence
- **Two-sided resting pair, one leg strands:** on a trending market both legs usually strand the same way (YES target rises → YES bid stranded below; the NO target falls so the NO bid is *above* market → §4.2 leaves NO alone here). Cancelling the YES leg leaves NO as a naked resting leg; the existing **orphan sweep** (runs at the end of `reconcileOrders`) cancels a naked fresh leg with no held/resting opposite next cycle. So per-order cancel is coherent — no special pair logic needed, but call this out and test it.
- **Completion leg (held opposite exists):** revalidate it too, but the held inventory just continues to hold to resolution if we cancel the resting completion leg. Do **not** reprice a completion leg here (cancel-only); a future cycle re-quotes a completion leg under the pair-cost ceiling if the market is re-selected. (The pair-cost ceiling lives in `placeRestingOrder`, not here — we only cancel.)

### 4.8 Cost / rate
One YES-book fetch per de-selected **market** per cycle (+ a NO-book fetch only for NO-leg orders). **Dedup by market** — multiple orders on the same market share the YES book; fetch once, cache within the pass. Order count is bounded (`REBATE_MAX_TOTAL_USD` / order size ⇒ at most a few dozen). The selector already does the same fetches for selected markets, so this is comparable load. No governor slot is consumed by a cancel.

## 5. New config knobs (`src/shared/config.ts` + `.env.example`, update both together)
- `REBATE_REVALIDATE_RESTING_ENABLED` — `boolFromEnv.default(false)`. Master flag; ship dark.
- `REBATE_STALE_DRIFT_THRESHOLD` — `z.coerce.number().min(0).max(1).default(0.05)`. Stranded-below cancel band.
- (optional) `REBATE_REVALIDATE_SHADOW` — `boolFromEnv.default(false)` if you want a shadow independent of `REBATE_SHADOW_MODE`. Otherwise reuse `REBATE_SHADOW_MODE`.

## 6. Stat counter
New terminal reason `stale_drift_cancels` (plain `bumpStat` Redis hincrby — NOT a db-writer enum, no rebuild). Add to the daily summary ops line next to `held-cancelled` / `repriced`. Reuse `cancelForReprice` for the cancel but bump `stale_drift_cancels` (not `reprice_cancels`) so the two are distinguishable — i.e. don't call `cancelForReprice` blindly (it bumps `reprice_cancels`); either parameterize its stat field or add a sibling `cancelStaleResting(redis, order)` that shares the recheck discipline but bumps the new counter. Prefer parameterizing.

## 7. Implementation checklist (files)
1. `src/rebate/marketSelector.ts` — export `computeRestingTarget(order: RestingOrder): Promise<number | null>` (or export `buildQuote`). Reuses `getClobOrderBook` + `getBookTouch` + `buildQuote`.
2. `src/rebate/orderManager.ts` — add `revalidateRestingPrices(redis, selectedIds, {shadow}): Promise<{ cancelled: RestingOrder[]; freedUsd: number }>` OR keep the loop in `rebateFarmer.ts` and add a `cancelStaleResting` helper. Parameterize the cancel stat field so `stale_drift_cancels` is bumped.
3. `src/cron/rebateFarmer.ts` — after `selectRebateMarkets`, build `selectedIds`, run the revalidation pass over de-selected resting orders, fold freed budget back into `remaining`, add counts to the cycle-complete log + daily summary.
4. `src/shared/config.ts` + `.env.example` — the knobs in §5.
5. `src/rebate/rebateChecker.ts` — surface `stale_drift_cancels` in the daily summary.

## 8. Tests required (Vitest — assert behavior, per CLAUDE.md)
1. **Stranded order IS cancelled:** resting BUY YES @ 0.67, current book yields freshTarget ~0.845 (mid 0.86) → `freshTarget − price = 0.175 > 0.05` → cancelled, budget freed, `stale_drift_cancels` bumped.
2. **In-line order is HELD:** resting @ 0.66, freshTarget 0.67 (drift 0.01) → not cancelled, no stat bump, stays tracked (queue priority).
3. **About-to-fill order is HELD (directional guard):** resting BUY @ 0.67, freshTarget 0.50 (market fell *below* our bid) → `freshTarget − price < 0` → NOT cancelled. (This is the test that proves we didn't use symmetric abs.)
4. **Selected markets are skipped:** an order whose market IS in `selectedIds` is not touched by this pass (the reprice pass owns it) — no double-cancel.
5. **Missing/degenerate book → SKIP:** `getBookTouch` returns `bestBid<=0`/crossed → order left tracked, not cancelled.
6. **Shadow logs, cancels nothing:** with shadow on, a stranded order is logged as `would revalidate-cancel` and remains tracked.
7. **Orphan partner cleanup:** cancelling one stranded leg of a two-sided pair leaves the other naked → orphan sweep cancels it (integration via `reconcileOrders`).
8. **Knob defaults present** via `schemaDefaults(envSchema)`.

## 9. Deploy & verification
- Host-cron `tsx`, no container rebuild — next `*/5` picks up the code + `.env`. Stat is a plain Redis field → no db-writer rebuild.
- Ship with `REBATE_REVALIDATE_RESTING_ENABLED=true` + **shadow on** first. Review `[rebate-shadow] would revalidate-cancel` lines for a day: confirm it flags only genuinely-stranded orders (large positive drift) and never the about-to-fill ones. Then flip shadow off.
- Live verification: `stale_drift_cancels` rises on trending/de-selected markets; **average resting lifetime stays high for in-range orders but stranded ones get freed within a cycle or two of drifting** (not held to resolution); budget churns toward currently-selected markets; no increase in adverse fills.

## 10. Alternatives considered / rejected
- **Reprice (chase) de-selected orders instead of cancel:** rejected — chasing a trending market pays worse and may still strand; and the market is de-selected (low flow) so it's not worth keeping capital there. Cancel + redeploy to a selected market is better capital allocation. (Selected markets still get reprice via the existing pass.)
- **Symmetric `abs` drift (like the reprice pass):** rejected — would cancel about-to-fill orders (market came down to our bid). Must be directional (§4.2).
- **Also cancel *above-market* bids (adverse-fill risk):** out of scope for Phase-2. A resting bid that the market rose *through* could take an adverse fill, but pairs are combined-cost<1 at placement and post-resolution cancel bounds the window. Track separately if adverse fills show up in the data.
- **Put the price check inside `reconcileOrders` unconditionally:** rejected for now — reconcile runs even when disabled and shouldn't fetch books for every order every cycle without the feature flag; keeping it a separate gated pass is cleaner. (Could be merged later.)

## 11. Related
`docs/plans/rebate-hold-resting-queue-priority-2026-06-11.md` (Phase-1, §7.5 named this) · memories `project_rebate_hold_resting_plan`, `project_maker_rebate_audit_fixes` (deep-book wall, market selection), `project_clob_rest_book_best_at_end` (getBookTouch), `project_rest_above_cap_pool_expiry_sweep` (weather per-maker FV-rule precedent) · `feedback_tests_required_for_features`, `feedback_test_config_derive_from_schema`.
