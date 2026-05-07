'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useConnection } from '@solana/wallet-adapter-react'
import { WalletButton } from '@/components/solana/solana-provider'
import { SAFE_P2P_ESCROW_PROGRAM_ID } from '@/lib/constants'

const PROGRAM_ID    = SAFE_P2P_ESCROW_PROGRAM_ID.toBase58()
const PROGRAM_SHORT = `${PROGRAM_ID.slice(0, 4)}…${PROGRAM_ID.slice(-4)}`

interface MenuItemDef {
  label: string
  href: string
  icon: string
  hint: string
  hintColor: string
  iconBg: string
  iconBorder: string
  iconColor: string
  glowColor: string
}

const MENU: MenuItemDef[] = [
  {
    label: 'Buy USDT', href: '/buy', icon: '↓',
    hint: '+ receive USDT', hintColor: '#10b981',
    iconBg: 'rgba(16,185,129,0.12)', iconBorder: 'rgba(16,185,129,0.3)',
    iconColor: '#34d399', glowColor: 'rgba(16,185,129,0.35)',
  },
  {
    label: 'Sell USDT', href: '/sell', icon: '↑',
    hint: 'lock & earn PKR', hintColor: '#a78bfa',
    iconBg: 'rgba(124,58,237,0.15)', iconBorder: 'rgba(124,58,237,0.35)',
    iconColor: '#a78bfa', glowColor: 'rgba(124,58,237,0.35)',
  },
  {
    label: 'My Trades', href: '/my-trades', icon: '◈',
    hint: 'track activity', hintColor: '#60a5fa',
    iconBg: 'rgba(37,99,235,0.12)', iconBorder: 'rgba(37,99,235,0.3)',
    iconColor: '#60a5fa', glowColor: 'rgba(37,99,235,0.35)',
  },
  {
    label: 'Become Arbitrator', href: '/become-arbitrator', icon: '⬡',
    hint: '50 USDT stake', hintColor: '#f59e0b',
    iconBg: 'rgba(245,158,11,0.12)', iconBorder: 'rgba(245,158,11,0.3)',
    iconColor: '#fbbf24', glowColor: 'rgba(245,158,11,0.35)',
  },
  {
    label: 'Dispute Panel', href: '/arbitrate', icon: '⚖',
    hint: '2/3 vote decides', hintColor: '#ef4444',
    iconBg: 'rgba(239,68,68,0.12)', iconBorder: 'rgba(239,68,68,0.3)',
    iconColor: '#f87171', glowColor: 'rgba(239,68,68,0.35)',
  },
  {
    label: 'Protocol', href: '/protocol', icon: '◎',
    hint: '0.5% fee · trustless', hintColor: '#94a3b8',
    iconBg: 'rgba(255,255,255,0.06)', iconBorder: 'rgba(255,255,255,0.15)',
    iconColor: '#94a3b8', glowColor: 'rgba(255,255,255,0.15)',
  },
]

// ── Escrow flow diagram ───────────────────────────────────────────────────────

function FlowNode({
  emoji, title, sub, borderColor, bgColor, glowColor,
}: {
  emoji: string; title: string; sub: string
  borderColor: string; bgColor: string; glowColor: string
}) {
  return (
    <div style={{
      background: bgColor,
      border: `1px solid ${borderColor}`,
      borderRadius: 12,
      padding: '10px 10px 8px',
      textAlign: 'center',
      minWidth: 72,
      flexShrink: 0,
      boxShadow: `0 0 18px ${glowColor}`,
    }}>
      <div style={{ fontSize: '1.15rem', lineHeight: 1, marginBottom: 5 }}>{emoji}</div>
      <div style={{ color: '#fff', fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.06em' }}>{title}</div>
      <div style={{ color: '#475569', fontSize: '0.57rem', marginTop: 2 }}>{sub}</div>
    </div>
  )
}

function FlowArrow({ label, dotDelay, dotColor }: { label: string; dotDelay: string; dotColor: string }) {
  return (
    <div style={{ flex: 1, position: 'relative', height: 44, minWidth: 32 }}>
      <div style={{
        position: 'absolute', top: '50%', left: 4, right: 4,
        height: 1,
        background: 'linear-gradient(90deg, rgba(168,85,247,0.25), rgba(59,130,246,0.25))',
      }} />
      <div
        className="flow-dot"
        style={{ animationDelay: dotDelay, background: dotColor }}
      />
      <div style={{
        position: 'absolute', bottom: 3, left: '50%', transform: 'translateX(-50%)',
        color: '#334155', fontSize: '0.55rem', whiteSpace: 'nowrap', letterSpacing: '0.04em',
      }}>{label}</div>
      <div style={{
        position: 'absolute', top: '50%', right: 2, transform: 'translateY(-50%)',
        color: 'rgba(168,85,247,0.5)', fontSize: '0.7rem', lineHeight: 1,
      }}>›</div>
    </div>
  )
}

function FlowDiagram() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      width: '100%', maxWidth: '420px',
      marginBottom: '36px', padding: '0 4px',
    }}>
      <FlowNode
        emoji="👤" title="SELLER" sub="locks USDT"
        bgColor="rgba(255,255,255,0.03)"
        borderColor="rgba(255,255,255,0.09)"
        glowColor="transparent"
      />
      <FlowArrow label="USDT" dotDelay="0s" dotColor="linear-gradient(90deg,#a855f7,#3b82f6)" />
      <FlowNode
        emoji="🔒" title="VAULT" sub="on-chain"
        bgColor="rgba(124,58,237,0.1)"
        borderColor="rgba(124,58,237,0.35)"
        glowColor="rgba(124,58,237,0.18)"
      />
      <FlowArrow label="USDT" dotDelay="1.1s" dotColor="linear-gradient(90deg,#3b82f6,#10b981)" />
      <FlowNode
        emoji="💸" title="BUYER" sub="gets USDT"
        bgColor="rgba(16,185,129,0.06)"
        borderColor="rgba(16,185,129,0.22)"
        glowColor="rgba(16,185,129,0.12)"
      />
    </div>
  )
}

// ── Menu item with per-item hover effect ──────────────────────────────────────

function MenuItem({ item }: { item: MenuItemDef }) {
  const [hov, setHov] = useState(false)
  return (
    <Link href={item.href} style={{ textDecoration: 'none' }}>
      <div
        onMouseEnter={() => setHov(true)}
        onMouseLeave={() => setHov(false)}
        style={{
          display: 'flex', alignItems: 'center', gap: '12px',
          padding: '11px 14px', borderRadius: '10px', cursor: 'pointer',
          background: hov ? 'rgba(255,255,255,0.06)' : 'transparent',
          transition: 'background 0.15s',
        }}
      >
        {/* Icon box */}
        <span style={{
          width: 34, height: 34, borderRadius: 9, flexShrink: 0,
          background: hov ? item.iconBg : 'rgba(255,255,255,0.04)',
          border: `1px solid ${hov ? item.iconBorder : 'rgba(255,255,255,0.08)'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '0.9rem',
          color: hov ? item.iconColor : '#64748b',
          transition: 'all 0.18s',
          boxShadow: hov ? `0 0 14px ${item.glowColor}` : 'none',
          transform: hov ? 'scale(1.12)' : 'scale(1)',
        }}>
          {item.icon}
        </span>

        {/* Label */}
        <span style={{
          fontSize: '0.88rem', fontWeight: 500, flex: 1,
          color: hov ? '#fff' : '#cbd5e1',
          transition: 'color 0.15s',
        }}>
          {item.label}
        </span>

        {/* Hint — slides in on hover */}
        <span style={{
          fontSize: '0.7rem', fontWeight: 500, color: item.hintColor,
          opacity: hov ? 1 : 0,
          transform: hov ? 'translateX(0)' : 'translateX(10px)',
          transition: 'opacity 0.2s, transform 0.2s',
          whiteSpace: 'nowrap',
        }}>
          {item.hint}
        </span>

        {/* Arrow */}
        <span style={{
          color: hov ? '#fff' : '#334155',
          fontSize: '0.78rem',
          transition: 'all 0.18s',
          transform: hov ? 'translateX(3px)' : 'translateX(0)',
          flexShrink: 0,
        }}>→</span>
      </div>
    </Link>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function TerminalLanding() {
  const { connection } = useConnection()
  const [slot, setSlot]       = useState<number | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const go = async () => { try { setSlot(await connection.getSlot()) } catch {} }
    go()
    const id = setInterval(go, 5000)
    return () => clearInterval(id)
  }, [connection])

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 120)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="defi-page">

      {/* Top bar */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '16px 24px', position: 'relative', zIndex: 2, flexShrink: 0,
        borderBottom: '1px solid rgba(255,255,255,0.05)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{
            width: 28, height: 28, borderRadius: 8,
            background: 'linear-gradient(135deg, #a855f7, #3b82f6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '0.72rem', fontWeight: 800, color: '#fff',
          }}>S</div>
          <span style={{ color: '#fff', fontWeight: 600, fontSize: '0.88rem', letterSpacing: '0.01em' }}>
            SafeP2P
          </span>
        </div>
        <WalletButton />
      </div>

      {/* Body */}
      <div className="defi-body">
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', minHeight: '100%', padding: '32px 24px 56px',
          opacity: visible ? 1 : 0,
          transform: visible ? 'translateY(0)' : 'translateY(16px)',
          transition: 'opacity 0.55s ease, transform 0.55s ease',
        }}>

          {/* Hero */}
          <div style={{ textAlign: 'center', marginBottom: '10px' }}>
            <h1 className="gradient-text" style={{
              fontSize: 'clamp(3rem, 13vw, 7rem)', fontWeight: 800,
              letterSpacing: '-0.04em', lineHeight: 0.95, margin: 0,
            }}>
              SAFE
            </h1>
            <h2 style={{
              fontSize: 'clamp(1rem, 4vw, 2.2rem)', fontWeight: 600,
              letterSpacing: '0.26em', color: 'rgba(255,255,255,0.28)',
              margin: '8px 0 0', textTransform: 'uppercase',
            }}>
              P2P Escrow
            </h2>
          </div>

          {/* Tagline */}
          <p style={{
            color: '#64748b', fontSize: 'clamp(0.78rem, 2.2vw, 0.92rem)',
            textAlign: 'center', maxWidth: '300px',
            lineHeight: 1.7, marginBottom: '32px',
          }}>
            Trustless USDT ↔ PKR on Solana.<br />
            Escrowed on-chain. No middleman.
          </p>

          {/* Flow diagram */}
          <FlowDiagram />

          {/* Glass menu card */}
          <div className="glass-card" style={{
            width: '100%', maxWidth: '400px',
            padding: '6px', display: 'flex', flexDirection: 'column',
          }}>
            {MENU.map(item => <MenuItem key={item.href} item={item} />)}
          </div>

          {/* Stats */}
          <div style={{
            display: 'flex', gap: '32px', marginTop: '36px',
            flexWrap: 'wrap', justifyContent: 'center',
          }}>
            {[
              { label: 'Network',  value: 'Solana Devnet'   },
              { label: 'Protocol', value: 'On-chain Escrow' },
              { label: 'Fee',      value: '0.5%'            },
            ].map(({ label, value }) => (
              <div key={label} style={{ textAlign: 'center' }}>
                <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.85rem' }}>{value}</div>
                <div style={{ color: '#334155', fontSize: '0.68rem', marginTop: '2px' }}>{label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div style={{
        flexShrink: 0, padding: '9px 24px',
        borderTop: '1px solid rgba(255,255,255,0.05)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        position: 'relative', zIndex: 2, flexWrap: 'wrap', gap: '6px',
      }}>
        <span style={{ color: '#475569', fontSize: '0.68rem', fontFamily: 'monospace' }}>
          {PROGRAM_SHORT}
        </span>
        <span style={{ color: '#475569', fontSize: '0.68rem' }}>
          block {slot !== null ? slot.toLocaleString() : '…'}
        </span>
      </div>
    </div>
  )
}
