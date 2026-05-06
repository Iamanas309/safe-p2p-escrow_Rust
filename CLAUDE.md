# SafeP2P — Solana Anchor Port

## Project Context
This is a Solana Anchor port of a Solidity P2P escrow contract for 
USDT ↔ PKR trades in Pakistan. The original Solidity contract is in 
`reference/` — read it whenever logic clarification is needed. Full 
specification is in `reference/DOCUMENTATION.md`.

## Critical Rules
- Read reference/DOCUMENTATION.md before changing any business logic
- Build once after writing all changes — do NOT build after every small 
  edit (token waste)
- If a build fails twice, stop and explain — don't spiral on fixes
- Explain changes in plain English — the user does not know Rust
- Never modify the reference/ folder
- Never add buyer/seller fee logic that isn't in the original Solidity

## Architecture
- programs/safe_p2p_escrow/src/lib.rs — entry point
- programs/safe_p2p_escrow/src/state.rs — TradeAccount, DisputeAccount, EscrowState
- programs/safe_p2p_escrow/src/instructions/ — one file per function
- programs/safe_p2p_escrow/src/constants.rs — fees, seeds, limits
- programs/safe_p2p_escrow/src/error.rs — custom errors
- Each trade has a PDA vault holding USDT (seeded with VAULT_SEED + trade_id)

## Key Logic Points
- Seller pays 0.5% fee on createTrade
- Buyer pays 0.5% fee on joinTrade  
- confirmPayment is seller-only — releases trade.amount to buyer
- cancelTrade: OPEN trades = full refund to seller; ACTIVE trades after 
  30 min = seller gets amount + seller_fee, buyer's fee stays in contract
- raiseDispute: BUYER ONLY (not seller)
- Disputes need 2/3 arbitrator majority OR 24-hour timeout
- Admin deadlock resolution only after 2 days
- 3 fixed arbitrator slots, 50 USDT stake each

## Token Discipline
- The user has Claude Pro — usage matters
- Prefer Sonnet model unless user requests Opus
- Don't re-read files unnecessarily — remember within session
- Batch file edits before building

## Hackathon Context
- Colosseum Frontier Hackathon, Pakistan track
- Deadline: ~7 days from now (as of 2026-05-03)
- Priority: working demo > test coverage

## Frontend — app/ (Next.js 16, Tailwind, @solana/web3.js, wallet-adapter)

### Design system
- Terminal aesthetic: black (#000) background, green (#00cc33) text, Courier New mono
- All pages use `className="terminal-page fixed inset-0 z-50"` to bypass AppLayout header/footer
- Shared CSS in `app/src/app/globals.css`: `.terminal-page`, `.terminal-cursor`, `.terminal-menu-btn`
- No @coral-xyz/anchor — raw web3.js with manual instruction encoding (discriminator + LE u64 args)
- USDT_MINT constant in `app/src/lib/constants.ts` — must be updated after devnet deploy/initialize

### Pages status
| Route | File | Status |
|---|---|---|
| `/` | `src/app/page.tsx` → `components/terminal-landing.tsx` | ✅ DONE — animated logo, 6 menu buttons, live slot counter, mobile responsive pixel art |
| `/sell` | `src/app/sell/page.tsx` → `components/sell/create-trade-feature.tsx` | ✅ DONE — form, fee preview, on-chain create_trade, payment method fields (EasyPaisa/JazzCash/etc), saves to Supabase |
| `/buy` | `src/app/buy/page.tsx` → `components/buy/browse-trades-feature.tsx` | ✅ DONE — lists open trades, join_trade, own-trade guard, auto-creates buyer ATA, shows payment method badge per trade |
| `/my-trades` | `src/app/my-trades/page.tsx` → `components/my-trades/my-trades-feature.tsx` | ✅ DONE — lists seller+buyer trades, confirm/cancel/raise-dispute, tx sig Explorer links, clickable trade ID buttons |
| `/trade/[id]` | `src/app/trade/[id]/page.tsx` → `components/trade/trade-detail-feature.tsx` | ✅ DONE — full detail, vault balance, confirm/cancel/dispute/resolve, dispute vote bars, RELEASE FUNDS, payment details panel for buyer, tx Explorer links |
| `/arbitrate` | `src/app/arbitrate/page.tsx` → `components/arbitrate/arbitrate-feature.tsx` | ✅ DONE — arbitrator-only dispute panel, vote BUYER WON / SELLER WON, vote progress bars, tx Explorer links |
| `/become-arbitrator` | `src/app/become-arbitrator/page.tsx` → `components/arbitrator/arbitrator-feature.tsx` | ✅ DONE — 3 slot view, stake/withdraw/leave, earned balance per slot, link to /arbitrate, tx Explorer links |
| `/protocol` | `src/app/protocol/page.tsx` → `components/protocol/protocol-feature.tsx` | ✅ DONE — full protocol docs, fee table, trust model, Solana Explorer link |

### PDA derivation (raw web3.js pattern)
- escrow_state: `["escrow"]`
- trade_account: `["trade", trade_counter_le_8bytes]` — fetch trade_counter from escrow_state at offset 40
- vault: `["vault", trade_counter_le_8bytes]`
- dispute_account: `["dispute", dispute_counter_le_8bytes]`
- arbitrator_vault: `["arb_vault"]`

### Instruction discriminators (from IDL)
- create_trade: `[183, 82, 24, 245, 248, 30, 204, 246]` — args: amount u64 LE, rate u64 LE
- join_trade: `[215, 116, 38, 205, 90, 111, 131, 172]` — args: trade_id u64 LE
- confirm_payment: `[221, 23, 112, 126, 29, 23, 159, 223]` — args: trade_id u64 LE
- cancel_trade: `[124, 66, 91, 59, 175, 107, 208, 120]` — args: trade_id u64 LE
- raise_dispute: `[41, 243, 1, 51, 150, 95, 246, 73]` — args: trade_id u64 LE
- vote_on_dispute: `[7, 213, 96, 171, 252, 59, 55, 23]` — args: dispute_id u64 LE, vote_for_buyer bool
- stake_to_become_arbitrator: `[134, 217, 193, 186, 254, 144, 116, 236]` — no args
- withdraw_arbitrator_earnings: `[237, 232, 253, 224, 99, 213, 37, 2]` — no args

### EscrowState layout (for reading trade_counter)
Offset 0–7: discriminator | 8–39: admin pubkey | 40–47: trade_counter u64 LE | 48–55: dispute_counter u64 LE

### Devnet deployment status (confirmed 2026-05-05)
- Program deployed: `CtKjEzbZLj2FUWz1Rt15q4A5EW38NPCpoTXX9bcXUjgt`
- EscrowState PDA: `2f7C9YfAJpi4aK1C84LJRsadMaMFwogueaSMuxZNuKXi` — INITIALIZED ✓
- Admin keypair: `8k31uKgoxe8Kg1dgeXLevAaj1X7ck6Y26rbXosiXBGGE` (= ~/.config/solana/id.json on devnet machine)
- USDT mint (confirmed from arb vault): `2YytyJvKbp9SCpn4wiSUgKTguhiKWqdErUWmLqTZ68us` (6 decimals)
- ArbVault PDA: `cbqScWsaS2A4sYeH6Ksv71iurV3SHt7ppVnmxaS1ZnU`
- Seller test wallet: `8RRkHntHMDhsM7RyBTQdoEvCDtsE5V9wsBXTw22FLg4U`
- Seller USDT ATA: `GCkHNfUw2Ked9yd9rHoQ6UNaR25KhHsf6QTqEorKPXEx` — balance: 10,000 USDT ✓
- Trade counter: 0 (no trades created yet)
- USDT_MINT in constants.ts: UPDATED ✓ — no longer a placeholder
- To mint more test USDT: `spl-token mint 2YytyJvKbp9SCpn4wiSUgKTguhiKWqdErUWmLqTZ68us <AMOUNT> GCkHNfUw2Ked9yd9rHoQ6UNaR25KhHsf6QTqEorKPXEx --mint-authority ~/.config/solana/id.json --url devnet`

### Payment info off-chain storage (added 2026-05-06)
- Supabase project: `crupjobijozkwteuvbic` (free tier, hosted Postgres)
- Table: `trade_info` — columns: `pda TEXT PK, method TEXT, account TEXT, name TEXT, created_at TIMESTAMPTZ`
- API route: `app/src/app/api/trade-info/route.ts` — GET (fetch by pda) + POST (upsert)
- Env: `app/.env.local` — `SUPABASE_URL` + `SUPABASE_ANON_KEY` (JWT anon key, NOT publishable key)
- Flow: seller fills payment method on /sell → saved after on-chain tx confirms → badge shown on /buy → full details shown to buyer on /trade/[id] when status=Active

### What's remaining before submission
- [ ] Restart dev server after key change (env var update requires restart)
- [ ] Test full flow: create trade with payment info → browse → join → verify payment details visible
- [ ] Record 2–3 min demo video (required for Colosseum + Superteam Earn)
- [ ] Write project deck (problem, solution, roadmap — required for Superteam Earn)
- [ ] Submit on Colosseum platform (mark region as Pakistan)
- [ ] Submit on Superteam Earn with deck + video
- [ ] Sign up for KAST wallet (submission requirement)

### Known bugs fixed
- /sell input lost focus on every keystroke — Shell component was defined inside CreateTradeFeature (React remount bug). Fixed: moved Shell to module level.
- /sell threw `writeBigUInt64LE is not a function` in browser — Next.js Buffer polyfill lacks BigInt methods. Fixed: replaced with pure-JS u64LE() / readU64LE() bit-shift helpers.
- Landing page PROTOCOL button overlapped status bar on small screens — fixed by adding overflow-y-auto + py-4 to centered content div.