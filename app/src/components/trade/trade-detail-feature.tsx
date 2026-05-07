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

interface ClaimRow {
  side:         string
  claim_text:   string
  evidence_url: string | null
  updated_at:   string
}

interface DisputeClaims {
  buyer:  ClaimRow | null
  seller: ClaimRow | null
}

interface DisputeProgress {
  disputeId:      bigint
  raisedBy:       string
  votesForBuyer:  number
  votesForSeller: number
  isResolved:     boolean
  raisedAt:       number
  votedCount:     number
}

interface TradeData {
  tradeId:      bigint
  seller:       string
  buyer:        string
  amount:       bigint
  rate:         bigint
  createdAt:    number
  joinedAt:     number
  status:       TradeStatus
  vaultLocked?: bigint
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
function arbVaultPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('arb_vault')], SAFE_P2P_ESCROW_PROGRAM_ID)
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

const STATUS_MAP: TradeStatus[] = ['Open', 'Active', 'Disputed', 'Completed', 'Cancelled']

async function fetchTrade(connection: Connection, tradeId: bigint): Promise<TradeData> {
  const [pda] = tradePDA(tradeId)
  const info  = await connection.getAccountInfo(pda)
  if (!info) throw new Error(`Trade #${tradeId} not found`)

  const d = info.data as Buffer
  for (let i = 0; i < 8; i++) {
    if (d[i] !== TRADE_DISC[i]) throw new Error('Invalid account data')
  }

  const trade: TradeData = {
    tradeId,
    seller:    new PublicKey(d.slice(16, 48)).toBase58(),
    buyer:     new PublicKey(d.slice(48, 80)).toBase58(),
    amount:    readU64LE(d, 80),
    rate:      readU64LE(d, 88),
    createdAt: Number(readU64LE(d, 96)),
    joinedAt:  Number(readU64LE(d, 104)),
    status:    STATUS_MAP[d[112]] ?? 'Open',
  }

  try {
    const [vaultKey] = vaultPDA(tradeId)
    const vaultInfo  = await connection.getAccountInfo(vaultKey)
    if (vaultInfo && vaultInfo.data.length >= 72) {
      trade.vaultLocked = readU64LE(vaultInfo.data, 64)
    }
  } catch { /* non-critical */ }

  return trade
}

async function fetchDisputeCounter(connection: Connection): Promise<bigint> {
  const [pda] = escrowStatePDA()
  const info  = await connection.getAccountInfo(pda)
  if (!info) throw new Error('Escrow not initialized')
  return readU64LE(info.data, 48)
}

async function fetchDisputeForTrade(connection: Connection, tradeId: bigint): Promise<DisputeProgress | null> {
  const accounts = await connection.getProgramAccounts(SAFE_P2P_ESCROW_PROGRAM_ID, {
    filters: [{ dataSize: 164 }],
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const match = (accounts as any[]).find(({ account }: any) => readU64LE(account.data, 16) === tradeId)
  if (!match) return null

  const d: Buffer = match.account.data
  const voters = [
    new PublicKey(d.slice(67,  99)).toBase58(),
    new PublicKey(d.slice(99,  131)).toBase58(),
    new PublicKey(d.slice(131, 163)).toBase58(),
  ]
  return {
    disputeId:      readU64LE(d, 8),
    raisedBy:       new PublicKey(d.slice(24, 56)).toBase58(),
    votesForBuyer:  d[56],
    votesForSeller: d[57],
    isResolved:     d[58] !== 0,
    raisedAt:       Number(readU64LE(d, 59)),
    votedCount:     voters.filter(v => v !== NULL_PUBKEY).length,
  }
}

// ── Instruction builders ──────────────────────────────────────────────────────

function buildConfirmIx(
  tradeId: bigint, tradeAccount: PublicKey, vault: PublicKey,
  seller: PublicKey, buyerTokenAccount: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: SAFE_P2P_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: tradeAccount,      isSigner: false, isWritable: true  },
      { pubkey: vault,             isSigner: false, isWritable: true  },
      { pubkey: seller,            isSigner: true,  isWritable: false },
      { pubkey: buyerTokenAccount, isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,  isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([221, 23, 112, 126, 29, 23, 159, 223]), u64LE(tradeId)]),
  })
}

function buildCancelIx(
  tradeId: bigint, escrowState: PublicKey, tradeAccount: PublicKey,
  vault: PublicKey, authority: PublicKey,
  sellerTokenAccount: PublicKey, adminTokenAccount: PublicKey,
): TransactionInstruction {
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
    data: Buffer.concat([Buffer.from([124, 66, 91, 59, 175, 107, 208, 120]), u64LE(tradeId)]),
  })
}

function buildResolveIx(
  disputeId: bigint,
  escrowState: PublicKey, disputeAccount: PublicKey, tradeAccount: PublicKey,
  vault: PublicKey, buyerTokenAccount: PublicKey, sellerTokenAccount: PublicKey,
  arbitratorVault: PublicKey, caller: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: SAFE_P2P_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: escrowState,        isSigner: false, isWritable: true  },
      { pubkey: disputeAccount,     isSigner: false, isWritable: true  },
      { pubkey: tradeAccount,       isSigner: false, isWritable: true  },
      { pubkey: vault,              isSigner: false, isWritable: true  },
      { pubkey: buyerTokenAccount,  isSigner: false, isWritable: true  },
      { pubkey: sellerTokenAccount, isSigner: false, isWritable: true  },
      { pubkey: arbitratorVault,    isSigner: false, isWritable: true  },
      { pubkey: caller,             isSigner: true,  isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,   isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([231, 6, 202, 6, 96, 103, 12, 230]), u64LE(disputeId)]),
  })
}

function buildDisputeIx(
  tradeId: bigint, escrowState: PublicKey, tradeAccount: PublicKey,
  disputeAccount: PublicKey, buyer: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: SAFE_P2P_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: escrowState,    isSigner: false, isWritable: true  },
      { pubkey: tradeAccount,   isSigner: false, isWritable: true  },
      { pubkey: disputeAccount, isSigner: false, isWritable: true  },
      { pubkey: buyer,          isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([41, 243, 1, 51, 150, 95, 246, 73]), u64LE(tradeId)]),
  })
}

// ── Display helpers ───────────────────────────────────────────────────────────

function fmt(micro: bigint): string {
  return (Number(micro) / 10 ** USDT_DECIMALS).toFixed(6)
}

function timeAgo(unix: number): string {
  if (!unix) return '—'
  const d = Math.floor(Date.now() / 1000) - unix
  if (d < 60)    return `${d}s ago`
  if (d < 3600)  return `${Math.floor(d / 60)}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  return `${Math.floor(d / 86400)}d ago`
}

function cancelCountdown(joinedAt: number): string {
  const remaining = 30 * 60 - (Date.now() / 1000 - joinedAt)
  if (remaining <= 0) return ''
  return `${Math.floor(remaining / 60)}m ${Math.floor(remaining % 60)}s`
}

function canCancelActive(joinedAt: number) {
  return joinedAt > 0 && Date.now() / 1000 - joinedAt >= 30 * 60
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
      fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.06em',
      padding: '3px 10px', borderRadius: 6,
    }}>
      {status.toUpperCase()}
    </span>
  )
}

// ── Spinner ───────────────────────────────────────────────────────────────────

function Spinner({ color = '#a855f7' }: { color?: string }) {
  return (
    <span style={{
      width: 14, height: 14, borderRadius: '50%',
      border: `2px solid ${color}30`, borderTopColor: color,
      display: 'inline-block', animation: 'spin 0.8s linear infinite',
      flexShrink: 0,
    }} />
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function TradeDetailFeature({ tradeId: tradeIdStr }: { tradeId: string }) {
  const { connection }                 = useConnection()
  const { publicKey, sendTransaction } = useWallet()

  const [trade, setTrade]                     = useState<TradeData | null>(null)
  const [disputeProgress, setDisputeProgress] = useState<DisputeProgress | null>(null)
  const [payInfo, setPayInfo]                 = useState<{ method: string; account: string; name: string } | null>(null)
  const [loading, setLoading]                 = useState(true)
  const [acting, setActing]                   = useState<string | null>(null)
  const [errorMsg, setErrorMsg]               = useState('')
  const [successMsg, setSuccessMsg]           = useState('')
  const [txSig, setTxSig]                     = useState('')
  const [, setTick]                           = useState(0)

  // Dispute evidence claims
  const [disputeClaims, setDisputeClaims]   = useState<DisputeClaims | null>(null)
  const [myClaimText, setMyClaimText]       = useState('')
  const [myEvidenceUrl, setMyEvidenceUrl]   = useState('')
  const [claimSaving, setClaimSaving]       = useState(false)
  const [claimSavedMsg, setClaimSavedMsg]   = useState('')

  let tradeId: bigint
  try { tradeId = BigInt(tradeIdStr) }
  catch { tradeId = 0n }

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 10_000)
    return () => clearInterval(id)
  }, [])

  const wallet = publicKey?.toBase58() ?? ''

  const load = useCallback(async () => {
    setLoading(true)
    setErrorMsg('')
    try {
      const t = await fetchTrade(connection, tradeId)
      setTrade(t)
      if (t.status === 'Disputed') {
        const dp = await fetchDisputeForTrade(connection, tradeId)
        setDisputeProgress(dp)
      } else {
        setDisputeProgress(null)
      }
      try {
        const [tPda] = tradePDA(tradeId)
        const res = await fetch(`/api/trade-info?pda=${tPda.toBase58()}`)
        setPayInfo(res.ok ? await res.json() : null)
      } catch { setPayInfo(null) }

      // Fetch dispute claims (only available when Disputed + authorized wallet)
      try {
        const [tPda] = tradePDA(tradeId)
        const w = publicKey?.toBase58() ?? ''
        if (t.status === 'Disputed' && w) {
          const cr = await fetch(`/api/dispute-claim?trade_pda=${tPda.toBase58()}&wallet=${w}`)
          if (cr.ok) {
            const data = await cr.json() as DisputeClaims
            setDisputeClaims(data)
            // Pre-fill textarea with existing claim if we have one
            const mySide = t.seller === w ? 'seller' : t.buyer === w ? 'buyer' : null
            if (mySide) {
              const mine = mySide === 'buyer' ? data.buyer : data.seller
              if (mine) {
                setMyClaimText(mine.claim_text)
                setMyEvidenceUrl(mine.evidence_url ?? '')
              }
            }
          }
        } else {
          setDisputeClaims(null)
        }
      } catch { setDisputeClaims(null) }
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [connection, tradeId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!trade || trade.status !== 'Active' || trade.buyer !== wallet || !wallet) return
    const id = setInterval(() => load(), 10_000)
    return () => clearInterval(id)
  }, [trade?.status, trade?.buyer, wallet, load])

  async function withAction(key: string, fn: () => Promise<void>) {
    setActing(key)
    setErrorMsg('')
    setSuccessMsg('')
    try {
      await fn()
      setSuccessMsg('Transaction confirmed')
      await load()
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e)
      setErrorMsg(raw.length > 200 ? raw.slice(0, 200) + '…' : raw)
    } finally {
      setActing(null)
    }
  }

  async function handleConfirm() {
    if (!publicKey || !trade) return
    await withAction('confirm', async () => {
      const [tradeAccount] = tradePDA(tradeId)
      const [vault]        = vaultPDA(tradeId)
      const usdtMint       = new PublicKey(USDT_MINT)
      const buyerPk        = new PublicKey(trade.buyer)
      const buyerAta       = getAssociatedTokenAddressSync(usdtMint, buyerPk)
      const tx = new Transaction()
      const ataInfo = await connection.getAccountInfo(buyerAta)
      if (!ataInfo) tx.add(createAssociatedTokenAccountInstruction(publicKey, buyerAta, buyerPk, usdtMint))
      tx.add(buildConfirmIx(tradeId, tradeAccount, vault, publicKey, buyerAta))
      const sig = await sendTransaction(tx, connection)
      await connection.confirmTransaction(sig, 'confirmed')
      setTxSig(sig)
    })
  }

  async function handleCancel() {
    if (!publicKey || !trade) return
    await withAction('cancel', async () => {
      const [escrowState]  = escrowStatePDA()
      const [tradeAccount] = tradePDA(tradeId)
      const [vault]        = vaultPDA(tradeId)
      const usdtMint       = new PublicKey(USDT_MINT)
      const sellerAta      = getAssociatedTokenAddressSync(usdtMint, new PublicKey(trade.seller))
      const adminAta       = getAssociatedTokenAddressSync(usdtMint, ADMIN_PUBKEY)
      const tx = new Transaction()
      const adminAtaInfo = await connection.getAccountInfo(adminAta)
      if (!adminAtaInfo) tx.add(createAssociatedTokenAccountInstruction(publicKey, adminAta, ADMIN_PUBKEY, usdtMint))
      tx.add(buildCancelIx(tradeId, escrowState, tradeAccount, vault, publicKey, sellerAta, adminAta))
      const sig = await sendTransaction(tx, connection)
      await connection.confirmTransaction(sig, 'confirmed')
      setTxSig(sig)
    })
  }

  async function handleResolve() {
    if (!publicKey || !trade || !disputeProgress) return
    await withAction('resolve', async () => {
      const usdtMint         = new PublicKey(USDT_MINT)
      const [escrowState]    = escrowStatePDA()
      const [disputeAcc]     = disputePDA(disputeProgress.disputeId)
      const [tradeAcc]       = tradePDA(tradeId)
      const [vault]          = vaultPDA(tradeId)
      const [arbVault]       = arbVaultPDA()
      const buyerAta         = getAssociatedTokenAddressSync(usdtMint, new PublicKey(trade.buyer))
      const sellerAta        = getAssociatedTokenAddressSync(usdtMint, new PublicKey(trade.seller))
      const tx = new Transaction()
      tx.add(buildResolveIx(
        disputeProgress.disputeId,
        escrowState, disputeAcc, tradeAcc, vault,
        buyerAta, sellerAta, arbVault, publicKey,
      ))
      const sig = await sendTransaction(tx, connection)
      await connection.confirmTransaction(sig, 'confirmed')
      setTxSig(sig)
    })
  }

  async function handleDispute() {
    if (!publicKey || !trade) return
    await withAction('dispute', async () => {
      const [escrowState]    = escrowStatePDA()
      const [tradeAccount]   = tradePDA(tradeId)
      const disputeCounter   = await fetchDisputeCounter(connection)
      const [disputeAccount] = disputePDA(disputeCounter)
      const tx = new Transaction()
      tx.add(buildDisputeIx(tradeId, escrowState, tradeAccount, disputeAccount, publicKey))
      const sig = await sendTransaction(tx, connection)
      await connection.confirmTransaction(sig, 'confirmed')
      setTxSig(sig)
    })
  }

  // ── Save dispute claim (off-chain)
  async function handleSaveClaim(side: 'buyer' | 'seller') {
    if (!publicKey || !trade) return
    setClaimSaving(true)
    setClaimSavedMsg('')
    try {
      const [tPda] = tradePDA(tradeId)
      const res = await fetch('/api/dispute-claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trade_pda:    tPda.toBase58(),
          side,
          wallet:       publicKey.toBase58(),
          claim_text:   myClaimText,
          evidence_url: myEvidenceUrl || null,
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error ?? 'Save failed')
      }
      setClaimSavedMsg('Claim saved')
      // Refresh claims
      const cr = await fetch(`/api/dispute-claim?trade_pda=${tPda.toBase58()}&wallet=${publicKey.toBase58()}`)
      if (cr.ok) setDisputeClaims(await cr.json())
    } catch (e: unknown) {
      setClaimSavedMsg(e instanceof Error ? e.message : 'Error saving')
    } finally {
      setClaimSaving(false)
    }
  }

  // ── Derived state
  const isSeller = trade?.seller === wallet
  const isBuyer  = trade?.buyer  === wallet && trade?.buyer !== NULL_PUBKEY
  const role     = isSeller ? 'SELLER' : isBuyer ? 'BUYER' : null

  const canConfirm = trade?.status === 'Active' && isSeller
  const canCancel  = trade &&
    ((trade.status === 'Open' && isSeller) ||
     (trade.status === 'Active' && (isSeller || isBuyer) && canCancelActive(trade.joinedAt)))
  const canDispute = trade?.status === 'Active' && isBuyer
  const canResolve = trade?.status === 'Disputed' &&
    disputeProgress !== null &&
    !disputeProgress.isResolved &&
    disputeProgress.votesForBuyer !== disputeProgress.votesForSeller &&
    (disputeProgress.votedCount === 3 || Date.now() / 1000 >= disputeProgress.raisedAt + 86400)
  const countdown = trade?.status === 'Active' && trade.joinedAt && !canCancelActive(trade.joinedAt)
    ? cancelCountdown(trade.joinedAt)
    : ''

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
          <Link href="/my-trades" style={{
            color: '#475569', fontSize: '0.82rem', textDecoration: 'none',
          }}>
            ← My Trades
          </Link>
          <span style={{ color: 'rgba(255,255,255,0.1)' }}>|</span>
          <span style={{ color: '#fff', fontWeight: 600, fontSize: '0.88rem' }}>
            Trade #{String(tradeId).padStart(5, '0')}
          </span>
          {role && (
            <span style={{
              fontSize: '0.65rem', fontWeight: 700, padding: '2px 8px', borderRadius: 6,
              background: role === 'SELLER' ? 'rgba(124,58,237,0.15)' : 'rgba(16,185,129,0.1)',
              color:      role === 'SELLER' ? '#a78bfa'               : '#34d399',
              border:     role === 'SELLER' ? '1px solid rgba(124,58,237,0.3)' : '1px solid rgba(16,185,129,0.25)',
            }}>
              {role}
            </span>
          )}
        </div>
        <WalletButton />
      </div>

      {/* Body */}
      <div className="defi-body">
        <div style={{ maxWidth: 520, margin: '0 auto', padding: '24px 20px 60px', width: '100%' }}>

          {/* Loading */}
          {loading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#64748b', padding: '32px 0' }}>
              <Spinner />
              Loading trade…
            </div>
          )}

          {/* Error */}
          {errorMsg && !loading && (
            <div className="defi-alert-error" style={{ padding: '14px 16px', marginBottom: 16 }}>
              <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: 4 }}>⚠ Error</div>
              <div style={{ fontSize: '0.75rem', wordBreak: 'break-word' }}>{errorMsg}</div>
            </div>
          )}

          {/* Success */}
          {successMsg && (
            <div className="defi-alert-success" style={{ padding: '12px 16px', marginBottom: 16 }}>
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

          {trade && !loading && (
            <>
              {/* Status */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
                <StatusBadge status={trade.status} />
                {trade.vaultLocked !== undefined && (
                  <span style={{
                    fontSize: '0.72rem', color: '#f59e0b',
                    background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)',
                    borderRadius: 6, padding: '2px 8px',
                  }}>
                    🔒 {fmt(trade.vaultLocked)} USDT locked
                  </span>
                )}
              </div>

              {/* Trade details */}
              <div className="glass-card" style={{ padding: '16px 20px', marginBottom: 16 }}>
                <div style={{ color: '#475569', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.08em', marginBottom: 12 }}>
                  TRADE DETAILS
                </div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: '2rem', fontWeight: 700, color: '#fff', lineHeight: 1 }}>
                    {(Number(trade.amount) / 10 ** USDT_DECIMALS).toFixed(2)}{' '}
                    <span style={{ fontSize: '0.9rem', color: '#64748b', fontWeight: 500 }}>USDT</span>
                  </div>
                  <div style={{ fontSize: '0.82rem', color: '#475569', marginTop: 4 }}>
                    ≈ {(Number(trade.amount) / 10 ** USDT_DECIMALS * Number(trade.rate)).toLocaleString()} PKR
                  </div>
                </div>

                <div className="defi-row">
                  <span style={{ color: '#64748b' }}>Rate</span>
                  <span style={{ color: '#cbd5e1' }}>{trade.rate.toString()} PKR/USDT</span>
                </div>
                <div className="defi-row">
                  <span style={{ color: '#64748b' }}>Created</span>
                  <span style={{ color: '#94a3b8' }}>{timeAgo(trade.createdAt)}</span>
                </div>
                {trade.joinedAt > 0 && (
                  <div className="defi-row">
                    <span style={{ color: '#64748b' }}>Joined</span>
                    <span style={{ color: '#94a3b8' }}>{timeAgo(trade.joinedAt)}</span>
                  </div>
                )}
                {countdown && (
                  <div className="defi-row">
                    <span style={{ color: '#64748b' }}>Cancel unlocks in</span>
                    <span style={{ color: '#f59e0b' }}>{countdown}</span>
                  </div>
                )}
              </div>

              {/* Parties */}
              <div className="glass-card" style={{ padding: '16px 20px', marginBottom: 16 }}>
                <div style={{ color: '#475569', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.08em', marginBottom: 12 }}>
                  PARTIES
                </div>
                <div className="defi-row">
                  <span style={{ color: '#64748b' }}>Seller</span>
                  <span style={{ fontFamily: 'monospace', fontSize: '0.78rem', color: isSeller ? '#a78bfa' : '#94a3b8' }}>
                    {trade.seller.slice(0, 8)}…{trade.seller.slice(-8)}
                    {isSeller && <span style={{ color: '#a78bfa', fontSize: '0.65rem', marginLeft: 6 }}>YOU</span>}
                  </span>
                </div>
                {trade.buyer !== NULL_PUBKEY ? (
                  <div className="defi-row">
                    <span style={{ color: '#64748b' }}>Buyer</span>
                    <span style={{ fontFamily: 'monospace', fontSize: '0.78rem', color: isBuyer ? '#34d399' : '#94a3b8' }}>
                      {trade.buyer.slice(0, 8)}…{trade.buyer.slice(-8)}
                      {isBuyer && <span style={{ color: '#34d399', fontSize: '0.65rem', marginLeft: 6 }}>YOU</span>}
                    </span>
                  </div>
                ) : (
                  <div className="defi-row">
                    <span style={{ color: '#64748b' }}>Buyer</span>
                    <span style={{ color: '#334155', fontStyle: 'italic', fontSize: '0.8rem' }}>Awaiting buyer…</span>
                  </div>
                )}
              </div>

              {/* Payment info — buyer only, Active */}
              {trade.status === 'Active' && isBuyer && (
                <div style={{
                  background: 'rgba(16,185,129,0.05)', border: '1px solid rgba(16,185,129,0.2)',
                  borderRadius: 12, padding: '16px 20px', marginBottom: 16,
                }}>
                  <div style={{ color: '#10b981', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.08em', marginBottom: 14 }}>
                    SEND PAYMENT TO SELLER
                  </div>
                  {payInfo ? (
                    <>
                      <div className="defi-row">
                        <span style={{ color: '#64748b' }}>Send via</span>
                        <span style={{ color: '#34d399', fontWeight: 600 }}>{payInfo.method}</span>
                      </div>
                      <div className="defi-row">
                        <span style={{ color: '#64748b' }}>Account</span>
                        <span style={{ color: '#34d399', fontFamily: 'monospace', fontSize: '0.82rem' }}>{payInfo.account}</span>
                      </div>
                      {payInfo.name && (
                        <div className="defi-row">
                          <span style={{ color: '#64748b' }}>Name</span>
                          <span style={{ color: '#34d399' }}>{payInfo.name}</span>
                        </div>
                      )}
                      <div className="defi-row">
                        <span style={{ color: '#64748b' }}>Exact amount</span>
                        <span style={{ color: '#f59e0b', fontWeight: 700, fontSize: '0.95rem' }}>
                          {(Number(trade.amount) / 10 ** USDT_DECIMALS * Number(trade.rate)).toLocaleString()} PKR
                        </span>
                      </div>
                      <div style={{ marginTop: 12, padding: '10px 12px', background: 'rgba(16,185,129,0.06)', borderRadius: 8, fontSize: '0.72rem', color: '#475569', lineHeight: 1.7 }}>
                        Send the exact PKR amount above. Once sent, wait for the seller to confirm on-chain. If seller does not confirm, raise a dispute.
                      </div>
                    </>
                  ) : (
                    <div style={{ color: '#475569', fontSize: '0.8rem' }}>
                      Contact seller directly — payment info not on file.
                    </div>
                  )}

                  {/* Buyer waiting */}
                  <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 8, color: '#f59e0b', fontSize: '0.8rem' }}>
                    <Spinner color="#f59e0b" />
                    Waiting for seller to confirm receipt · auto-refreshing
                  </div>
                </div>
              )}

              {/* Actions */}
              {(canConfirm || canCancel || canDispute) && (
                <div className="glass-card" style={{ padding: '16px 20px', marginBottom: 16 }}>
                  <div style={{ color: '#475569', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.08em', marginBottom: 14 }}>
                    ACTIONS
                  </div>

                  {acting ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#f59e0b', fontSize: '0.85rem' }}>
                      <Spinner color="#f59e0b" />
                      Processing — approve in wallet…
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {canConfirm && (
                        <>
                          <button
                            className="btn-gradient"
                            onClick={handleConfirm}
                            style={{ fontSize: '0.88rem', padding: '11px', border: 'none', cursor: 'pointer', width: '100%' }}
                          >
                            Confirm Payment — Release USDT to Buyer
                          </button>
                          <div style={{ fontSize: '0.72rem', color: '#475569', lineHeight: 1.6 }}>
                            Only click after you have received the PKR from the buyer. This releases USDT and cannot be undone.
                          </div>
                        </>
                      )}

                      {canDispute && (
                        <>
                          <button
                            onClick={handleDispute}
                            style={{
                              fontSize: '0.85rem', padding: '10px', borderRadius: 10, cursor: 'pointer', width: '100%',
                              background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)',
                              color: '#f87171', fontWeight: 600,
                            }}
                          >
                            Raise Dispute
                          </button>
                          <div style={{ fontSize: '0.72rem', color: '#475569', lineHeight: 1.6 }}>
                            Only if you sent PKR and the seller is not confirming. Arbitrators (2/3 vote) will decide.
                          </div>
                        </>
                      )}

                      {canCancel && (
                        <button
                          onClick={handleCancel}
                          style={{
                            fontSize: '0.85rem', padding: '10px', borderRadius: 10, cursor: 'pointer', width: '100%',
                            background: 'rgba(100,116,139,0.08)', border: '1px solid rgba(100,116,139,0.25)',
                            color: '#94a3b8', fontWeight: 600,
                          }}
                        >
                          Cancel Trade
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Terminal states */}
              {(trade.status === 'Completed' || trade.status === 'Cancelled') && (
                <div className="glass-card" style={{ padding: '16px 20px', marginBottom: 16, textAlign: 'center' }}>
                  {trade.status === 'Completed' && (
                    <>
                      <div style={{ fontSize: '2rem', marginBottom: 8 }}>✅</div>
                      <div style={{ color: '#10b981', fontWeight: 600 }}>Trade Complete</div>
                      <div style={{ color: '#475569', fontSize: '0.8rem', marginTop: 4 }}>USDT has been released to the buyer</div>
                    </>
                  )}
                  {trade.status === 'Cancelled' && (
                    <>
                      <div style={{ fontSize: '2rem', marginBottom: 8 }}>🚫</div>
                      <div style={{ color: '#64748b', fontWeight: 600 }}>Trade Cancelled</div>
                      <div style={{ color: '#475569', fontSize: '0.8rem', marginTop: 4 }}>Funds returned to seller</div>
                    </>
                  )}
                </div>
              )}

              {/* Dispute panel */}
              {trade.status === 'Disputed' && (
                <div className="glass-card" style={{ padding: '16px 20px', marginBottom: 16 }}>
                  <div style={{ color: '#ef4444', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.08em', marginBottom: 14 }}>
                    DISPUTE IN PROGRESS
                  </div>

                  {disputeProgress ? (
                    <>
                      <div className="defi-row">
                        <span style={{ color: '#64748b' }}>Dispute ID</span>
                        <span style={{ color: '#94a3b8', fontFamily: 'monospace', fontSize: '0.78rem' }}>
                          #{String(disputeProgress.disputeId).padStart(5, '0')}
                        </span>
                      </div>
                      <div className="defi-row">
                        <span style={{ color: '#64748b' }}>Raised by</span>
                        <span style={{ color: '#94a3b8', fontFamily: 'monospace', fontSize: '0.75rem' }}>
                          {disputeProgress.raisedBy.slice(0, 6)}…{disputeProgress.raisedBy.slice(-6)}
                          {disputeProgress.raisedBy === trade.buyer && (
                            <span style={{ color: '#34d399', fontSize: '0.65rem', marginLeft: 6 }}>BUYER</span>
                          )}
                        </span>
                      </div>
                      <div className="defi-row">
                        <span style={{ color: '#64748b' }}>Raised</span>
                        <span style={{ color: '#94a3b8' }}>{timeAgo(disputeProgress.raisedAt)}</span>
                      </div>

                      {/* Vote bars */}
                      <div style={{ marginTop: 16 }}>
                        <div style={{ color: '#475569', fontSize: '0.68rem', letterSpacing: '0.08em', marginBottom: 12 }}>
                          ARBITRATOR VOTES ({disputeProgress.votedCount}/3 voted)
                        </div>

                        {/* Buyer votes */}
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                            <span style={{ color: '#64748b', fontSize: '0.75rem' }}>Buyer wins</span>
                            <span style={{ color: '#10b981', fontSize: '0.75rem', fontWeight: 600 }}>
                              {disputeProgress.votesForBuyer}/3
                            </span>
                          </div>
                          <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                            <div style={{
                              height: '100%', borderRadius: 3,
                              width: `${(disputeProgress.votesForBuyer / 3) * 100}%`,
                              background: 'linear-gradient(90deg, #10b981, #34d399)',
                              transition: 'width 0.4s ease',
                            }} />
                          </div>
                        </div>

                        {/* Seller votes */}
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                            <span style={{ color: '#64748b', fontSize: '0.75rem' }}>Seller wins</span>
                            <span style={{ color: '#ef4444', fontSize: '0.75rem', fontWeight: 600 }}>
                              {disputeProgress.votesForSeller}/3
                            </span>
                          </div>
                          <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                            <div style={{
                              height: '100%', borderRadius: 3,
                              width: `${(disputeProgress.votesForSeller / 3) * 100}%`,
                              background: 'linear-gradient(90deg, #ef4444, #f87171)',
                              transition: 'width 0.4s ease',
                            }} />
                          </div>
                        </div>

                        <div style={{ marginTop: 10, color: '#334155', fontSize: '0.7rem' }}>
                          2/3 votes needed to resolve
                        </div>
                      </div>

                      {/* Dispute claims */}
                      {disputeClaims !== null && (() => {
                        const wallet = publicKey?.toBase58() ?? ''
                        const mySide = trade.seller === wallet ? 'seller' : trade.buyer === wallet ? 'buyer' : null
                        return (
                          <div style={{ marginTop: 20 }}>
                            <div style={{ color: '#475569', fontSize: '0.68rem', letterSpacing: '0.08em', marginBottom: 12 }}>
                              DISPUTE CLAIMS
                            </div>

                            {/* My claim form */}
                            {mySide && (
                              <div style={{
                                background: 'rgba(139,92,246,0.06)',
                                border: '1px solid rgba(139,92,246,0.2)',
                                borderRadius: 10,
                                padding: '14px 16px',
                                marginBottom: 12,
                              }}>
                                <div style={{ color: '#a78bfa', fontSize: '0.7rem', fontWeight: 600, marginBottom: 10, letterSpacing: '0.06em' }}>
                                  YOUR CLAIM ({mySide.toUpperCase()})
                                </div>
                                <textarea
                                  value={myClaimText}
                                  onChange={e => setMyClaimText(e.target.value)}
                                  maxLength={500}
                                  rows={4}
                                  placeholder="Describe your side of the dispute…"
                                  style={{
                                    width: '100%', boxSizing: 'border-box',
                                    background: 'rgba(0,0,0,0.3)',
                                    border: '1px solid rgba(139,92,246,0.25)',
                                    borderRadius: 7,
                                    color: '#e2e8f0', fontSize: '0.82rem',
                                    padding: '10px 12px', resize: 'vertical',
                                    fontFamily: 'inherit', outline: 'none',
                                  }}
                                />
                                <div style={{ display: 'flex', justifyContent: 'flex-end', color: '#475569', fontSize: '0.68rem', marginTop: 4, marginBottom: 10 }}>
                                  {myClaimText.length}/500
                                </div>
                                <input
                                  type="url"
                                  value={myEvidenceUrl}
                                  onChange={e => setMyEvidenceUrl(e.target.value)}
                                  placeholder="Evidence URL (screenshot, receipt link — optional)"
                                  style={{
                                    width: '100%', boxSizing: 'border-box',
                                    background: 'rgba(0,0,0,0.3)',
                                    border: '1px solid rgba(139,92,246,0.25)',
                                    borderRadius: 7,
                                    color: '#e2e8f0', fontSize: '0.8rem',
                                    padding: '9px 12px', marginBottom: 12,
                                    fontFamily: 'inherit', outline: 'none',
                                  }}
                                />
                                {claimSaving ? (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#a78bfa', fontSize: '0.82rem' }}>
                                    <Spinner color="#a78bfa" /> Saving…
                                  </div>
                                ) : (
                                  <button
                                    onClick={() => handleSaveClaim(mySide)}
                                    disabled={myClaimText.trim().length === 0}
                                    style={{
                                      background: myClaimText.trim().length === 0
                                        ? 'rgba(139,92,246,0.15)'
                                        : 'linear-gradient(135deg, #7c3aed, #4f46e5)',
                                      color: myClaimText.trim().length === 0 ? '#475569' : '#fff',
                                      border: 'none', borderRadius: 8,
                                      padding: '9px 20px', fontSize: '0.82rem',
                                      cursor: myClaimText.trim().length === 0 ? 'not-allowed' : 'pointer',
                                      fontWeight: 600,
                                    }}
                                  >
                                    Save Claim
                                  </button>
                                )}
                                {claimSavedMsg && (
                                  <div style={{
                                    marginTop: 8, fontSize: '0.78rem',
                                    color: claimSavedMsg.toLowerCase().includes('error') || claimSavedMsg.toLowerCase().includes('fail')
                                      ? '#ef4444' : '#34d399',
                                  }}>
                                    {claimSavedMsg}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Blind notice for buyer/seller */}
                            {mySide && (
                              <div style={{
                                background: 'rgba(15,23,42,0.4)',
                                border: '1px solid rgba(255,255,255,0.06)',
                                borderRadius: 10,
                                padding: '12px 16px',
                                display: 'flex', alignItems: 'flex-start', gap: 10,
                              }}>
                                <span style={{ fontSize: '1rem', flexShrink: 0, marginTop: 1 }}>🔒</span>
                                <div>
                                  <div style={{ color: '#64748b', fontSize: '0.78rem', lineHeight: 1.6 }}>
                                    The other party&apos;s claim is hidden until the dispute resolves.
                                    This prevents either side from rewriting their story after seeing the other&apos;s.
                                  </div>
                                  <div style={{ color: '#334155', fontSize: '0.68rem', marginTop: 4 }}>
                                    Arbitrators can see both claims and will vote based on the evidence submitted.
                                  </div>
                                </div>
                              </div>
                            )}

                            {/* Arbitrator-only view */}
                            {!mySide && (
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                                {(['buyer', 'seller'] as const).map(side => {
                                  const claim = disputeClaims[side]
                                  return (
                                    <div key={side} style={{
                                      background: 'rgba(15,23,42,0.5)',
                                      border: '1px solid rgba(255,255,255,0.07)',
                                      borderRadius: 10,
                                      padding: '14px 16px',
                                    }}>
                                      <div style={{ color: '#64748b', fontSize: '0.68rem', fontWeight: 600, marginBottom: 8, letterSpacing: '0.06em' }}>
                                        {side.toUpperCase()}&apos;S CLAIM
                                      </div>
                                      {claim ? (
                                        <>
                                          <div style={{ color: '#cbd5e1', fontSize: '0.8rem', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                            {claim.claim_text}
                                          </div>
                                          {claim.evidence_url && (
                                            <a href={claim.evidence_url} target="_blank" rel="noopener noreferrer"
                                              style={{ display: 'inline-block', marginTop: 8, color: '#818cf8', fontSize: '0.75rem', textDecoration: 'none' }}>
                                              View Evidence →
                                            </a>
                                          )}
                                        </>
                                      ) : (
                                        <div style={{ color: '#334155', fontSize: '0.78rem', fontStyle: 'italic' }}>
                                          No claim submitted yet.
                                        </div>
                                      )}
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        )
                      })()}

                      {/* Release Funds */}
                      {canResolve && (
                        <div style={{ marginTop: 16 }}>
                          {acting === 'resolve' ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#f59e0b', fontSize: '0.85rem' }}>
                              <Spinner color="#f59e0b" />
                              Releasing funds — approve in wallet…
                            </div>
                          ) : (
                            <>
                              <button
                                className="btn-gradient"
                                onClick={handleResolve}
                                style={{ fontSize: '0.88rem', padding: '11px', border: 'none', cursor: 'pointer', width: '100%' }}
                              >
                                Release Funds
                              </button>
                              <div style={{ marginTop: 8, fontSize: '0.72rem', color: '#475569' }}>
                                Majority vote reached — anyone can trigger the release.
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={{ color: '#ef4444', fontSize: '0.85rem' }}>
                      Dispute raised — awaiting arbitrator votes
                    </div>
                  )}
                </div>
              )}

              {/* Refresh */}
              <button
                onClick={load}
                style={{
                  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
                  color: '#64748b', fontSize: '0.75rem', padding: '7px 16px',
                  borderRadius: 8, cursor: 'pointer',
                }}
              >
                Refresh ↻
              </button>
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
        <span style={{ color: '#475569', fontSize: '0.68rem' }}>devnet · trade detail</span>
      </div>
    </div>
  )
}
