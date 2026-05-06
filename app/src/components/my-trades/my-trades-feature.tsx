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

const GREEN     = '#00cc33'
const GREEN_DIM = '#006622'
const RED       = '#cc3300'
const YELLOW    = '#ccaa00'
const MONO      = "'Courier New', monospace"

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
  amount: bigint    // micro USDT
  rate: bigint      // PKR per USDT
  createdAt: number // unix seconds
  joinedAt: number  // unix seconds (0 if not joined)
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

  trades.sort((a, b) => Number(b.tradeId - a.tradeId)) // newest first
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

// ── Shell ─────────────────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="terminal-page fixed inset-0 z-50 flex flex-col overflow-auto"
      style={{ background: '#000', fontFamily: MONO }}>
      {children}
      <div className="shrink-0 px-4 py-2 border-t"
        style={{ color: GREEN_DIM, borderColor: '#0d260d', fontSize: '0.7rem', letterSpacing: '0.03em' }}>
        {'>'} safe p2p escrow&nbsp;&nbsp;|&nbsp;&nbsp;devnet&nbsp;&nbsp;|&nbsp;&nbsp;my trades
      </div>
    </div>
  )
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: TradeStatus }) {
  const color = {
    Open:      GREEN,
    Active:    YELLOW,
    Disputed:  RED,
    Completed: GREEN_DIM,
    Cancelled: GREEN_DIM,
  }[status]
  return (
    <span style={{ color, fontSize: '0.72rem', letterSpacing: '0.1em', border: `1px solid ${color}`, padding: '1px 6px' }}>
      {status.toUpperCase()}
    </span>
  )
}

// ── Action button ─────────────────────────────────────────────────────────────

function ActionBtn({
  label, onClick, danger = false, disabled = false,
}: { label: string; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  const color = disabled ? GREEN_DIM : danger ? RED : GREEN
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={disabled ? '' : 'terminal-menu-btn'}
      style={{
        border: `1px solid ${color}`,
        color,
        background: 'transparent',
        fontFamily: MONO,
        fontSize: '0.72rem',
        letterSpacing: '0.08em',
        padding: '5px 12px',
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {label}
    </button>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function MyTradesFeature() {
  const { connection }                 = useConnection()
  const { publicKey, sendTransaction } = useWallet()

  const [trades, setTrades]       = useState<TradeData[]>([])
  const [loading, setLoading]     = useState(false)
  const [actingOn, setActingOn]   = useState<string | null>(null)
  const [errorMsg, setErrorMsg]   = useState('')
  const [successMsg, setSuccessMsg] = useState('')
  const [txSig, setTxSig]         = useState('')
  const [, setTick]               = useState(0)

  // Re-render every 10s to update countdowns
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

  // ── Action: Confirm Payment
  async function handleConfirm(t: TradeData) {
    if (!publicKey) return
    setActingOn(t.pda)
    setErrorMsg('')
    try {
      const [tradeAccount] = tradePDA(t.tradeId)
      const [vault]        = vaultPDA(t.tradeId)
      const usdtMint       = new PublicKey(USDT_MINT)
      const buyerPk        = new PublicKey(t.buyer)
      const buyerAta       = getAssociatedTokenAddressSync(usdtMint, buyerPk)

      // Ensure buyer ATA exists — prepend create if needed
      const tx = new Transaction()
      const buyerAtaInfo = await connection.getAccountInfo(buyerAta)
      if (!buyerAtaInfo) {
        tx.add(createAssociatedTokenAccountInstruction(publicKey, buyerAta, buyerPk, usdtMint))
      }

      tx.add(buildConfirmPaymentIx(t.tradeId, tradeAccount, vault, publicKey, buyerAta))
      const sig = await sendTransaction(tx, connection)
      await connection.confirmTransaction(sig, 'confirmed')
      setTxSig(sig)
      setSuccessMsg('PAYMENT CONFIRMED — USDT RELEASED TO BUYER')
      await load()
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e)
      setErrorMsg(raw.length > 200 ? raw.slice(0, 200) + '…' : raw)
    } finally {
      setActingOn(null)
    }
  }

  // ── Action: Cancel Trade
  async function handleCancel(t: TradeData) {
    if (!publicKey) return
    setActingOn(t.pda)
    setErrorMsg('')
    try {
      const [escrowState]  = escrowStatePDA()
      const [tradeAccount] = tradePDA(t.tradeId)
      const [vault]        = vaultPDA(t.tradeId)
      const usdtMint       = new PublicKey(USDT_MINT)
      const sellerPk       = new PublicKey(t.seller)
      const sellerAta      = getAssociatedTokenAddressSync(usdtMint, sellerPk)
      const adminAta       = getAssociatedTokenAddressSync(usdtMint, ADMIN_PUBKEY)

      const tx = new Transaction()
      // Ensure admin ATA exists (needed even if admin receives 0 in open-cancel)
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
      setSuccessMsg('TRADE CANCELLED — USDT RETURNED TO SELLER')
      await load()
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e)
      setErrorMsg(raw.length > 200 ? raw.slice(0, 200) + '…' : raw)
    } finally {
      setActingOn(null)
    }
  }

  // ── Action: Raise Dispute
  async function handleRaiseDispute(t: TradeData) {
    if (!publicKey) return
    setActingOn(t.pda)
    setErrorMsg('')
    try {
      const [escrowState]   = escrowStatePDA()
      const [tradeAccount]  = tradePDA(t.tradeId)
      const disputeCounter  = await fetchDisputeCounter(connection)
      const [disputeAccount] = disputePDA(disputeCounter)

      const tx  = new Transaction()
      tx.add(buildRaiseDisputeIx(t.tradeId, escrowState, tradeAccount, disputeAccount, publicKey))
      const sig = await sendTransaction(tx, connection)
      await connection.confirmTransaction(sig, 'confirmed')
      setTxSig(sig)
      setSuccessMsg('DISPUTE RAISED — ARBITRATORS WILL VOTE')
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
    const role       = isSeller ? 'SELLER' : isBuyer ? 'BUYER' : '—'
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
      <div style={{
        border: `1px solid ${GREEN_DIM}`,
        padding: '14px 16px',
        marginBottom: '12px',
        opacity: isActing ? 0.6 : 1,
      }}>
        {/* Top row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <Link href={`/trade/${t.tradeId.toString()}`} style={{ textDecoration: 'none' }}>
            <span
              className="terminal-menu-btn"
              style={{
                color: '#00ff41', fontSize: '0.75rem', letterSpacing: '0.08em',
                border: '1px solid #006622', padding: '3px 8px', display: 'inline-block',
              }}
            >
              [ #{t.tradeId.toString().padStart(7, '0')} → ]
            </span>
          </Link>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <span style={{ color: GREEN_DIM, fontSize: '0.68rem', letterSpacing: '0.1em' }}>{role}</span>
            <StatusBadge status={t.status} />
          </div>
        </div>

        {/* Details */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.78rem', letterSpacing: '0.03em' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: GREEN }}>
            <span>AMOUNT</span>
            <span>{amountUsdt} USDT</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: GREEN }}>
            <span>RATE</span>
            <span>{t.rate.toString()} PKR/USDT</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: GREEN_DIM }}>
            <span>BUYER PAYS</span>
            <span>{buyerPkr} PKR</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: GREEN_DIM, marginTop: '4px' }}>
            <span>CREATED</span>
            <span>{timeAgo(t.createdAt)}</span>
          </div>
          {t.joinedAt > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', color: GREEN_DIM }}>
              <span>JOINED</span>
              <span>{timeAgo(t.joinedAt)}</span>
            </div>
          )}
          {t.buyer !== NULL_PUBKEY && t.status !== 'Open' && (
            <div style={{ display: 'flex', justifyContent: 'space-between', color: GREEN_DIM }}>
              <span>BUYER</span>
              <span style={{ fontSize: '0.65rem' }}>
                {t.buyer.slice(0, 6)}…{t.buyer.slice(-6)}
              </span>
            </div>
          )}
        </div>

        {/* Actions */}
        {isActing ? (
          <div style={{ marginTop: '12px', color: YELLOW, fontSize: '0.75rem', letterSpacing: '0.05em' }}>
            {'>'} processing…<span className="terminal-cursor"> _</span>
          </div>
        ) : (
          <div style={{ marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {/* Confirm Payment — seller only, active */}
            {t.status === 'Active' && isSeller && (
              <ActionBtn label="[ CONFIRM PAYMENT ]" onClick={() => handleConfirm(t)} />
            )}

            {/* Cancel */}
            {canCancel && (
              <ActionBtn label="[ CANCEL ]" onClick={() => handleCancel(t)} danger />
            )}

            {/* Cancel countdown for active trades */}
            {t.status === 'Active' && !canCancelActive(t.joinedAt) && countdown && (isSeller || isBuyer) && (
              <span style={{ color: GREEN_DIM, fontSize: '0.68rem', letterSpacing: '0.05em', alignSelf: 'center' }}>
                cancel in {countdown}
              </span>
            )}

            {/* Raise Dispute — buyer only, active */}
            {t.status === 'Active' && isBuyer && (
              <ActionBtn label="[ RAISE DISPUTE ]" onClick={() => handleRaiseDispute(t)} danger />
            )}
          </div>
        )}
      </div>
    )
  }

  // ── Render
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
      <div className="flex-1 px-4 pb-8" style={{ maxWidth: '560px', margin: '0 auto', width: '100%' }}>
        {/* Title */}
        <div style={{ marginBottom: '20px' }}>
          <div style={{ color: GREEN, fontSize: 'clamp(1rem, 3vw, 1.2rem)', letterSpacing: '0.15em' }}>
            {'>'} MY TRADES
          </div>
          <div style={{ color: GREEN_DIM, fontSize: '0.72rem', letterSpacing: '0.05em', marginTop: '4px' }}>
            trades where you are seller or buyer
          </div>
        </div>

        {/* Wallet guard */}
        {!publicKey ? (
          <div style={{ border: `1px solid ${GREEN_DIM}`, padding: '14px 16px', color: GREEN_DIM, fontSize: '0.8rem', letterSpacing: '0.05em' }}>
            {'>'} CONNECT WALLET TO SEE YOUR TRADES<span className="terminal-cursor"> _</span>
          </div>
        ) : loading ? (
          <div style={{ color: GREEN, fontSize: '0.85rem', letterSpacing: '0.06em' }}>
            {'>'} FETCHING TRADES<span className="terminal-cursor"> _</span>
          </div>
        ) : trades.length === 0 ? (
          <div style={{ color: GREEN_DIM, fontSize: '0.8rem', letterSpacing: '0.05em', border: `1px solid ${GREEN_DIM}`, padding: '16px' }}>
            {'>'} NO TRADES FOUND<br />
            <span style={{ fontSize: '0.68rem' }}>
              go to <Link href="/sell" style={{ color: GREEN, textDecoration: 'underline' }}>SELL</Link> to create your first trade
            </span>
          </div>
        ) : (
          <>
            {/* Count + refresh */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <span style={{ color: GREEN_DIM, fontSize: '0.72rem', letterSpacing: '0.05em' }}>
                {trades.length} trade{trades.length !== 1 ? 's' : ''} found
              </span>
              <button
                onClick={load}
                className="terminal-menu-btn"
                style={{ border: `1px solid ${GREEN_DIM}`, color: GREEN_DIM, background: 'transparent', fontFamily: MONO, fontSize: '0.68rem', letterSpacing: '0.08em', padding: '3px 10px' }}
              >
                [ REFRESH ]
              </button>
            </div>

            {/* Success */}
            {successMsg && (
              <div style={{ border: `1px solid ${GREEN}`, padding: '10px 12px', color: GREEN, fontSize: '0.75rem', marginBottom: '12px', letterSpacing: '0.02em' }}>
                {'>'} {successMsg}
                {txSig && (
                  <a
                    href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`}
                    target="_blank" rel="noopener noreferrer"
                    style={{ display: 'block', marginTop: '6px', color: GREEN_DIM, fontSize: '0.65rem', textDecoration: 'underline' }}
                  >
                    {'>'} view on Solana Explorer ↗
                  </a>
                )}
              </div>
            )}

            {/* Error */}
            {errorMsg && (
              <div style={{ border: `1px solid ${RED}`, padding: '10px 12px', color: RED, fontSize: '0.75rem', marginBottom: '12px', wordBreak: 'break-word', letterSpacing: '0.02em' }}>
                {errorMsg}
              </div>
            )}

            {/* Trade cards */}
            {trades.map(t => <TradeCard key={t.pda} t={t} />)}
          </>
        )}
      </div>
    </Shell>
  )
}
