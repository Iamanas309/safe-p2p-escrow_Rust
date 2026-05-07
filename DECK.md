# SafeP2P — Hackathon Deck
## KAST x Colosseum Frontier Hackathon 2026 | Pakistan Track

---

## SLIDE 1 — THE PROBLEM

**Headline:** P2P crypto trading in Pakistan is broken by trust.

Pakistan has one of the highest crypto adoption rates in the world by volume — but almost no on-ramp infrastructure. Millions of people trade USDT for PKR through WhatsApp groups, Telegram chats, and local forums. The flow looks like this:

- Stranger posts: "Selling 500 USDT at 278 PKR — send EasyPaisa first"
- You send PKR. They disappear.
- Or: they send USDT first. You disappear.

There is no escrow. No dispute system. No accountability. Every trade is a gamble. Scammers thrive because the infrastructure forces blind trust between strangers.

**The numbers:**
- Pakistan ranked #9 globally for crypto adoption (Chainalysis 2023)
- EasyPaisa and JazzCash process billions of PKR monthly — but zero integration with crypto rails
- No regulated P2P platform exists for USDT↔PKR in Pakistan

---

## SLIDE 2 — THE SOLUTION

**Headline:** SafeP2P — trustless P2P escrow for USDT↔PKR trades on Solana.

SafeP2P replaces blind trust with on-chain guarantees. The seller locks USDT in a smart contract vault before the buyer sends a single rupee. The contract only releases funds when the seller confirms payment received — or when on-chain arbitrators vote on who wins a dispute.

**The guarantee:**
- Seller can't disappear with PKR after taking payment — they never had the PKR, the vault has the USDT
- Buyer can't claim "I didn't receive" if the seller has a payment screenshot — arbitrators review evidence
- No middleman takes a cut beyond a 0.5% protocol fee from each side (1% total)

---

## SLIDE 3 — HOW IT WORKS

**5 steps, trustless end to end:**

**Step 1 — Seller creates a trade**
Seller locks USDT + 0.5% fee into a Solana vault, sets the PKR rate and payment method (EasyPaisa account, JazzCash, bank transfer).

**Step 2 — Buyer joins**
Buyer pays 0.5% fee to join. The trade activates. Buyer sees the seller's payment details and sends PKR off-chain.

**Step 3 — Seller confirms**
Seller confirms payment received on-chain. USDT is released to the buyer instantly. Trade complete.

**Step 4 — If disputed (rare)**
Buyer raises a dispute on-chain. Both parties submit their claim (max 500 chars) + evidence URL separately. Claims are sealed — neither party can see the other's until the dispute resolves, preventing claim-crafting.

**Step 5 — Arbitrators vote**
Three on-chain arbitrators (each staked 50 USDT as skin-in-the-game) review both claims and vote. 2/3 majority releases funds to the winner. No admin, no central authority.

---

## SLIDE 4 — TRUST MODEL

**Why arbitrators are trustworthy:**

- Each arbitrator stakes 50 USDT to register — they have economic skin in the game
- Votes are on-chain and permanent — bad actors are publicly traceable
- Blind claim submission — arbitrators see evidence before either party can tailor their story to counter the other's
- After 24 hours with no 2/3 majority, the dispute auto-times out (Anchor program enforced)
- Admin deadlock resolution only after 48 hours — not the default path

**Why the fee model is fair:**

| Action | Who pays | Amount |
|---|---|---|
| Create trade | Seller | 0.5% of trade amount |
| Join trade | Buyer | 0.5% of trade amount |
| Arbitrator earnings | Protocol | Accumulated from dispute fees |
| Cancel (open trade) | Nobody | Full refund to seller |
| Cancel (active > 30 min) | Buyer | Buyer's fee stays in protocol |

---

## SLIDE 5 — TECH STACK

**On-chain (Solana / Anchor):**
- Rust Anchor program — 8 instructions: create_trade, join_trade, confirm_payment, cancel_trade, raise_dispute, vote_on_dispute, stake_to_become_arbitrator, withdraw_arbitrator_earnings
- PDA vaults per trade — funds never pass through a hot wallet
- Deployed on devnet: `CtKjEzbZLj2FUWz1Rt15q4A5EW38NPCpoTXX9bcXUjgt`
- USDT (SPL Token, 6 decimals) — same standard as mainnet USDC/USDT

**Off-chain:**
- Next.js 16 frontend — server-side API routes for off-chain data
- Supabase (Postgres) — payment method details and dispute claim text (sensitive data stays off-chain)
- @solana/web3.js + Wallet Adapter — raw web3.js, no Anchor SDK dependency in frontend
- On-chain auth in API routes — every write verified against the actual on-chain account data

**Why Solana:**
- 400ms finality — trades confirm before a user notices
- Sub-cent fees — a Pakistani user on a 500 USDT trade pays ~$0.001 in network fees
- SPL Token standard — drop-in ready for mainnet USDT when we go live

---

## SLIDE 6 — TEAM + ROADMAP

**The team:**
- [Your name / team names here]
- Built in Pakistan for Pakistani users
- Submitted under Pakistan track, KAST x Colosseum Frontier Hackathon 2026

**Live demo:**
- Devnet deployment live and functional
- Full flow: create → join → confirm → dispute → arbitrate → release
- [Your Vercel/demo URL here]

**Roadmap:**

| Phase | What | When |
|---|---|---|
| V1 (now) | Devnet launch, 3 fixed arbitrators, USDT↔PKR | Hackathon submission |
| V2 | Mainnet, dynamic arbitrator registry (open staking), arbitrator reputation scores | Q3 2026 |
| V3 | Mobile app (PWA), EasyPaisa/JazzCash direct API integration for payment proof | Q4 2026 |
| V4 | Multi-asset (USDC, SOL), multi-currency (AED, SAR — diaspora remittances) | 2027 |

**Why now:**
Pakistan's SBP is actively developing a digital currency framework. The window to establish trusted P2P rails before institutional players arrive is open for the next 12–18 months. SafeP2P is the infrastructure layer that Pakistani traders need today.

---

*Built on Solana · Pakistan Track · Colosseum Frontier Hackathon 2026*
