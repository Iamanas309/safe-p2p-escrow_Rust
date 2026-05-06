'use client'

import Link from 'next/link'
import { WalletButton } from '@/components/solana/solana-provider'
import { SAFE_P2P_ESCROW_PROGRAM_ID } from '@/lib/constants'

const GREEN     = '#00cc33'
const GREEN_DIM = '#006622'
const YELLOW    = '#ccaa00'
const MONO      = "'Courier New', monospace"

const PROGRAM_ID = SAFE_P2P_ESCROW_PROGRAM_ID.toBase58()

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="terminal-page fixed inset-0 z-50 flex flex-col overflow-auto"
      style={{ background: '#000', fontFamily: MONO }}
    >
      {children}
      <div
        className="shrink-0 px-4 py-2 border-t"
        style={{ color: GREEN_DIM, borderColor: '#0d260d', fontSize: '0.7rem', letterSpacing: '0.03em' }}
      >
        {'>'} safe p2p escrow&nbsp;&nbsp;|&nbsp;&nbsp;devnet&nbsp;&nbsp;|&nbsp;&nbsp;protocol documentation
      </div>
    </div>
  )
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div style={{
      color: GREEN_DIM,
      fontSize: '0.68rem',
      letterSpacing: '0.14em',
      borderTop: `1px solid ${GREEN_DIM}`,
      paddingTop: '14px',
      marginTop: '22px',
      marginBottom: '10px',
    }}>
      ── {title} {'─'.repeat(Math.max(0, 40 - title.length))}
    </div>
  )
}

function Line({ text, dim = false, indent = false, yellow = false }: {
  text: string; dim?: boolean; indent?: boolean; yellow?: boolean
}) {
  return (
    <div style={{
      color: yellow ? YELLOW : dim ? GREEN_DIM : GREEN,
      fontSize: '0.78rem',
      letterSpacing: '0.03em',
      lineHeight: 1.85,
      paddingLeft: indent ? '14px' : 0,
    }}>
      {indent ? '  ' : '> '}{text}
    </div>
  )
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <div style={{ display: 'flex', gap: '10px', marginBottom: '4px' }}>
      <span style={{ color: GREEN_DIM, fontSize: '0.75rem', flexShrink: 0, minWidth: '18px' }}>
        {n}.
      </span>
      <span style={{ color: GREEN, fontSize: '0.78rem', letterSpacing: '0.03em', lineHeight: 1.75 }}>
        {text}
      </span>
    </div>
  )
}

function FeeRow({ who, fee, note }: { who: string; fee: string; note: string }) {
  return (
    <div style={{ padding: '6px 0', borderBottom: `1px solid ${GREEN_DIM}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', letterSpacing: '0.03em' }}>
        <span style={{ color: GREEN_DIM }}>{who}</span>
        <span style={{ color: YELLOW }}>{fee}</span>
      </div>
      <div style={{ color: GREEN_DIM, fontSize: '0.65rem', letterSpacing: '0.03em', marginTop: '1px' }}>
        {note}
      </div>
    </div>
  )
}

export function ProtocolFeature() {
  return (
    <Shell>
      {/* Header */}
      <div className="flex justify-between items-center px-6 py-4 shrink-0">
        <Link href="/" style={{ color: GREEN_DIM, fontSize: '0.8rem', letterSpacing: '0.08em', textDecoration: 'none' }}>
          {'<'} BACK
        </Link>
        <WalletButton />
      </div>

      {/* Body */}
      <div className="flex-1 px-4 pb-12" style={{ maxWidth: '600px', margin: '0 auto', width: '100%' }}>

        {/* Title */}
        <div style={{ marginBottom: '6px' }}>
          <div style={{ color: GREEN, fontSize: 'clamp(1rem, 3vw, 1.3rem)', letterSpacing: '0.18em' }}>
            {'>'} PROTOCOL
          </div>
          <div style={{ color: GREEN_DIM, fontSize: '0.72rem', letterSpacing: '0.05em', marginTop: '5px' }}>
            how safe p2p escrow works — read before you trade
          </div>
        </div>

        {/* ── What is this ── */}
        <SectionHeader title="WHAT IS SAFE P2P" />
        <Line text="SafeP2P is a trustless escrow for USDT ↔ PKR trades on Solana." />
        <Line text="It solves the #1 scam in Pakistan P2P: fake payment screenshots." dim />
        <Line text="Here, USDT is locked on-chain before any PKR changes hands." />
        <Line text="Nobody can release funds without both sides doing their part." dim />
        <Line text="Not us. Not the admin. Nobody. The code is the contract." yellow />

        {/* ── Selling ── */}
        <SectionHeader title="HOW SELLING WORKS" />
        <Line text="You want to sell USDT and receive PKR." dim />
        <Step n={1} text="Enter the USDT amount and your PKR rate on the SELL page." />
        <Step n={2} text="Your USDT + 0.5% fee gets locked in a program vault on-chain." />
        <Step n={3} text="A buyer joins your trade and locks their 0.5% fee." />
        <Step n={4} text="The buyer sends you PKR off-chain (bank / Easypaisa / JazzCash)." />
        <Step n={5} text="Once you receive PKR, click CONFIRM PAYMENT." />
        <Step n={6} text="The program releases USDT to the buyer. Your trade is complete." />
        <div style={{ marginTop: '8px' }}>
          <Line text="If no buyer joins, you can cancel anytime and get a full refund." dim />
          <Line text="If a buyer joined but 30 minutes passed, you can also cancel." dim />
        </div>

        {/* ── Buying ── */}
        <SectionHeader title="HOW BUYING WORKS" />
        <Line text="You want to buy USDT by paying PKR." dim />
        <Step n={1} text="Browse open trades on the BUY page — pick a rate that works for you." />
        <Step n={2} text="Click JOIN TRADE. Your 0.5% fee (tiny amount of USDT) gets locked." />
        <Step n={3} text="Send PKR to the seller off-chain. Get their payment details from them." />
        <Step n={4} text="Wait for the seller to confirm. USDT arrives in your wallet." />
        <Step n={5} text="If the seller doesn't confirm — raise a dispute. Arbitrators will decide." />
        <div style={{ marginTop: '8px' }}>
          <Line text="You only need 0.5% of the trade amount in USDT — not the full amount." yellow />
          <Line text="The full USDT is already locked by the seller before you join." dim />
        </div>

        {/* ── Disputes ── */}
        <SectionHeader title="DISPUTES" />
        <Line text="Disputes protect buyers from sellers who don't confirm after receiving PKR." dim />
        <Step n={1} text="Only the BUYER can raise a dispute (seller can't dispute their own trade)." />
        <Step n={2} text="3 arbitrators review and vote: FOR BUYER or FOR SELLER." />
        <Step n={3} text="2 out of 3 votes wins. USDT goes to the winning side." />
        <Step n={4} text="1% of the trade amount is paid to arbitrators who voted." />
        <Step n={5} text="If it's 1-1 (tie): admin resolves after 48 hours." />
        <div style={{ marginTop: '8px' }}>
          <Line text="Raise a dispute only if you genuinely paid and the seller is ghosting you." yellow />
          <Line text="False disputes waste arbitrator time and can be resolved against you." dim />
        </div>

        {/* ── Arbitrators ── */}
        <SectionHeader title="ARBITRATORS" />
        <Line text="Arbitrators are the human layer that resolves disputes." dim />
        <Step n={1} text="Stake 50 USDT to claim one of 3 arbitrator slots." />
        <Step n={2} text="When a trade is disputed, you vote: buyer or seller." />
        <Step n={3} text="If your vote is on the winning side, you earn 1% of the trade." />
        <Step n={4} text="Withdraw earnings at any time." />
        <Step n={5} text="Leave at any time — your 50 USDT stake is returned in full." />
        <div style={{ marginTop: '8px' }}>
          <Line text="Arbitrators who vote fairly earn more. The incentive is honest voting." dim />
        </div>

        {/* ── Fees ── */}
        <SectionHeader title="FEE STRUCTURE" />
        <div style={{ marginBottom: '4px' }}>
          <FeeRow who="SELLER FEE"     fee="0.5%"  note="of trade amount — locked at create" />
          <FeeRow who="BUYER FEE"      fee="0.5%"  note="of trade amount — locked at join" />
          <FeeRow who="DISPUTE REWARD" fee="1.0%"  note="of trade — split to voting arbitrators" />
          <FeeRow who="HIDDEN FEES"    fee="NONE"  note="ever" />
        </div>
        <div style={{ marginTop: '10px' }}>
          <Line text="Fees are collected by the vault. On a normal trade with no dispute," dim />
          <Line text="the 1% (seller fee + buyer fee) stays in the arbitrator reward pool." dim />
        </div>

        {/* ── Cancellation ── */}
        <SectionHeader title="CANCELLATION RULES" />
        <Line text="OPEN trade (no buyer yet):" dim />
        <Line text="Seller can cancel anytime. Full refund — USDT + fee returned." indent />
        <div style={{ marginTop: '6px' }}>
          <Line text="ACTIVE trade (buyer has joined):" dim />
          <Line text="Cancel is locked for the first 30 minutes after joining." indent />
          <Line text="After 30 min: seller gets USDT + seller fee back." indent />
          <Line text="Buyer's fee stays in the reward pool — penalty for wasted time." indent yellow />
        </div>

        {/* ── Trust model ── */}
        <SectionHeader title="TRUST MODEL" />
        <Line text="There is no trust required. The program enforces all rules." />
        <Line text="We (the team) cannot steal your funds." dim />
        <Line text="We cannot change the rules after deployment." dim />
        <Line text="We cannot freeze your trades." dim />
        <Line text="The admin's only power is resolving tied disputes after 48 hours." yellow />
        <div style={{ marginTop: '10px' }}>
          <Line text="Verify the program yourself:" dim />
          <div style={{ marginTop: '6px', padding: '10px', border: `1px solid ${GREEN_DIM}` }}>
            <div style={{ color: GREEN_DIM, fontSize: '0.65rem', letterSpacing: '0.05em', marginBottom: '4px' }}>
              PROGRAM ID (Solana Devnet)
            </div>
            <div style={{ color: GREEN, fontSize: '0.72rem', letterSpacing: '0.04em', wordBreak: 'break-all' }}>
              {PROGRAM_ID}
            </div>
            <a
              href={`https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'inline-block', marginTop: '8px', color: GREEN_DIM, fontSize: '0.65rem', letterSpacing: '0.05em', textDecoration: 'underline' }}
            >
              {'>'} view on Solana Explorer ↗
            </a>
          </div>
        </div>

        {/* ── Quick start ── */}
        <SectionHeader title="QUICK START" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
          {[
            { label: '[ SELL USDT ]',          href: '/sell',               note: 'lock USDT, receive PKR' },
            { label: '[ BUY USDT ]',            href: '/buy',                note: 'pay PKR, receive USDT' },
            { label: '[ MY TRADES ]',           href: '/my-trades',          note: 'manage your active trades' },
            { label: '[ BECOME ARBITRATOR ]',   href: '/become-arbitrator',  note: 'stake & earn dispute fees' },
          ].map(({ label, href, note }) => (
            <div key={href} style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <Link href={href}>
                <button
                  className="terminal-menu-btn"
                  style={{
                    border: `1px solid ${GREEN_DIM}`, color: GREEN, background: 'transparent',
                    fontFamily: MONO, fontSize: '0.72rem', letterSpacing: '0.08em',
                    padding: '5px 12px', cursor: 'pointer', whiteSpace: 'nowrap',
                  }}
                >
                  {label}
                </button>
              </Link>
              <span style={{ color: GREEN_DIM, fontSize: '0.68rem', letterSpacing: '0.03em', flexShrink: 1, minWidth: 0 }}>{note}</span>
            </div>
          ))}
        </div>

      </div>
    </Shell>
  )
}
