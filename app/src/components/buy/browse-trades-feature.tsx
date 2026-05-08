'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { WalletButton } from '@/components/solana/solana-provider'
import { SAFE_P2P_ESCROW_PROGRAM_ID, USDT_DECIMALS, USDT_MINT } from '@/lib/constants'

const TRADE_DISC = [46, 97, 187, 111, 38, 69, 11, 236]

// ── Pure-JS u64 helpers ───────────────────────────────────────────────────────

function u64LE(value: bigint): Buffer {
  const bytes: number[] = []
  let v = value
  for (let i = 0; i < 8; i++) { bytes.push(Number(v & 0xffn)); v >>= 8n }
  return Buffer.from(bytes)
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  let r = 0n
  for (let i = 7; i >= 0; i--) r = (r << 8n) | BigInt(data[offset + i])
  return r
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface OpenTrade {
  pda: string
  tradeId: bigint
  seller: string
  amount: bigint
  rate: bigint
  createdAt: number
}

interface PayInfo {
  method: string
  account: string
  name: string
}

// ── PDA helpers ───────────────────────────────────────────────────────────────

function tradePDA(tradeId: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('trade'), u64LE(tradeId)],
    SAFE_P2P_ESCROW_PROGRAM_ID,
  )
}

function vaultPDA(tradeId: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), u64LE(tradeId)],
    SAFE_P2P_ESCROW_PROGRAM_ID,
  )
}

// ── Data fetching ─────────────────────────────────────────────────────────────

function decodeOpenTrade(pda: string, data: Buffer): OpenTrade | null {
  if (data.length < 115) return null
  for (let i = 0; i < 8; i++) if (data[i] !== TRADE_DISC[i]) return null
  if (data[112] !== 0) return null
  return {
    pda,
    tradeId:   readU64LE(data, 8),
    seller:    new PublicKey(data.slice(16, 48)).toBase58(),
    amount:    readU64LE(data, 80),
    rate:      readU64LE(data, 88),
    createdAt: Number(readU64LE(data, 96)),
  }
}

// ── Instruction builder ───────────────────────────────────────────────────────

function buildJoinTradeIx(
  tradeId: bigint,
  tradeAccount: PublicKey,
  vault: PublicKey,
  buyer: PublicKey,
  buyerTokenAccount: PublicKey,
): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from([215, 116, 38, 205, 90, 111, 131, 172]),
    u64LE(tradeId),
  ])
  return new TransactionInstruction({
    programId: SAFE_P2P_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: tradeAccount,      isSigner: false, isWritable: true  },
      { pubkey: vault,             isSigner: false, isWritable: true  },
      { pubkey: buyer,             isSigner: true,  isWritable: true  },
      { pubkey: buyerTokenAccount, isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,  isSigner: false, isWritable: false },
    ],
    data,
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatUsdt(micro: bigint): string {
  return (Number(micro) / 10 ** USDT_DECIMALS).toFixed(2)
}

function timeAgo(unixSecs: number): string {
  if (unixSecs === 0) return '—'
  const diff = Math.floor(Date.now() / 1000) - unixSecs
  if (diff < 60)    return `${diff}s ago`
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

// ── Shell ─────────────────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="defi-page">
      {children}
      <div style={{
        flexShrink: 0, padding: '8px 24px',
        borderTop: '1px solid var(--defi-border)',
        display: 'flex', justifyContent: 'space-between',
        color: '#475569', fontSize: '0.65rem',
      }}>
        <span>safe p2p escrow · devnet</span>
        <span>buy / browse trades</span>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function BrowseTradesFeature() {
  const router                         = useRouter()
  const { connection }                 = useConnection()
  const { publicKey, sendTransaction } = useWallet()

  const [trades, setTrades]         = useState<OpenTrade[]>([])
  const [payInfoMap, setPayInfoMap] = useState<Record<string, PayInfo | null>>({})
  const [marketRate, setMarketRate] = useState<number | null>(null)
  const [loading, setLoading]       = useState(false)
  const [joiningId, setJoiningId]   = useState<string | null>(null)
  const [errorMsg, setErrorMsg]     = useState('')

  useEffect(() => {
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=pkr')
      .then(r => r.json())
      .then(d => setMarketRate(Math.round(d?.tether?.pkr ?? 0)))
      .catch(() => {})
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setErrorMsg('')
    try {
      const accounts = await connection.getProgramAccounts(SAFE_P2P_ESCROW_PROGRAM_ID, {
        filters: [{ dataSize: 115 }],
      })
      const open: OpenTrade[] = []
      for (const { pubkey, account } of accounts) {
        const t = decodeOpenTrade(pubkey.toBase58(), account.data as Buffer)
        if (t) open.push(t)
      }
      open.sort((a, b) => b.createdAt - a.createdAt)
      setTrades(open)

      const map: Record<string, PayInfo | null> = {}
      await Promise.all(open.map(async t => {
        try {
          const res = await fetch(`/api/trade-info?pda=${t.pda}`)
          map[t.pda] = res.ok ? await res.json() : null
        } catch { map[t.pda] = null }
      }))
      setPayInfoMap(map)
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [connection])

  useEffect(() => { load() }, [load])

  async function handleJoin(t: OpenTrade) {
    if (!publicKey) return
    setJoiningId(t.pda)
    setErrorMsg('')
    try {
      const [tradeAccount] = tradePDA(t.tradeId)
      const [vault]        = vaultPDA(t.tradeId)
      const usdtMint       = new PublicKey(USDT_MINT)
      const buyerAta       = getAssociatedTokenAddressSync(usdtMint, publicKey)
      const tx             = new Transaction()
      const ataInfo        = await connection.getAccountInfo(buyerAta)
      if (!ataInfo) tx.add(createAssociatedTokenAccountInstruction(publicKey, buyerAta, publicKey, usdtMint))
      tx.add(buildJoinTradeIx(t.tradeId, tradeAccount, vault, publicKey, buyerAta))
      const sig = await sendTransaction(tx, connection)
      await connection.confirmTransaction(sig, 'confirmed')
      router.push(`/trade/${t.tradeId}`)
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e)
      setErrorMsg(raw.length > 200 ? raw.slice(0, 200) + '…' : raw)
      setJoiningId(null)
    }
  }

  // ── Trade card ────────────────────────────────────────────────────────────

  function TradeCard({ t }: { t: OpenTrade }) {
    const wallet    = publicKey?.toBase58() ?? ''
    const isOwn     = t.seller === wallet
    const isJoining = joiningId === t.pda
    const canJoin   = !!publicKey && !isOwn && !joiningId
    const payInfo   = payInfoMap[t.pda]

    const amountDisplay = formatUsdt(t.amount)
    const feeMicro      = (t.amount * 5n) / 1000n
    const feeDisplay    = formatUsdt(feeMicro)
    const pkrAmount     = (Number(t.amount) / 10 ** USDT_DECIMALS * Number(t.rate)).toLocaleString()

    return (
      <div className="glass-card-sm" style={{ padding: '20px', marginBottom: '12px', opacity: isJoining ? 0.6 : 1, transition: 'opacity 0.2s' }}>

        {/* Header row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <span style={{ color: '#60a5fa', fontSize: '0.75rem', fontWeight: 600, fontFamily: 'monospace', letterSpacing: '0.05em' }}>
            #{t.tradeId.toString().padStart(7, '0')}
          </span>
          <span className="badge badge-open">Open</span>
        </div>

        {/* Main amount */}
        <div style={{ marginBottom: '16px' }}>
          <div style={{ color: '#fff', fontSize: '1.75rem', fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1 }}>
            {amountDisplay} <span style={{ fontSize: '1rem', color: '#94a3b8', fontWeight: 500 }}>USDT</span>
          </div>
          <div style={{ color: '#475569', fontSize: '0.82rem', marginTop: '5px' }}>
            ≈ {pkrAmount} PKR to send
          </div>
        </div>

        {/* Details */}
        <div style={{ borderTop: '1px solid var(--defi-border)', borderBottom: '1px solid var(--defi-border)', padding: '4px 0', marginBottom: '14px' }}>
          <div className="defi-row">
            <span style={{ color: 'var(--defi-text-mute)', fontSize: '0.82rem' }}>Rate</span>
            <span style={{ color: '#e2e8f0', fontSize: '0.82rem' }}>{t.rate.toString()} PKR / USDT</span>
          </div>
          <div className="defi-row">
            <span style={{ color: 'var(--defi-text-mute)', fontSize: '0.82rem' }}>Your fee (0.5%)</span>
            <span style={{ color: '#f59e0b', fontSize: '0.82rem' }}>−{feeDisplay} USDT</span>
          </div>
          <div className="defi-row">
            <span style={{ color: 'var(--defi-text-mute)', fontSize: '0.82rem' }}>Seller</span>
            <span style={{ color: '#64748b', fontSize: '0.74rem', fontFamily: 'monospace' }}>
              {t.seller.slice(0, 6)}…{t.seller.slice(-6)}
            </span>
          </div>
          <div className="defi-row">
            <span style={{ color: 'var(--defi-text-mute)', fontSize: '0.82rem' }}>Posted</span>
            <span style={{ color: '#475569', fontSize: '0.82rem' }}>{timeAgo(t.createdAt)}</span>
          </div>
          <div className="defi-row">
            <span style={{ color: 'var(--defi-text-mute)', fontSize: '0.82rem' }}>Payment via</span>
            <span className="badge badge-open" style={{ fontSize: '0.62rem' }}>
              {payInfo?.method ?? 'EasyPaisa / JazzCash'}
            </span>
          </div>
        </div>

        {/* Note */}
        <div style={{ color: '#334155', fontSize: '0.72rem', lineHeight: 1.6, marginBottom: '14px' }}>
          After joining, send PKR to the seller off-chain. USDT releases automatically when seller confirms receipt.
        </div>

        {/* Action */}
        {isJoining ? (
          <div style={{ color: '#a78bfa', fontSize: '0.85rem', textAlign: 'center', padding: '10px' }}>
            Joining… approve in wallet
          </div>
        ) : isOwn ? (
          <button disabled className="btn-outline-defi" style={{ width: '100%', padding: '11px', opacity: 0.4 }}>
            Your own trade
          </button>
        ) : (
          <button
            onClick={() => handleJoin(t)}
            disabled={!canJoin}
            className={canJoin ? 'btn-gradient' : 'btn-outline-defi'}
            style={{ width: '100%', padding: '11px', fontSize: '0.9rem' }}
          >
            {publicKey ? 'Join Trade' : 'Connect wallet to join'}
          </button>
        )}
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Shell>
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '16px 24px', flexShrink: 0, zIndex: 2, position: 'relative',
        borderBottom: '1px solid var(--defi-border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <Link href="/" style={{ color: '#475569', fontSize: '0.85rem', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '4px' }}>
            ← Back
          </Link>
          <span style={{ color: '#475569' }}>|</span>
          <span style={{ color: '#fff', fontWeight: 600, fontSize: '0.9rem' }}>Buy USDT</span>
        </div>
        <WalletButton />
      </div>

      {/* Body */}
      <div className="defi-body" style={{ padding: '24px' }}>
        <div style={{ maxWidth: '560px', margin: '0 auto', width: '100%' }}>

          {/* Market rate + subtitle */}
          <div style={{ marginBottom: '24px' }}>
            <p style={{ color: '#64748b', fontSize: '0.82rem', margin: '0 0 10px' }}>
              Pick a trade · send PKR off-chain · receive USDT on-chain
            </p>
            {marketRate && (
              <div className="glass-card-sm" style={{
                padding: '10px 16px', display: 'flex',
                justifyContent: 'space-between', alignItems: 'center',
              }}>
                <span style={{ color: '#64748b', fontSize: '0.78rem' }}>Live market rate</span>
                <span style={{ color: '#10b981', fontSize: '0.85rem', fontWeight: 600 }}>
                  ~{marketRate.toLocaleString()} PKR / USDT
                </span>
              </div>
            )}
          </div>

          {/* Error */}
          {errorMsg && (
            <div className="defi-alert-error" style={{ marginBottom: '16px' }}>
              {errorMsg}
              <button
                onClick={() => setErrorMsg('')}
                style={{ display: 'block', marginTop: '6px', color: '#ef4444', background: 'transparent', border: 'none', fontSize: '0.75rem', cursor: 'pointer', padding: 0 }}
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Count row + refresh */}
          {!loading && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <span style={{ color: '#334155', fontSize: '0.78rem' }}>
                {trades.length === 0 ? 'No open trades' : `${trades.length} open trade${trades.length !== 1 ? 's' : ''}`}
              </span>
              <button
                onClick={load}
                className="btn-outline-defi"
                style={{ padding: '5px 14px', fontSize: '0.78rem' }}
              >
                ↻ Refresh
              </button>
            </div>
          )}

          {/* States */}
          {loading ? (
            <div style={{ textAlign: 'center', padding: '48px 0', color: '#334155', fontSize: '0.9rem' }}>
              Loading trades…
            </div>
          ) : trades.length === 0 ? (
            <div className="glass-card-sm" style={{ padding: '40px 24px', textAlign: 'center' }}>
              <div style={{ fontSize: '2rem', marginBottom: '12px' }}>📭</div>
              <div style={{ color: '#94a3b8', fontSize: '0.9rem', marginBottom: '8px' }}>No open trades right now</div>
              <Link href="/sell" style={{ color: '#a78bfa', fontSize: '0.82rem', textDecoration: 'none' }}>
                Be the first — create a sell trade →
              </Link>
            </div>
          ) : (
            trades.map(t => <TradeCard key={t.pda} t={t} />)
          )}
        </div>
      </div>
    </Shell>
  )
}
