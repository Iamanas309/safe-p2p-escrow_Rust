'use client'

import Link from 'next/link'
import { WalletButton } from '@/components/solana/solana-provider'
import { SAFE_P2P_ESCROW_PROGRAM_ID } from '@/lib/constants'

const PROGRAM_ID = SAFE_P2P_ESCROW_PROGRAM_ID.toBase58()

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({ title, icon }: { title: string; icon: string }) {
  return (
    <div style={{ marginTop: 32, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: '1rem' }}>{icon}</span>
        <span style={{ color: '#fff', fontWeight: 600, fontSize: '0.88rem', letterSpacing: '0.01em' }}>
          {title}
        </span>
      </div>
      <div style={{ height: 1, background: 'linear-gradient(90deg, rgba(168,85,247,0.4), transparent)' }} />
    </div>
  )
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <div style={{ display: 'flex', gap: 12, marginBottom: 8, alignItems: 'flex-start' }}>
      <span style={{
        width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
        background: 'rgba(124,58,237,0.2)', border: '1px solid rgba(124,58,237,0.35)',
        color: '#a78bfa', fontSize: '0.65rem', fontWeight: 700,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginTop: 2,
      }}>
        {n}
      </span>
      <span style={{ color: '#cbd5e1', fontSize: '0.82rem', lineHeight: 1.65 }}>{text}</span>
    </div>
  )
}

function Note({ text, variant = 'default' }: { text: string; variant?: 'default' | 'warning' | 'highlight' }) {
  const colors = {
    default:   { color: '#475569', prefix: '→' },
    warning:   { color: '#f59e0b', prefix: '⚠' },
    highlight: { color: '#10b981', prefix: '✓' },
  }[variant]
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'flex-start' }}>
      <span style={{ color: colors.color, flexShrink: 0, fontSize: '0.75rem', marginTop: 2 }}>{colors.prefix}</span>
      <span style={{ color: colors.color, fontSize: '0.78rem', lineHeight: 1.65 }}>{text}</span>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function ProtocolFeature() {
  return (
    <div className="defi-page">

      {/* Top bar */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '16px 24px', flexShrink: 0, zIndex: 2,
        borderBottom: '1px solid rgba(255,255,255,0.05)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link href="/" style={{ color: '#475569', fontSize: '0.82rem', textDecoration: 'none' }}>
            ← Back
          </Link>
          <span style={{ color: 'rgba(255,255,255,0.1)' }}>|</span>
          <span style={{ color: '#fff', fontWeight: 600, fontSize: '0.88rem' }}>Protocol</span>
        </div>
        <WalletButton />
      </div>

      {/* Body */}
      <div className="defi-body">
        <div style={{ maxWidth: 620, margin: '0 auto', padding: '28px 20px 72px', width: '100%' }}>

          {/* Hero */}
          <div style={{ marginBottom: 4 }}>
            <h1 className="gradient-text" style={{
              fontSize: 'clamp(1.6rem, 6vw, 2.4rem)', fontWeight: 800,
              letterSpacing: '-0.03em', lineHeight: 1, margin: 0,
            }}>
              SafeP2P Protocol
            </h1>
            <p style={{ color: '#64748b', fontSize: '0.88rem', marginTop: 10, lineHeight: 1.6 }}>
              Trustless USDT ↔ PKR escrow on Solana. Read this before you trade.
            </p>
          </div>

          {/* What is this */}
          <SectionHeader title="What is SafeP2P?" icon="🔒" />
          <div className="glass-card" style={{ padding: '16px 20px' }}>
            <p style={{ color: '#cbd5e1', fontSize: '0.85rem', lineHeight: 1.8, margin: 0 }}>
              SafeP2P is a trustless escrow for USDT ↔ PKR trades on Solana. It solves the #1 scam in Pakistan P2P:
              <strong style={{ color: '#f87171' }}> fake payment screenshots</strong>. USDT is locked on-chain
              before any PKR changes hands — nobody can release funds without both sides doing their part.
              Not us. Not the admin. The code is the contract.
            </p>
            <div style={{ marginTop: 12, padding: '10px 14px', background: 'rgba(168,85,247,0.06)', borderRadius: 8, borderLeft: '2px solid rgba(168,85,247,0.4)' }}>
              <span style={{ color: '#a78bfa', fontSize: '0.8rem', fontWeight: 600 }}>
                Works with EasyPaisa · JazzCash · Bank Transfer · Raast
              </span>
            </div>
          </div>

          {/* Selling */}
          <SectionHeader title="How Selling Works" icon="↑" />
          <div style={{ marginBottom: 4 }}>
            <Note text="You want to sell USDT and receive PKR in return." />
          </div>
          <Step n={1} text="Enter the USDT amount and your PKR rate on the Sell page." />
          <Step n={2} text="Your USDT + 0.5% fee gets locked in a program vault on-chain." />
          <Step n={3} text="A buyer joins your trade and locks their 0.5% fee." />
          <Step n={4} text="The buyer sends you PKR off-chain via your chosen payment method." />
          <Step n={5} text="Once you confirm receipt, click Confirm Payment." />
          <Step n={6} text="The program automatically releases USDT to the buyer." />
          <div style={{ marginTop: 10 }}>
            <Note text="If no buyer joins, you can cancel anytime for a full refund." />
            <Note text="If a buyer joined and 30 minutes passed, you can also cancel." />
          </div>

          {/* Buying */}
          <SectionHeader title="How Buying Works" icon="↓" />
          <div style={{ marginBottom: 4 }}>
            <Note text="You want to buy USDT by paying PKR." />
          </div>
          <Step n={1} text="Browse open trades on the Buy page — pick a rate that works for you." />
          <Step n={2} text="Click Join Trade. Your 0.5% fee (tiny amount of USDT) gets locked." />
          <Step n={3} text="Send PKR to the seller using the payment details shown on the trade page." />
          <Step n={4} text="Wait for the seller to confirm receipt. USDT arrives in your wallet." />
          <Step n={5} text="If the seller doesn't confirm — raise a dispute. Arbitrators will decide." />
          <div style={{ marginTop: 10 }}>
            <Note text="You only need 0.5% of the trade amount in USDT — not the full amount." variant="highlight" />
            <Note text="The full USDT is already locked by the seller before you join." />
          </div>

          {/* Disputes */}
          <SectionHeader title="Disputes" icon="⚖️" />
          <div style={{ marginBottom: 4 }}>
            <Note text="Disputes protect buyers from sellers who don't confirm after receiving PKR." />
          </div>
          <Step n={1} text="Only the BUYER can raise a dispute (seller cannot dispute their own trade)." />
          <Step n={2} text="3 arbitrators review and vote: Buyer Wins or Seller Wins." />
          <Step n={3} text="2 out of 3 votes wins. USDT goes to the winning side." />
          <Step n={4} text="1% of the trade amount is distributed to arbitrators who voted correctly." />
          <Step n={5} text="If votes tie (1-1): admin resolves after 48 hours." />
          <div style={{ marginTop: 10 }}>
            <Note text="Raise a dispute only if you genuinely paid and the seller is ghosting you." variant="warning" />
            <Note text="False disputes waste arbitrator time and can be resolved against you." />
          </div>

          {/* Arbitrators */}
          <SectionHeader title="Arbitrators" icon="⬡" />
          <div style={{ marginBottom: 4 }}>
            <Note text="Arbitrators are the human layer that resolves disputes." />
          </div>
          <Step n={1} text="Stake 50 USDT to claim one of 3 arbitrator slots." />
          <Step n={2} text="When a trade is disputed, vote: Buyer Wins or Seller Wins." />
          <Step n={3} text="If your vote is on the winning side, you earn a share of 1% of the trade." />
          <Step n={4} text="Withdraw your earnings at any time while keeping your slot." />
          <Step n={5} text="Leave at any time — your 50 USDT stake is returned in full." />
          <div style={{ marginTop: 10 }}>
            <Note text="Arbitrators who vote fairly earn more. The incentive is honest voting." variant="highlight" />
          </div>

          {/* Fee structure */}
          <SectionHeader title="Fee Structure" icon="💰" />
          <div className="glass-card" style={{ padding: '4px 0', overflow: 'hidden' }}>
            {[
              { who: 'Seller fee',      fee: '0.5%', note: 'of trade amount — locked at create' },
              { who: 'Buyer fee',       fee: '0.5%', note: 'of trade amount — locked at join' },
              { who: 'Dispute reward',  fee: '1.0%', note: 'of trade — split to voting arbitrators' },
              { who: 'Hidden fees',     fee: 'None', note: 'ever — no withdrawal fees, no spread' },
            ].map(({ who, fee, note }, i, arr) => (
              <div key={who} style={{
                padding: '12px 20px',
                borderBottom: i < arr.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
              }}>
                <div>
                  <div style={{ color: '#94a3b8', fontSize: '0.8rem', fontWeight: 500 }}>{who}</div>
                  <div style={{ color: '#475569', fontSize: '0.7rem', marginTop: 2 }}>{note}</div>
                </div>
                <span style={{
                  color: fee === 'None' ? '#10b981' : '#f59e0b',
                  fontWeight: 700, fontSize: '0.95rem', flexShrink: 0,
                }}>
                  {fee}
                </span>
              </div>
            ))}
          </div>

          {/* Cancellation */}
          <SectionHeader title="Cancellation Rules" icon="🚫" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="glass-card-sm" style={{ padding: '12px 16px' }}>
              <div style={{ color: '#60a5fa', fontSize: '0.75rem', fontWeight: 600, marginBottom: 6 }}>
                OPEN trade (no buyer yet)
              </div>
              <div style={{ color: '#94a3b8', fontSize: '0.8rem', lineHeight: 1.6 }}>
                Seller can cancel anytime. Full refund — USDT + fee returned.
              </div>
            </div>
            <div className="glass-card-sm" style={{ padding: '12px 16px' }}>
              <div style={{ color: '#f59e0b', fontSize: '0.75rem', fontWeight: 600, marginBottom: 6 }}>
                ACTIVE trade (buyer has joined)
              </div>
              <div style={{ color: '#94a3b8', fontSize: '0.8rem', lineHeight: 1.6 }}>
                Cancel is locked for the first 30 minutes after joining.<br />
                After 30 min: seller gets USDT + seller fee back.<br />
                <span style={{ color: '#f87171' }}>Buyer's fee stays in the reward pool — penalty for wasted time.</span>
              </div>
            </div>
          </div>

          {/* Trust model */}
          <SectionHeader title="Trust Model" icon="🛡️" />
          <div style={{
            background: 'rgba(16,185,129,0.05)', border: '1px solid rgba(16,185,129,0.15)',
            borderRadius: 12, padding: '16px 20px',
          }}>
            <div style={{ color: '#10b981', fontWeight: 600, fontSize: '0.85rem', marginBottom: 10 }}>
              No trust required. The program enforces all rules.
            </div>
            {[
              'We cannot steal your funds.',
              'We cannot change the rules after deployment.',
              'We cannot freeze your trades.',
              'The admin\'s only power: resolving tied disputes after 48 hours.',
            ].map((line, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <span style={{ color: '#064e3b', flexShrink: 0 }}>✓</span>
                <span style={{ color: '#475569', fontSize: '0.8rem', lineHeight: 1.6 }}>{line}</span>
              </div>
            ))}
          </div>

          {/* Program ID */}
          <div style={{ marginTop: 20 }}>
            <div style={{
              background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: 10, padding: '14px 18px',
            }}>
              <div style={{ color: '#334155', fontSize: '0.68rem', letterSpacing: '0.08em', marginBottom: 6 }}>
                PROGRAM ID · SOLANA DEVNET
              </div>
              <div style={{ color: '#60a5fa', fontSize: '0.78rem', fontFamily: 'monospace', wordBreak: 'break-all', letterSpacing: '0.03em' }}>
                {PROGRAM_ID}
              </div>
              <a
                href={`https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet`}
                target="_blank" rel="noopener noreferrer"
                style={{ display: 'inline-block', marginTop: 10, fontSize: '0.72rem', color: '#475569', textDecoration: 'underline' }}
              >
                View on Solana Explorer ↗
              </a>
            </div>
          </div>

          {/* Quick start */}
          <SectionHeader title="Quick Start" icon="⚡" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              { label: 'Sell USDT',          href: '/sell',              note: 'Lock USDT, receive PKR',        color: '#a78bfa', bg: 'rgba(124,58,237,0.1)', border: 'rgba(124,58,237,0.25)' },
              { label: 'Buy USDT',           href: '/buy',               note: 'Pay PKR, receive USDT',         color: '#34d399', bg: 'rgba(16,185,129,0.08)', border: 'rgba(16,185,129,0.2)' },
              { label: 'My Trades',          href: '/my-trades',         note: 'Manage your active trades',     color: '#60a5fa', bg: 'rgba(96,165,250,0.08)', border: 'rgba(96,165,250,0.2)' },
              { label: 'Become Arbitrator',  href: '/become-arbitrator', note: 'Stake 50 USDT · earn dispute fees', color: '#fbbf24', bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.2)' },
            ].map(({ label, href, note, color, bg, border }) => (
              <Link key={href} href={href} style={{ textDecoration: 'none' }}>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '12px 16px', borderRadius: 10, cursor: 'pointer',
                  background: bg, border: `1px solid ${border}`,
                  transition: 'opacity 0.15s',
                }}>
                  <div>
                    <div style={{ color, fontWeight: 600, fontSize: '0.85rem' }}>{label}</div>
                    <div style={{ color: '#475569', fontSize: '0.72rem', marginTop: 2 }}>{note}</div>
                  </div>
                  <span style={{ color, fontSize: '1rem' }}>→</span>
                </div>
              </Link>
            ))}
          </div>

        </div>
      </div>

      {/* Status bar */}
      <div style={{
        flexShrink: 0, padding: '9px 24px',
        borderTop: '1px solid rgba(255,255,255,0.05)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ color: '#475569', fontSize: '0.68rem', fontFamily: 'monospace' }}>SafeP2P</span>
        <span style={{ color: '#475569', fontSize: '0.68rem' }}>devnet · protocol docs</span>
      </div>
    </div>
  )
}
