'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useConnection } from '@solana/wallet-adapter-react'
import { WalletButton } from '@/components/solana/solana-provider'
import { SAFE_P2P_ESCROW_PROGRAM_ID } from '@/lib/constants'

const PROGRAM_ID = SAFE_P2P_ESCROW_PROGRAM_ID.toBase58()
const PROGRAM_SHORT = `${PROGRAM_ID.slice(0, 4)}...${PROGRAM_ID.slice(-4)}`
const GREEN = '#00cc33'
const GREEN_DIM = '#006622'
const MONO = "'Courier New', monospace"

const MENU = [
  { label: 'BUY USDT', href: '/buy' },
  { label: 'SELL USDT', href: '/sell' },
  { label: 'MY TRADES', href: '/my-trades' },
  { label: 'BECOME ARBITRATOR', href: '/become-arbitrator' },
  { label: 'DISPUTE PANEL', href: '/arbitrate' },
  { label: 'PROTOCOL', href: '/protocol' },
]

// 5-wide × 7-tall dot-matrix pixel maps (1 = lit, 0 = dim)
const DOT: Record<string, number[][]> = {
  S: [
    [0,1,1,1,0],
    [1,0,0,0,1],
    [1,0,0,0,0],
    [0,1,1,1,0],
    [0,0,0,0,1],
    [1,0,0,0,1],
    [0,1,1,1,0],
  ],
  A: [
    [0,1,1,1,0],
    [1,0,0,0,1],
    [1,0,0,0,1],
    [1,1,1,1,1],
    [1,0,0,0,1],
    [1,0,0,0,1],
    [1,0,0,0,1],
  ],
  F: [
    [1,1,1,1,1],
    [1,0,0,0,0],
    [1,0,0,0,0],
    [1,1,1,1,0],
    [1,0,0,0,0],
    [1,0,0,0,0],
    [1,0,0,0,0],
  ],
  E: [
    [1,1,1,1,1],
    [1,0,0,0,0],
    [1,0,0,0,0],
    [1,1,1,0,0],
    [1,0,0,0,0],
    [1,0,0,0,0],
    [1,1,1,1,1],
  ],
}

function PixelChar({ char, px, gap }: { char: string; px: number; gap: number }) {
  const rows = DOT[char]
  if (!rows) return null
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(5, ${px}px)`,
        gap: `${gap}px`,
        flexShrink: 0,
      }}
    >
      {rows.flat().map((lit, i) => (
        <div
          key={i}
          style={{
            width: px,
            height: px,
            background: lit ? GREEN : 'rgba(0, 80, 20, 0.18)',
            boxShadow: lit ? `0 0 4px ${GREEN}` : 'none',
            borderRadius: '1px',
          }}
        />
      ))}
    </div>
  )
}

function BlockCursor({ px, charH }: { px: number; charH: number }) {
  return (
    <div
      className="terminal-cursor"
      style={{
        width: px + 2,
        height: charH,
        background: GREEN,
        boxShadow: `0 0 8px ${GREEN}, 0 0 16px rgba(0,204,51,0.4)`,
        borderRadius: '1px',
        flexShrink: 0,
      }}
    />
  )
}

const SAFE_CHARS = ['S', 'A', 'F', 'E']
const P2P_CHARS  = ['P', '2', 'P']
const CHAR_MS    = 220   // ms per character

export function TerminalLanding() {
  const { connection } = useConnection()
  const [slot, setSlot]       = useState<number | null>(null)
  const [started, setStarted] = useState(false)
  const [safeN, setSafeN]     = useState(0)
  const [p2pN, setP2pN]       = useState(0)

  // Responsive pixel art sizing
  const [dotPx, setDotPx]   = useState(10)
  const [dotGap, setDotGap] = useState(3)
  const [charGap, setCharGap] = useState(14)
  useEffect(() => {
    const update = () => {
      const w = window.innerWidth
      if (w < 400)      { setDotPx(7);  setDotGap(2); setCharGap(8)  }
      else if (w < 640) { setDotPx(8);  setDotGap(2); setCharGap(10) }
      else              { setDotPx(10); setDotGap(3); setCharGap(14) }
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  const CHAR_H = 7 * dotPx + 6 * dotGap

  // Live devnet slot
  useEffect(() => {
    const fetch = async () => { try { setSlot(await connection.getSlot()) } catch {} }
    fetch()
    const id = setInterval(fetch, 5000)
    return () => clearInterval(id)
  }, [connection])

  // Initial pause before typing starts (cursor blinks alone)
  useEffect(() => {
    const t = setTimeout(() => setStarted(true), 700)
    return () => clearTimeout(t)
  }, [])

  // Type SAFE → pause → type P2P
  useEffect(() => {
    if (!started) return
    if (safeN < SAFE_CHARS.length) {
      const t = setTimeout(() => setSafeN(n => n + 1), CHAR_MS)
      return () => clearTimeout(t)
    }
    if (p2pN < P2P_CHARS.length) {
      // extra pause between SAFE done and first P2P char
      const t = setTimeout(() => setP2pN(n => n + 1), p2pN === 0 ? 400 : CHAR_MS)
      return () => clearTimeout(t)
    }
  }, [started, safeN, p2pN])

  const safeDone = safeN === SAFE_CHARS.length
  const p2pDone  = p2pN  === P2P_CHARS.length

  // Cursor placement rules:
  //   block cursor in SAFE row  → while typing SAFE, or during post-SAFE pause
  //   _ cursor in P2P row       → while typing P2P (p2pN > 0 and not done)
  //   _ cursor after tagline    → after everything is done
  const showSafeCursor = !safeDone || p2pN === 0
  const showP2pRow     = p2pN > 0
  const showP2pCursor  = showP2pRow && !p2pDone

  return (
    <div
      className="terminal-page fixed inset-0 z-50 flex flex-col overflow-hidden"
      style={{ background: '#000000', fontFamily: MONO }}
    >
      {/* Top bar */}
      <div className="flex justify-end items-center px-6 py-4 shrink-0">
        <WalletButton />
      </div>

      {/* Centered content — scrollable outer, my-auto inner so it centers when space allows */}
      <div className="flex-1 flex flex-col items-center min-h-0 overflow-y-auto">
        <div className="flex flex-col items-center gap-0 w-full my-auto py-6 px-6">

          {/* ── SAFE dot-matrix + block cursor ── */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: `${charGap}px` }}>
            {SAFE_CHARS.slice(0, safeN).map((c, i) => (
              <PixelChar key={i} char={c} px={dotPx} gap={dotGap} />
            ))}
            {showSafeCursor && <BlockCursor px={dotPx} charH={CHAR_H} />}
          </div>

          {/* ── P2P typed text ── */}
          {showP2pRow && (
            <div
              style={{
                marginTop: '18px',
                color: GREEN,
                fontSize: 'clamp(1.1rem, 4vw, 1.9rem)',
                letterSpacing: '0.55em',
                textShadow: `0 0 6px ${GREEN}`,
                display: 'flex',
                alignItems: 'center',
                gap: '2px',
              }}
            >
              <span>{P2P_CHARS.slice(0, p2pN).join('')}</span>
              {showP2pCursor && (
                <span className="terminal-cursor" style={{ color: GREEN, letterSpacing: 0 }}>_</span>
              )}
            </div>
          )}

          {/* ── Tagline — visible once P2P is done ── */}
          {p2pDone && (
            <div style={{ marginTop: '16px', color: GREEN, fontSize: 'clamp(0.7rem, 2vw, 0.85rem)' }}>
              {'>'} trustless p2p escrow. no scams.
              <span className="terminal-cursor" style={{ color: GREEN }}> _</span>
            </div>
          )}

          {/* ── Menu buttons — visible once P2P is done ── */}
          {p2pDone && (
            <nav
              className="flex flex-col items-center mt-8 gap-2 w-full"
              style={{ maxWidth: '340px' }}
            >
              {MENU.map(({ label, href }) => (
                <Link key={href} href={href} className="w-full">
                  <button
                    className="terminal-menu-btn w-full py-3 px-4 border text-center transition-all duration-100"
                    style={{
                      color: GREEN,
                      borderColor: GREEN,
                      background: 'transparent',
                      fontFamily: MONO,
                      fontSize: 'clamp(0.75rem, 2.5vw, 0.9rem)',
                      letterSpacing: '0.12em',
                    }}
                  >
                    [ {label} ]
                  </button>
                </Link>
              ))}
            </nav>
          )}

        </div>
      </div>

      {/* ── Status bar ── */}
      <div
        className="shrink-0 px-4 py-2 border-t"
        style={{
          color: GREEN_DIM,
          borderColor: '#0d260d',
          fontFamily: MONO,
          fontSize: '0.7rem',
          letterSpacing: '0.03em',
        }}
      >
        {'>'} connected to devnet&nbsp;&nbsp;|&nbsp;&nbsp;program: {PROGRAM_SHORT}&nbsp;&nbsp;|&nbsp;&nbsp;block:{' '}
        {slot !== null
          ? slot.toLocaleString()
          : <span style={{ color: GREEN_DIM }}>syncing...</span>}
      </div>
    </div>
  )
}
