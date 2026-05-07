'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Connection,
  PublicKey,
  SystemProgram,
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

const ADMIN_PUBKEY = new PublicKey('8k31uKgoxe8Kg1dgeXLevAaj1X7ck6Y26rbXosiXBGGE')
const NULL_PUBKEY  = '11111111111111111111111111111111'
const TRADE_DISC   = [46, 97, 187, 111, 38, 69, 11, 236]

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

type TradeStatus = 'Open' | 'Active' | 'Disputed' | 'Completed' | 'Cancelled'

interface TradeData {
  pda: string
  tradeId: bigint
  seller: string
  buyer: string
  amount: bigint
  rate: bigint
  createdAt: number
  joinedAt: number
  status: TradeStatus
}

// ── PDA helpers ───────────────────────────────────────────────────────────────

function escrowStatePDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('escrow')], SAFE_P2P_ESCROW_PROGRAM_ID)
}

function tradePDA(tradeId: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('trade'), u64LE(tradeId)], SAFE_P2P_ESCROW_PROGRAM_ID,
  )
}

function vaultPDA(tradeId: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), u64LE(tradeId)], SAFE_P2P_ESCROW_PROGRAM_ID,
  )
}

function disputePDA(disputeId: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('dispute'), u64LE(disputeId)], SAFE_P2P_ESCROW_PROGRAM_ID,
  )
}

// ── Data fetching ─────────────────────────────────────────────────────────────

const STATUS_MAP: TradeStatus[] = ['Open', 'Active', 'Disputed', 'Completed', 'Cancelled']

function decodeTradeAccount(pda: string, data: Buffer): TradeData | null {
  if (data.length < 115) return null
  for (let i = 0; i < 8; i++) if (data[i] !== TRADE_DISC[i]) return null

  return {
    pda,
    tradeId:   readU64LE(data, 8),
    seller:    new PublicKey(data.slice(16, 48)).toBase58(),
    buyer:     new PublicKey(data.slice(48, 80)).toBase58(),
    amount:    readU64LE(data, 80),
    rate:      readU64LE(data, 88),
    createdAt: Number(readU64LE(data, 96)),
    joinedAt:  Number(readU64LE(data, 104)),
    status:    STATUS_MAP[data[112]] ?? 'Open',
  }
}

async function fetchMyTrades(connection: Connection, wallet: string): Promise<TradeData[]> {
  const accounts = await connection.getProgramAccounts(SAFE_P2P_ESCROW_PROGRAM_ID, {
    filters: [{ dataSize: 115 }],
  })

  const trades: TradeData[] = []
  for (const { pubkey, account } of accounts) {
    const t = decodeTradeAccount(pubkey.toBase58(), account.data as Buffer)
    if (!t) continue
    if (t.seller === wallet || (t.buyer !== NULL_PUBKEY && t.buyer === wallet)) {
      trades.push(t)
    }
  }

  trades.sort((a, b) => Number(b.tradeId - a.tradeId))
  return trades
}

async function fetchDisputeCounter(connection: Connection): Promise<bigint> {
  const [pda] = escrowStatePDA()
  const info  = await connection.getAccountInfo(pda)
  if (!info) throw new Error('Escrow not initialized')
  return readU64LE(info.data, 48)
}

// ── Instruction builders ──────────────────────────────────────────────────────

function buildConfirmPaymentIx(
  tradeId: bigint,
  tradeAccount: PublicKey,
  vault: PublicKey,
  seller: PublicKey,
  buyerTokenAccount: PublicKey,
): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from([221, 23, 112, 126, 29, 23, 159, 223]),
    u64LE(tradeId),
  ])
  return new TransactionInstruction({
    programId: SAFE_P2P_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: tradeAccount,      isSigner: false, isWritable: true  },
      { pubkey: vault,             isSigner: false, isWritable: true  },
      { pubkey: seller,            isSigner: true,  isWritable: false },
      { pubkey: buyerTokenAccount, isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,  isSigner: false, isWritable: false },
    ],
    data,
  })
}

function buildCancelTradeIx(
  tradeId: bigint,
  escrowState: PublicKey,
  tradeAccount: PublicKey,
  vault: PublicKey,
  authority: PublicKey,
  sellerTokenAccount: PublicKey,
  adminTokenAccount: PublicKey,
): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from([124, 66, 91, 59, 175, 107, 208, 120]),
    u64LE(tradeId),
  ])
  return new TransactionInstruction({
    programId: SAFE_P2P_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: escrowState,        isSigner: false, isWritable: true  },
      { pubkey: tradeAccount,       isSigner: false, isWritable: true  },
      { pubkey: vault,              isSigner: false, isWritable: true  },
      { pubkey: authority,          isSigner: true,  isWritable: false },
      { pubkey: sellerTokenAccount, isSigner: false, isWritable: true  },
      { pubkey: adminTokenAccount,  isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,   isSigner: false, isWritable: false },
    ],
    data,
  })
}

function buildRaiseDisputeIx(
  tradeId: bigint,
  escrowState: PublicKey,
  tradeAccount: PublicKey,
  disputeAccount: PublicKey,
  buyer: PublicKey,
): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from([41, 243, 1, 51, 150, 95, 246, 73]),
    u64LE(tradeId),
  ])
  return new TransactionInstruction({
    programId: SAFE_P2P_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: escrowState,    isSigner: false, isWritable: true  },
      { pubkey: tradeAccount,   isSigner: false, isWritable: true  },
      { pubkey: disputeAccount, isSigner: false, isWritable: true  },
      { pubkey: buyer,          isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
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
  if (diff < 60)   return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function canCancelActive(joinedAt: number): boolean {
  return joinedAt > 0 && Date.now() / 1000 - joinedAt >= 30 * 60
}

function cancelCountdown(joinedAt: number): string {
  if (joinedAt === 0) return ''
  const remaining = 30 * 60 - (Date.now() / 1000 - joinedAt)
  if (remaining <= 0) return ''
  const m = Math.floor(remaining / 60)
  const s = Math.floor(remaining % 60)
  return `${m}m ${s}s`
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: TradeStatus }) {
  const styles: Record<TradeStatus, React.CSSProperties> = {
    Open:      { background: 'rgba(16,185,129,0.12)', color: '#10b981', border: '1px solid rgba(16,185,129,0.25)' },
    Active:    { background: 'rgba(245,158,11,0.12)',  color: '#f59e0b', border: '1px solid rgba(245,158,11,0.25)' },
    Disputed:  { background: 'rgba(239,68,68,0.12)',   color: '#ef4444', border: '1px solid rgba(239,68,68,0.25)' },
    Completed: { background: 'rgba(96,165,250,0.12)',  color: '#60a5fa', border: '1px solid rgba(96,165,250,0.25)' },
    Cancelled: { background: 'rgba(100,116,139,0.12)', color: '#64748b', border: '1px solid rgba(100,116,139,0.2)' },
  }
  return (
    <span style={{
      ...styles[status],
      fontSize: '0.68rem', fontWeight: 600, letterSpacing: '0.06em',
      padding: '2px 8px', borderRadius: 6,
    }}>
      {status.toUpperCase()}
    </span>
  )
}

// ── Role badge ────────────────────────────────────────────────────────────────

function RoleBadge({ role }: { role: 'SELLER' | 'BUYER' }) {
  return (
    <span style={{
      fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.08em',
      padding: '2px 8px', borderRadius: 6,
      background: role === 'SELLER' ? 'rgba(124,58,237,0.15)' : 'rgba(16,185,129,0.1)',
      color:      role === 'SELLER' ? '#a78bfa'               : '#34d399',
      border:     role === 'SELLER' ? '1px solid rgba(124,58,237,0.3)' : '1px solid rgba(16,185,129,0.25)',
    }}>
      {role}
    </span>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function MyTradesFeature() {
  const { connection }                 = useConnection()
  const { publicKey, sendTransaction } = useWallet()

  const [trades, setTrades]         = useState<TradeData[]>([])
  const [loading, setLoading]       = useState(false)
  const [actingOn, setActingOn]     = useState<string | null>(null)
  const [errorMsg, setErrorMsg]     = useState('')
  const [successMsg, setSuccessMsg] = useState('')
  const [txSig, setTxSig]           = useState('')
  const [, setTick]                 = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 10_000)
    return () => clearInterval(id)
  }, [])

  const load = useCallback(async () => {
    if (!publicKey) return
    setLoading(true)
    setErrorMsg('')
    try {
      const result = await fetchMyTrades(connection, publicKey.toBase58())
      setTrades(result)
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [connection, publicKey])

  useEffect(() => { load() }, [load])

  async function handleConfirm(t: TradeData) {
    if (!publicKey) return
    setActingOn(t.pda)
    setErrorMsg('')
    setSuccessMsg('')
    try {
      const [tradeAccount] = tradePDA(t.tradeId)
      const [vault]        = vaultPDA(t.tradeId)
      const usdtMint       = new PublicKey(USDT_MINT)
      const buyerPk        = new PublicKey(t.buyer)
      const buyerAta       = getAssociatedTokenAddressSync(usdtMint, buyerPk)

      const tx = new Transaction()
      const buyerAtaInfo = await connection.getAccountInfo(buyerAta)
      if (!buyerAtaInfo) {
        tx.add(createAssociatedTokenAccountInstruction(publicKey, buyerAta, buyerPk, usdtMint))
      }
      tx.add(buildConfirmPaymentIx(t.tradeId, tradeAccount, vault, publicKey, buyerAta))
      const sig = await sendTransaction(tx, connection)
      await connection.confirmTransaction(sig, 'confirmed')
      setTxSig(sig)
      setSuccessMsg('Payment confirmed — USDT released to buyer')
      await load()
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e)
      setErrorMsg(raw.length > 200 ? raw.slice(0, 200) + '…' : raw)
    } finally {
      setActingOn(null)
    }
  }

  async function handleCancel(t: TradeData) {
    if (!publicKey) return
    setActingOn(t.pda)
    setErrorMsg('')
    setSuccessMsg('')
    try {
      const [escrowState]  = escrowStatePDA()
      const [tradeAccount] = tradePDA(t.tradeId)
      const [vault]        = vaultPDA(t.tradeId)
      const usdtMint       = new PublicKey(USDT_MINT)
      const sellerPk       = new PublicKey(t.seller)
      const sellerAta      = getAssociatedTokenAddressSync(usdtMint, sellerPk)
      const adminAta       = getAssociatedTokenAddressSync(usdtMint, ADMIN_PUBKEY)

      const tx = new Transaction()
      const adminAtaInfo = await connection.getAccountInfo(adminAta)
      if (!adminAtaInfo) {
        tx.add(createAssociatedTokenAccountInstruction(publicKey, adminAta, ADMIN_PUBKEY, usdtMint))
      }
      tx.add(buildCancelTradeIx(
        t.tradeId, escrowState, tradeAccount, vault,
        publicKey, sellerAta, adminAta,
      ))
      const sig = await sendTransaction(tx, connection)
      await connection.confirmTransaction(sig, 'confirmed')
      setTxSig(sig)
      setSuccessMsg('Trade cancelled — USDT returned to seller')
      await load()
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e)
      setErrorMsg(raw.length > 200 ? raw.slice(0, 200) + '…' : raw)
    } finally {
      setActingOn(null)
    }
  }

  async function handleRaiseDispute(t: TradeData) {
    if (!publicKey) return
    setActingOn(t.pda)
    setErrorMsg('')
    setSuccessMsg('')
    try {
      const [escrowState]    = escrowStatePDA()
      const [tradeAccount]   = tradePDA(t.tradeId)
      const disputeCounter   = await fetchDisputeCounter(connection)
      const [disputeAccount] = disputePDA(disputeCounter)

      const tx = new Transaction()
      tx.add(buildRaiseDisputeIx(t.tradeId, escrowState, tradeAccount, disputeAccount, publicKey))
      const sig = await sendTransaction(tx, connection)
      await connection.confirmTransaction(sig, 'confirmed')
      setTxSig(sig)
      setSuccessMsg('Dispute raised — arbitrators will vote')
      await load()
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e)
      setErrorMsg(raw.length > 200 ? raw.slice(0, 200) + '…' : raw)
    } finally {
      setActingOn(null)
    }
  }

  // ── Trade card
  function TradeCard({ t }: { t: TradeData }) {
    const wallet     = publicKey?.toBase58() ?? ''
    const isSeller   = t.seller === wallet
    const isBuyer    = t.buyer  === wallet
    const role       = isSeller ? 'SELLER' : 'BUYER'
    const amountUsdt = formatUsdt(t.amount)
    const buyerPkr   = (Number(t.amount) / 10 ** USDT_DECIMALS * Number(t.rate)).toLocaleString()
    const isActing   = actingOn === t.pda

    const canCancel =
      (t.status === 'Open' && isSeller) ||
      (t.status === 'Active' && (isSeller || isBuyer) && canCancelActive(t.joinedAt))

    const countdown = t.status === 'Active' && !canCancelActive(t.joinedAt)
      ? cancelCountdown(t.joinedAt)
      : ''

    return (
      <div className="glass-card-sm" style={{
        padding: '16px', marginBottom: '12px',
        opacity: isActing ? 0.6 : 1,
        transition: 'opacity 0.2s',
      }}>
        {/* Top row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              fontSize: '0.72rem', fontFamily: 'monospace', color: '#64748b',
            }}>
              #{String(t.tradeId).padStart(5, '0')}
            </span>
            <RoleBadge role={role as 'SELLER' | 'BUYER'} />
          </div>
          <StatusBadge status={t.status} />
        </div>

        {/* Amount */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: '1.6rem', fontWeight: 700, color: '#fff', lineHeight: 1 }}>
            {amountUsdt} <span style={{ fontSize: '0.85rem', color: '#64748b', fontWeight: 500 }}>USDT</span>
          </div>
          <div style={{ fontSize: '0.78rem', color: '#475569', marginTop: 3 }}>
            ≈ {buyerPkr} PKR
          </div>
        </div>

        {/* Details */}
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 10, marginBottom: 12 }}>
          <div className="defi-row">
            <span style={{ color: '#64748b' }}>Rate</span>
            <span style={{ color: '#cbd5e1' }}>{t.rate.toString()} PKR/USDT</span>
          </div>
          <div className="defi-row">
            <span style={{ color: '#64748b' }}>Created</span>
            <span style={{ color: '#94a3b8' }}>{timeAgo(t.createdAt)}</span>
          </div>
          {t.joinedAt > 0 && (
            <div className="defi-row">
              <span style={{ color: '#64748b' }}>Joined</span>
              <span style={{ color: '#94a3b8' }}>{timeAgo(t.joinedAt)}</span>
            </div>
          )}
          {t.buyer !== NULL_PUBKEY && t.status !== 'Open' && (
            <div className="defi-row">
              <span style={{ color: '#64748b' }}>Buyer</span>
              <span style={{ color: '#94a3b8', fontFamily: 'monospace', fontSize: '0.75rem' }}>
                {t.buyer.slice(0, 6)}…{t.buyer.slice(-6)}
              </span>
            </div>
          )}
        </div>

        {/* Actions */}
        {isActing ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#f59e0b', fontSize: '0.82rem' }}>
            <span style={{
              width: 14, height: 14, borderRadius: '50%',
              border: '2px solid rgba(245,158,11,0.3)', borderTopColor: '#f59e0b',
              display: 'inline-block', animation: 'spin 0.8s linear infinite',
            }} />
            Processing…
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {t.status === 'Active' && isSeller && (
              <button
                className="btn-gradient"
                onClick={() => handleConfirm(t)}
                style={{ fontSize: '0.8rem', padding: '7px 14px', border: 'none', cursor: 'pointer' }}
              >
                Confirm Payment
              </button>
            )}

            {canCancel && (
              <button
                onClick={() => handleCancel(t)}
                style={{
                  fontSize: '0.8rem', padding: '6px 14px', borderRadius: 8, cursor: 'pointer',
                  background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
                  color: '#ef4444', fontWeight: 600,
                }}
              >
                Cancel
              </button>
            )}

            {t.status === 'Active' && !canCancelActive(t.joinedAt) && countdown && (isSeller || isBuyer) && (
              <span style={{ fontSize: '0.72rem', color: '#475569' }}>
                cancel unlocks in {countdown}
              </span>
            )}

            {t.status === 'Active' && isBuyer && (
              <button
                onClick={() => handleRaiseDispute(t)}
                style={{
                  fontSize: '0.8rem', padding: '6px 14px', borderRadius: 8, cursor: 'pointer',
                  background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)',
                  color: '#f87171', fontWeight: 600,
                }}
              >
                Raise Dispute
              </button>
            )}
          </div>
        )}

        {/* View details */}
        <Link href={`/trade/${t.tradeId.toString()}`} style={{ textDecoration: 'none', display: 'block', marginTop: 14 }}>
          <button style={{
            width: '100%', padding: '9px',
            background: 'rgba(139,92,246,0.08)',
            border: '1px solid rgba(139,92,246,0.25)',
            borderRadius: 9, cursor: 'pointer',
            color: '#a78bfa', fontSize: '0.82rem', fontWeight: 600,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}>
            View Full Trade Details
            <span style={{ fontSize: '0.9rem' }}>→</span>
          </button>
        </Link>
      </div>
    )
  }

  // ── Render
  return (
    <div className="defi-page">

      {/* Top bar */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '16px 24px', flexShrink: 0, zIndex: 2,
        borderBottom: '1px solid rgba(255,255,255,0.05)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link href="/" style={{
            color: '#475569', fontSize: '0.82rem', textDecoration: 'none',
            display: 'flex', alignItems: 'center', gap: 4,
          }}>
            ← Back
          </Link>
          <span style={{ color: 'rgba(255,255,255,0.1)', fontSize: '0.9rem' }}>|</span>
          <span style={{ color: '#fff', fontWeight: 600, fontSize: '0.88rem' }}>My Trades</span>
        </div>
        <WalletButton />
      </div>

      {/* Body */}
      <div className="defi-body">
        <div style={{ maxWidth: 560, margin: '0 auto', padding: '28px 20px 60px', width: '100%' }}>

          {/* Wallet guard */}
          {!publicKey ? (
            <div className="glass-card" style={{ padding: '32px', textAlign: 'center' }}>
              <div style={{ fontSize: '2rem', marginBottom: 12 }}>🔗</div>
              <div style={{ color: '#94a3b8', fontSize: '0.9rem' }}>
                Connect your wallet to see your trades
              </div>
            </div>
          ) : loading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#64748b', padding: '32px 0' }}>
              <span style={{
                width: 16, height: 16, borderRadius: '50%',
                border: '2px solid rgba(168,85,247,0.3)', borderTopColor: '#a855f7',
                display: 'inline-block', animation: 'spin 0.8s linear infinite',
              }} />
              Fetching trades…
            </div>
          ) : trades.length === 0 ? (
            <div className="glass-card" style={{ padding: '40px', textAlign: 'center' }}>
              <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>📭</div>
              <div style={{ color: '#94a3b8', fontSize: '0.9rem', marginBottom: 16 }}>No trades yet</div>
              <Link href="/sell" style={{ textDecoration: 'none' }}>
                <button className="btn-gradient" style={{
                  fontSize: '0.85rem', padding: '9px 20px', border: 'none', cursor: 'pointer',
                }}>
                  Create a Trade
                </button>
              </Link>
            </div>
          ) : (
            <>
              {/* Count + refresh */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <span style={{ color: '#475569', fontSize: '0.8rem' }}>
                  {trades.length} trade{trades.length !== 1 ? 's' : ''}
                </span>
                <button
                  onClick={load}
                  style={{
                    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
                    color: '#64748b', fontSize: '0.75rem', padding: '5px 12px',
                    borderRadius: 8, cursor: 'pointer',
                  }}
                >
                  Refresh ↻
                </button>
              </div>

              {/* Success */}
              {successMsg && (
                <div className="defi-alert-success" style={{ padding: '12px 16px', marginBottom: 14 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>✓ {successMsg}</div>
                  {txSig && (
                    <a
                      href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`}
                      target="_blank" rel="noopener noreferrer"
                      style={{ display: 'block', marginTop: 6, fontSize: '0.72rem', color: '#34d399', textDecoration: 'underline' }}
                    >
                      View on Solana Explorer ↗
                    </a>
                  )}
                </div>
              )}

              {/* Error */}
              {errorMsg && (
                <div className="defi-alert-error" style={{ padding: '12px 16px', marginBottom: 14 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: 4 }}>⚠ Transaction failed</div>
                  <div style={{ fontSize: '0.75rem', wordBreak: 'break-word', opacity: 0.85 }}>{errorMsg}</div>
                </div>
              )}

              {/* Trade cards */}
              {trades.map(t => <TradeCard key={t.pda} t={t} />)}
            </>
          )}
        </div>
      </div>

      {/* Status bar */}
      <div style={{
        flexShrink: 0, padding: '9px 24px',
        borderTop: '1px solid rgba(255,255,255,0.05)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ color: '#475569', fontSize: '0.68rem', fontFamily: 'monospace' }}>SafeP2P</span>
        <span style={{ color: '#475569', fontSize: '0.68rem' }}>devnet · my trades</span>
      </div>
    </div>
  )
}
