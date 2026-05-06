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

const GREEN     = '#00cc33'
const GREEN_DIM = '#006622'
const RED       = '#cc3300'
const YELLOW    = '#ccaa00'
const MONO      = "'Courier New', monospace"

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
  amount: bigint   // micro USDT
  rate: bigint     // PKR per USDT
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

// ── Data fetching — only OPEN trades (status byte === 0) ──────────────────────

function decodeOpenTrade(pda: string, data: Buffer): OpenTrade | null {
  if (data.length < 115) return null
  for (let i = 0; i < 8; i++) if (data[i] !== TRADE_DISC[i]) return null
  if (data[112] !== 0) return null // only Open status

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
    <div
      className="terminal-page fixed inset-0 z-50 flex flex-col overflow-auto"
      style={{ background: '#000', fontFamily: MONO }}
    >
      {children}
      <div
        className="shrink-0 px-4 py-2 border-t"
        style={{ color: GREEN_DIM, borderColor: '#0d260d', fontSize: '0.7rem', letterSpacing: '0.03em' }}
      >
        {'>'} safe p2p escrow&nbsp;&nbsp;|&nbsp;&nbsp;devnet&nbsp;&nbsp;|&nbsp;&nbsp;buy / browse trades
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function BrowseTradesFeature() {
  const router                         = useRouter()
  const { connection }                 = useConnection()
  const { publicKey, sendTransaction } = useWallet()

  const [trades, setTrades]       = useState<OpenTrade[]>([])
  const [payInfoMap, setPayInfoMap] = useState<Record<string, PayInfo | null>>({})
  const [marketRate, setMarketRate] = useState<number | null>(null)
  const [loading, setLoading]     = useState(false)
  const [joiningId, setJoiningId] = useState<string | null>(null)
  const [errorMsg, setErrorMsg]   = useState('')

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

      // Fetch payment method for each trade (non-blocking per-trade)
      const map: Record<string, PayInfo | null> = {}
      await Promise.all(open.map(async t => {
        try {
          const res = await fetch(`/api/trade-info?pda=${t.pda}`)
          map[t.pda] = res.ok ? await res.json() : null
        } catch {
          map[t.pda] = null
        }
      }))
      setPayInfoMap(map)
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [connection])

  useEffect(() => { load() }, [load])

  // ── Join handler
  async function handleJoin(t: OpenTrade) {
    if (!publicKey) return
    setJoiningId(t.pda)
    setErrorMsg('')

    try {
      const [tradeAccount] = tradePDA(t.tradeId)
      const [vault]        = vaultPDA(t.tradeId)
      const usdtMint       = new PublicKey(USDT_MINT)
      const buyerAta       = getAssociatedTokenAddressSync(usdtMint, publicKey)

      const tx = new Transaction()

      // Create buyer ATA if it doesn't exist yet
      const ataInfo = await connection.getAccountInfo(buyerAta)
      if (!ataInfo) {
        tx.add(createAssociatedTokenAccountInstruction(publicKey, buyerAta, publicKey, usdtMint))
      }

      tx.add(buildJoinTradeIx(t.tradeId, tradeAccount, vault, publicKey, buyerAta))

      const sig = await sendTransaction(tx, connection)
      await connection.confirmTransaction(sig, 'confirmed')

      // Redirect to my-trades so buyer sees their active trade
      router.push('/my-trades')
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e)
      setErrorMsg(raw.length > 200 ? raw.slice(0, 200) + '…' : raw)
      setJoiningId(null)
    }
  }

  // ── Trade card
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
      <div
        style={{
          border: `1px solid ${isOwn ? GREEN_DIM : GREEN_DIM}`,
          padding: '16px',
          marginBottom: '12px',
          opacity: isJoining ? 0.6 : 1,
          transition: 'opacity 0.2s',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <span style={{ color: '#00ff41', fontSize: '0.85rem', letterSpacing: '0.08em' }}>
            #{t.tradeId.toString().padStart(7, '0')}
          </span>
          <span style={{ color: GREEN, fontSize: '0.68rem', letterSpacing: '0.1em', border: `1px solid ${GREEN}`, padding: '1px 6px' }}>
            OPEN
          </span>
        </div>

        {/* Details grid */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '0.8rem', letterSpacing: '0.03em', marginBottom: '14px' }}>

          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: GREEN_DIM }}>YOU RECEIVE</span>
            <span style={{ color: '#00ff41', fontWeight: 'bold' }}>{amountDisplay} USDT</span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: GREEN_DIM }}>PKR TO SEND</span>
            <span style={{ color: GREEN }}>{pkrAmount} PKR</span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: GREEN_DIM }}>YOUR FEE (0.5%)</span>
            <span style={{ color: YELLOW }}>{feeDisplay} USDT</span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: GREEN_DIM }}>RATE</span>
            <span style={{ color: GREEN }}>{t.rate.toString()} PKR / USDT</span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: GREEN_DIM }}>SELLER</span>
            <span style={{ color: GREEN, fontSize: '0.72rem' }}>
              {t.seller.slice(0, 6)}…{t.seller.slice(-6)}
            </span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: GREEN_DIM }}>POSTED</span>
            <span style={{ color: GREEN_DIM }}>{timeAgo(t.createdAt)}</span>
          </div>

          {payInfo && (
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', paddingTop: '8px', borderTop: `1px solid ${GREEN_DIM}` }}>
              <span style={{ color: GREEN_DIM }}>PAYMENT VIA</span>
              <span style={{
                color: '#00ff41', fontSize: '0.72rem', letterSpacing: '0.1em',
                border: '1px solid #00ff41', padding: '1px 8px',
              }}>
                {payInfo.method.toUpperCase()}
              </span>
            </div>
          )}
        </div>

        {/* Divider */}
        <div style={{ borderTop: `1px solid ${GREEN_DIM}`, marginBottom: '12px' }} />

        {/* Off-chain reminder */}
        <div style={{ color: GREEN_DIM, fontSize: '0.65rem', letterSpacing: '0.03em', marginBottom: '12px', lineHeight: 1.6 }}>
          {'>'} after joining, send PKR directly to seller off-chain.<br />
          {'>'} USDT releases when seller confirms receipt.
        </div>

        {/* Action */}
        {isJoining ? (
          <div style={{ color: YELLOW, fontSize: '0.78rem', letterSpacing: '0.05em' }}>
            {'>'} JOINING TRADE… APPROVE IN WALLET<span className="terminal-cursor"> _</span>
          </div>
        ) : isOwn ? (
          <button
            disabled
            style={{
              width: '100%',
              padding: '11px',
              border: `1px solid ${GREEN_DIM}`,
              color: GREEN_DIM,
              background: 'transparent',
              fontFamily: MONO,
              fontSize: '0.8rem',
              letterSpacing: '0.1em',
              cursor: 'default',
              textAlign: 'center',
            }}
          >
            [ YOUR OWN TRADE ]
          </button>
        ) : (
          <button
            onClick={() => handleJoin(t)}
            disabled={!canJoin}
            className={canJoin ? 'terminal-menu-btn' : ''}
            style={{
              width: '100%',
              padding: '11px',
              border: `1px solid ${canJoin ? GREEN : GREEN_DIM}`,
              color: canJoin ? GREEN : GREEN_DIM,
              background: 'transparent',
              fontFamily: MONO,
              fontSize: '0.8rem',
              letterSpacing: '0.1em',
              cursor: canJoin ? 'pointer' : 'default',
              textAlign: 'center',
            }}
          >
            [ JOIN TRADE ]
          </button>
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
            {'>'} BUY USDT
          </div>
          {marketRate && (
            <div style={{
              marginTop: '8px', padding: '6px 10px',
              border: `1px solid ${GREEN_DIM}`, fontSize: '0.78rem',
              letterSpacing: '0.06em', display: 'flex', justifyContent: 'space-between',
            }}>
              <span style={{ color: GREEN_DIM }}>live market rate</span>
              <span style={{ color: GREEN }}>~{marketRate.toLocaleString()} PKR / USDT</span>
            </div>
          )}
          <div style={{ color: GREEN_DIM, fontSize: '0.72rem', letterSpacing: '0.05em', marginTop: '4px' }}>
            pick a trade, send PKR off-chain, receive USDT on-chain
          </div>
        </div>

        {/* Wallet guard */}
        {!publicKey && (
          <div style={{ border: `1px solid ${GREEN_DIM}`, padding: '12px 16px', marginBottom: '16px', color: GREEN_DIM, fontSize: '0.8rem', letterSpacing: '0.05em' }}>
            {'>'} CONNECT WALLET TO JOIN A TRADE<span className="terminal-cursor"> _</span>
          </div>
        )}

        {/* Error banner */}
        {errorMsg && (
          <div
            style={{ border: `1px solid ${RED}`, padding: '10px 12px', color: RED, fontSize: '0.75rem', marginBottom: '14px', wordBreak: 'break-word', letterSpacing: '0.02em', lineHeight: 1.6 }}
          >
            {errorMsg}
            <button
              onClick={() => setErrorMsg('')}
              style={{ display: 'block', marginTop: '6px', color: RED, background: 'transparent', border: 'none', fontFamily: MONO, fontSize: '0.68rem', cursor: 'pointer', letterSpacing: '0.05em' }}
            >
              [ DISMISS ]
            </button>
          </div>
        )}

        {/* Count + refresh row */}
        {!loading && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
            <span style={{ color: GREEN_DIM, fontSize: '0.72rem', letterSpacing: '0.05em', borderBottom: `1px solid ${GREEN_DIM}`, paddingBottom: '6px', width: '100%' }}>
              {trades.length === 0
                ? '── NO OPEN TRADES ────────────────────────────'
                : `── ${trades.length} OPEN TRADE${trades.length !== 1 ? 'S' : ''} ${'─'.repeat(Math.max(0, 34 - trades.length.toString().length))}`}
            </span>
            <button
              onClick={load}
              className="terminal-menu-btn"
              style={{ flexShrink: 0, marginLeft: '10px', border: `1px solid ${GREEN_DIM}`, color: GREEN_DIM, background: 'transparent', fontFamily: MONO, fontSize: '0.68rem', letterSpacing: '0.08em', padding: '3px 10px', marginBottom: '6px' }}
            >
              [ ↻ ]
            </button>
          </div>
        )}

        {/* States */}
        {loading ? (
          <div style={{ color: GREEN, fontSize: '0.85rem', letterSpacing: '0.06em' }}>
            {'>'} FETCHING OPEN TRADES<span className="terminal-cursor"> _</span>
          </div>
        ) : trades.length === 0 ? (
          <div style={{ color: GREEN_DIM, fontSize: '0.8rem', letterSpacing: '0.04em', lineHeight: 1.8 }}>
            {'>'} NO OPEN TRADES RIGHT NOW<br />
            <span style={{ fontSize: '0.68rem' }}>
              be the first —{' '}
              <Link href="/sell" style={{ color: GREEN, textDecoration: 'underline' }}>
                CREATE A SELL TRADE
              </Link>
            </span>
          </div>
        ) : (
          trades.map(t => <TradeCard key={t.pda} t={t} />)
        )}
      </div>
    </Shell>
  )
}
