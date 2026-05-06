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

interface DisputeProgress {
  disputeId:      bigint
  raisedBy:       string
  votesForBuyer:  number
  votesForSeller: number
  isResolved:     boolean
  raisedAt:       number
  votedCount:     number  // how many of the 3 arbitrators have voted
}

interface TradeData {
  tradeId:   bigint
  seller:    string
  buyer:     string
  amount:    bigint
  rate:      bigint
  createdAt: number
  joinedAt:  number
  status:    TradeStatus
  vaultLocked?: bigint  // fetched separately
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
  if (!info) throw new Error(`TRADE #${tradeId} NOT FOUND`)

  const d = info.data as Buffer
  for (let i = 0; i < 8; i++) {
    if (d[i] !== TRADE_DISC[i]) throw new Error('INVALID ACCOUNT DATA')
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

  // Fetch vault balance (SPL token account: bytes 64–71 = amount u64 LE)
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

// DisputeAccount layout (164 bytes):
//   8 disc | 8 dispute_id | 8 trade_id | 32 raised_by |
//   1 votes_for_buyer | 1 votes_for_seller | 1 is_resolved |
//   8 created_at | 96 voters[3] | 1 bump
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

// ── Status color ──────────────────────────────────────────────────────────────

function statusColor(s: TradeStatus): string {
  return { Open: GREEN, Active: YELLOW, Disputed: RED, Completed: GREEN_DIM, Cancelled: GREEN_DIM }[s]
}

// ── Shell ─────────────────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="terminal-page fixed inset-0 z-50 flex flex-col overflow-auto"
      style={{ background: '#000', fontFamily: MONO }}>
      {children}
      <div className="shrink-0 px-4 py-2 border-t"
        style={{ color: GREEN_DIM, borderColor: '#0d260d', fontSize: '0.7rem', letterSpacing: '0.03em' }}>
        {'>'} safe p2p escrow&nbsp;&nbsp;|&nbsp;&nbsp;devnet&nbsp;&nbsp;|&nbsp;&nbsp;trade detail
      </div>
    </div>
  )
}

// ── Row helper ────────────────────────────────────────────────────────────────

function Row({ label, value, valueColor = GREEN, small = false }: {
  label: string; value: string; valueColor?: string; small?: boolean
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      padding: '4px 0', fontSize: small ? '0.72rem' : '0.8rem', letterSpacing: '0.03em' }}>
      <span style={{ color: GREEN_DIM }}>{label}</span>
      <span style={{ color: valueColor, fontSize: small ? '0.68rem' : undefined }}>{value}</span>
    </div>
  )
}

// ── Section header ────────────────────────────────────────────────────────────

function Section({ title }: { title: string }) {
  return (
    <div style={{ color: GREEN_DIM, fontSize: '0.68rem', letterSpacing: '0.12em',
      borderTop: `1px solid ${GREEN_DIM}`, paddingTop: '12px', marginTop: '16px', marginBottom: '8px' }}>
      ── {title} {'─'.repeat(Math.max(0, 38 - title.length))}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function TradeDetailFeature({ tradeId: tradeIdStr }: { tradeId: string }) {
  const { connection }                 = useConnection()
  const { publicKey, sendTransaction } = useWallet()

  const [trade, setTrade]             = useState<TradeData | null>(null)
  const [disputeProgress, setDisputeProgress] = useState<DisputeProgress | null>(null)
  const [payInfo, setPayInfo]         = useState<{ method: string; account: string; name: string } | null>(null)
  const [loading, setLoading]         = useState(true)
  const [acting, setActing]           = useState<string | null>(null)
  const [errorMsg, setErrorMsg]       = useState('')
  const [successMsg, setSuccessMsg]   = useState('')
  const [txSig, setTxSig]             = useState('')
  const [, setTick]                   = useState(0)

  // Parse trade ID
  let tradeId: bigint
  try { tradeId = BigInt(tradeIdStr) }
  catch { tradeId = 0n }

  // Countdown re-render
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 10_000)
    return () => clearInterval(id)
  }, [])

  // Auto-poll every 10s when buyer is waiting for seller confirmation
  const wallet = publicKey?.toBase58() ?? ''
  useEffect(() => {
    if (!trade || trade.status !== 'Active' || trade.buyer !== wallet || !wallet) return
    const id = setInterval(() => load(), 10_000)
    return () => clearInterval(id)
  }, [trade?.status, trade?.buyer, wallet, load])

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
      // Fetch payment info (non-critical — don't throw if it fails)
      try {
        const [tPda] = tradePDA(tradeId)
        const res = await fetch(`/api/trade-info?pda=${tPda.toBase58()}`)
        setPayInfo(res.ok ? await res.json() : null)
      } catch { setPayInfo(null) }
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [connection, tradeId])

  useEffect(() => { load() }, [load])

  // ── Generic action wrapper
  async function withAction(key: string, fn: () => Promise<void>) {
    setActing(key)
    setErrorMsg('')
    setSuccessMsg('')
    try {
      await fn()
      setSuccessMsg('TRANSACTION CONFIRMED')
      await load()
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e)
      setErrorMsg(raw.length > 200 ? raw.slice(0, 200) + '…' : raw)
    } finally {
      setActing(null)
    }
  }

  // ── Confirm Payment
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

  // ── Cancel Trade
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

  // ── Resolve Dispute (anyone can call once votes are sufficient)
  async function handleResolve() {
    if (!publicKey || !trade || !disputeProgress) return
    await withAction('resolve', async () => {
      const usdtMint   = new PublicKey(USDT_MINT)
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

  // ── Raise Dispute
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

  // ── Derived
  const wallet   = publicKey?.toBase58() ?? ''
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
  const countdown  = trade?.status === 'Active' && trade.joinedAt && !canCancelActive(trade.joinedAt)
    ? cancelCountdown(trade.joinedAt)
    : ''

  // ── Render
  return (
    <Shell>
      {/* Header */}
      <div className="flex justify-between items-center px-6 py-4 shrink-0">
        <Link href="/my-trades"
          style={{ color: GREEN_DIM, fontSize: '0.8rem', letterSpacing: '0.08em', textDecoration: 'none' }}>
          {'<'} MY TRADES
        </Link>
        <WalletButton />
      </div>

      {/* Body */}
      <div className="flex-1 px-4 pb-8" style={{ maxWidth: '520px', margin: '0 auto', width: '100%' }}>

        {/* Title */}
        <div style={{ marginBottom: '20px' }}>
          <div style={{ color: GREEN, fontSize: 'clamp(1rem, 3vw, 1.2rem)', letterSpacing: '0.15em' }}>
            {'>'} TRADE #{tradeId.toString().padStart(7, '0')}
          </div>
          {role && (
            <div style={{ color: GREEN_DIM, fontSize: '0.72rem', letterSpacing: '0.08em', marginTop: '4px' }}>
              your role: <span style={{ color: GREEN }}>{role}</span>
            </div>
          )}
        </div>

        {/* Loading */}
        {loading && (
          <div style={{ color: GREEN, fontSize: '0.85rem', letterSpacing: '0.06em' }}>
            {'>'} LOADING<span className="terminal-cursor"> _</span>
          </div>
        )}

        {/* Error */}
        {errorMsg && !loading && (
          <div style={{ border: `1px solid ${RED}`, padding: '12px', color: RED,
            fontSize: '0.78rem', wordBreak: 'break-word', letterSpacing: '0.02em', marginBottom: '14px' }}>
            {errorMsg}
          </div>
        )}

        {/* Success */}
        {successMsg && (
          <div style={{ border: `1px solid ${GREEN}`, padding: '10px 14px', color: GREEN,
            fontSize: '0.78rem', letterSpacing: '0.05em', marginBottom: '14px' }}>
            {'>'} {successMsg}
            {txSig && (
              <a href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`}
                target="_blank" rel="noopener noreferrer"
                style={{ display: 'block', marginTop: '6px', color: GREEN_DIM, fontSize: '0.65rem', letterSpacing: '0.04em', textDecoration: 'underline' }}>
                {'>'} view on Solana Explorer ↗
              </a>
            )}
          </div>
        )}

        {trade && !loading && (
          <>
            {/* Status */}
            <div style={{ display: 'inline-block', border: `1px solid ${statusColor(trade.status)}`,
              color: statusColor(trade.status), padding: '3px 12px', fontSize: '0.78rem',
              letterSpacing: '0.12em', marginBottom: '4px' }}>
              {trade.status.toUpperCase()}
            </div>

            {/* Trade details */}
            <Section title="TRADE DETAILS" />
            <Row label="AMOUNT"       value={`${fmt(trade.amount)} USDT`} />
            <Row label="RATE"         value={`${trade.rate.toString()} PKR / USDT`} />
            <Row label="BUYER PAYS"
              value={`${(Number(trade.amount) / 10**USDT_DECIMALS * Number(trade.rate)).toLocaleString()} PKR`} />
            {trade.vaultLocked !== undefined && (
              <Row label="LOCKED IN VAULT" value={`${fmt(trade.vaultLocked)} USDT`} valueColor={YELLOW} />
            )}

            {/* Parties */}
            <Section title="PARTIES" />
            <Row
              label="SELLER"
              value={`${trade.seller.slice(0, 8)}…${trade.seller.slice(-8)}${isSeller ? '  [YOU]' : ''}`}
              valueColor={isSeller ? '#00ff41' : GREEN}
              small
            />
            {trade.buyer !== NULL_PUBKEY ? (
              <Row
                label="BUYER"
                value={`${trade.buyer.slice(0, 8)}…${trade.buyer.slice(-8)}${isBuyer ? '  [YOU]' : ''}`}
                valueColor={isBuyer ? '#00ff41' : GREEN}
                small
              />
            ) : (
              <Row label="BUYER" value="AWAITING BUYER…" valueColor={GREEN_DIM} />
            )}

            {/* Payment details — shown to buyer once trade is Active */}
            {trade.status === 'Active' && isBuyer && (
              <>
                <Section title="SEND PAYMENT TO SELLER" />
                {payInfo ? (
                  <div style={{
                    border: `1px solid ${GREEN}`,
                    padding: '14px 16px',
                    background: 'rgba(0,204,51,0.04)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                  }}>
                    <Row label="SEND VIA"   value={payInfo.method}  valueColor="#00ff41" />
                    <Row label="TO ACCOUNT" value={payInfo.account} valueColor="#00ff41" />
                    {payInfo.name && <Row label="ACCOUNT NAME" value={payInfo.name} valueColor="#00ff41" />}
                    <Row
                      label="EXACT AMOUNT"
                      value={`${(Number(trade.amount) / 10 ** USDT_DECIMALS * Number(trade.rate)).toLocaleString()} PKR`}
                      valueColor={YELLOW}
                    />
                    <div style={{ marginTop: '6px', color: GREEN_DIM, fontSize: '0.65rem', letterSpacing: '0.03em', lineHeight: 1.7 }}>
                      {'>'} send the exact PKR amount above to the account shown.<br />
                      {'>'} once sent, wait for the seller to confirm receipt on-chain.<br />
                      {'>'} if seller does not confirm, you can raise a dispute.
                    </div>
                  </div>
                ) : (
                  <div style={{ color: GREEN_DIM, fontSize: '0.75rem', letterSpacing: '0.04em' }}>
                    {'>'} contact seller directly — payment info not on file.
                  </div>
                )}
              </>
            )}

            {/* Buyer waiting indicator */}
            {trade.status === 'Active' && isBuyer && (
              <div style={{ marginTop: '14px', color: YELLOW, fontSize: '0.75rem', letterSpacing: '0.04em' }}>
                {'>'} waiting for seller to confirm PKR receipt<span className="terminal-cursor"> _</span>
                <div style={{ color: GREEN_DIM, fontSize: '0.65rem', marginTop: '4px' }}>
                  auto-refreshing every 10s
                </div>
              </div>
            )}

            {/* Timeline */}
            <Section title="TIMELINE" />
            <Row label="CREATED" value={timeAgo(trade.createdAt)} />
            {trade.joinedAt > 0 && (
              <Row label="JOINED" value={timeAgo(trade.joinedAt)} />
            )}
            {trade.status === 'Active' && countdown && (
              <Row label="CANCEL AVAILABLE IN" value={countdown} valueColor={YELLOW} />
            )}
            {trade.status === 'Active' && !countdown && (isSeller || isBuyer) && (
              <Row label="CANCEL AVAILABLE" value="NOW" valueColor={GREEN} />
            )}

            {/* Actions */}
            {(canConfirm || canCancel || canDispute) && (
              <>
                <Section title="ACTIONS" />

                {acting ? (
                  <div style={{ color: YELLOW, fontSize: '0.8rem', letterSpacing: '0.05em', marginTop: '8px' }}>
                    {'>'} PROCESSING… APPROVE IN WALLET<span className="terminal-cursor"> _</span>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '8px' }}>

                    {canConfirm && (
                      <button onClick={handleConfirm}
                        className="terminal-menu-btn w-full py-3 text-center"
                        style={{ border: `1px solid ${GREEN}`, color: GREEN, background: 'transparent',
                          fontFamily: MONO, fontSize: '0.85rem', letterSpacing: '0.1em', cursor: 'pointer' }}>
                        [ CONFIRM PAYMENT ]
                      </button>
                    )}

                    {canConfirm && (
                      <div style={{ color: GREEN_DIM, fontSize: '0.65rem', letterSpacing: '0.03em', lineHeight: 1.6 }}>
                        {'>'} only click this after you have RECEIVED the PKR from the buyer.<br />
                        {'>'} this releases USDT to the buyer. it cannot be undone.
                      </div>
                    )}

                    {canDispute && (
                      <button onClick={handleDispute}
                        className="terminal-menu-btn w-full py-3 text-center"
                        style={{ border: `1px solid ${RED}`, color: RED, background: 'transparent',
                          fontFamily: MONO, fontSize: '0.85rem', letterSpacing: '0.1em', cursor: 'pointer' }}>
                        [ RAISE DISPUTE ]
                      </button>
                    )}

                    {canDispute && (
                      <div style={{ color: GREEN_DIM, fontSize: '0.65rem', letterSpacing: '0.03em', lineHeight: 1.6 }}>
                        {'>'} only raise a dispute if you sent PKR and the seller is not confirming.<br />
                        {'>'} arbitrators will review and vote. 2/3 majority decides.
                      </div>
                    )}

                    {canCancel && (
                      <button onClick={handleCancel}
                        className="terminal-menu-btn w-full py-3 text-center"
                        style={{ border: `1px solid ${RED}`, color: RED, background: 'transparent',
                          fontFamily: MONO, fontSize: '0.85rem', letterSpacing: '0.1em', cursor: 'pointer' }}>
                        [ CANCEL TRADE ]
                      </button>
                    )}
                  </div>
                )}
              </>
            )}

            {/* Terminal states */}
            {(trade.status === 'Completed' || trade.status === 'Cancelled') && (
              <>
                <Section title="STATUS" />
                <div style={{ color: statusColor(trade.status), fontSize: '0.8rem', letterSpacing: '0.05em', lineHeight: 1.8 }}>
                  {trade.status === 'Completed' && '> TRADE COMPLETE — USDT HAS BEEN RELEASED TO BUYER'}
                  {trade.status === 'Cancelled' && '> TRADE CANCELLED — FUNDS RETURNED TO SELLER'}
                </div>
              </>
            )}

            {/* Dispute progress panel */}
            {trade.status === 'Disputed' && (
              <>
                <Section title="DISPUTE IN PROGRESS" />
                {disputeProgress ? (
                  <>
                    <Row label="DISPUTE ID" value={`#${disputeProgress.disputeId.toString().padStart(7, '0')}`} />
                    <Row
                      label="RAISED BY"
                      value={`${disputeProgress.raisedBy.slice(0, 8)}…${disputeProgress.raisedBy.slice(-8)}${disputeProgress.raisedBy === trade.buyer ? '  [BUYER]' : ''}`}
                      small
                    />
                    <Row label="RAISED" value={timeAgo(disputeProgress.raisedAt)} />

                    <div style={{ marginTop: '14px', marginBottom: '6px' }}>
                      <div style={{ color: GREEN_DIM, fontSize: '0.68rem', letterSpacing: '0.1em', marginBottom: '10px' }}>
                        ── ARBITRATOR VOTES ({disputeProgress.votedCount} / 3 voted) ───
                      </div>

                      {/* FOR BUYER bar */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
                        <span style={{ color: GREEN_DIM, fontSize: '0.7rem', letterSpacing: '0.06em', minWidth: '90px' }}>FOR BUYER</span>
                        <span style={{ color: GREEN, fontSize: '0.85rem', letterSpacing: '0.05em' }}>
                          {'█'.repeat(disputeProgress.votesForBuyer)}{'░'.repeat(3 - disputeProgress.votesForBuyer)}
                        </span>
                        <span style={{ color: disputeProgress.votesForBuyer > 0 ? GREEN : GREEN_DIM, fontSize: '0.78rem' }}>
                          {disputeProgress.votesForBuyer} / 3
                        </span>
                      </div>

                      {/* FOR SELLER bar */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <span style={{ color: GREEN_DIM, fontSize: '0.7rem', letterSpacing: '0.06em', minWidth: '90px' }}>FOR SELLER</span>
                        <span style={{ color: RED, fontSize: '0.85rem', letterSpacing: '0.05em' }}>
                          {'█'.repeat(disputeProgress.votesForSeller)}{'░'.repeat(3 - disputeProgress.votesForSeller)}
                        </span>
                        <span style={{ color: disputeProgress.votesForSeller > 0 ? RED : GREEN_DIM, fontSize: '0.78rem' }}>
                          {disputeProgress.votesForSeller} / 3
                        </span>
                      </div>
                    </div>

                    <div style={{ marginTop: '10px', color: GREEN_DIM, fontSize: '0.7rem', letterSpacing: '0.03em', lineHeight: 1.8 }}>
                      {'>'} 2 of 3 votes needed to resolve — funds release automatically on majority.
                    </div>

                    {canResolve && (
                      <div style={{ marginTop: '14px' }}>
                        {acting === 'resolve' ? (
                          <div style={{ color: YELLOW, fontSize: '0.8rem', letterSpacing: '0.05em' }}>
                            {'>'} RELEASING FUNDS… APPROVE IN WALLET<span className="terminal-cursor"> _</span>
                          </div>
                        ) : (
                          <>
                            <button
                              onClick={handleResolve}
                              className="terminal-menu-btn w-full py-3 text-center"
                              style={{ border: `1px solid ${GREEN}`, color: GREEN, background: 'transparent',
                                fontFamily: MONO, fontSize: '0.85rem', letterSpacing: '0.1em', cursor: 'pointer' }}
                            >
                              [ RELEASE FUNDS ]
                            </button>
                            <div style={{ marginTop: '6px', color: GREEN_DIM, fontSize: '0.65rem', letterSpacing: '0.03em' }}>
                              {'>'} majority vote reached — anyone can trigger the release.
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ color: RED, fontSize: '0.8rem', letterSpacing: '0.05em', lineHeight: 1.8 }}>
                    {'>'} DISPUTE RAISED — AWAITING ARBITRATOR VOTES
                  </div>
                )}
              </>
            )}

            {/* Refresh */}
            <div style={{ marginTop: '24px' }}>
              <button onClick={load}
                className="terminal-menu-btn"
                style={{ border: `1px solid ${GREEN_DIM}`, color: GREEN_DIM, background: 'transparent',
                  fontFamily: MONO, fontSize: '0.72rem', letterSpacing: '0.08em', padding: '5px 14px' }}>
                [ REFRESH ]
              </button>
            </div>
          </>
        )}
      </div>
    </Shell>
  )
}
