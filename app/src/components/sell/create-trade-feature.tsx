'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { WalletButton } from '@/components/solana/solana-provider'
import { SAFE_P2P_ESCROW_PROGRAM_ID, USDT_DECIMALS, USDT_MINT } from '@/lib/constants'

const GREEN     = '#00cc33'
const GREEN_DIM = '#006622'
const RED       = '#cc3300'
const MONO      = "'Courier New', monospace"

// ── Pure-JS u64 helpers (browser Buffer polyfill lacks BigInt methods) ────────

function u64LE(value: bigint): Buffer {
  const bytes: number[] = []
  let v = value
  for (let i = 0; i < 8; i++) {
    bytes.push(Number(v & 0xffn))
    v >>= 8n
  }
  return Buffer.from(bytes)
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  let result = 0n
  for (let i = 7; i >= 0; i--) {
    result = (result << 8n) | BigInt(data[offset + i])
  }
  return result
}

// ── PDA helpers ───────────────────────────────────────────────────────────────

function escrowStatePDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('escrow')],
    SAFE_P2P_ESCROW_PROGRAM_ID,
  )
}

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

// EscrowState layout: 8 disc + 32 admin = offset 40, then u64 trade_counter
async function fetchTradeCounter(connection: Connection): Promise<bigint> {
  const [pda] = escrowStatePDA()
  const info  = await connection.getAccountInfo(pda)
  if (!info) throw new Error('ESCROW NOT INITIALIZED — CONTACT ADMIN')
  return readU64LE(info.data, 40)
}

// ── Instruction builder ───────────────────────────────────────────────────────

function buildCreateTradeIx(
  amountMicro: bigint,
  rate: bigint,
  escrowState: PublicKey,
  tradeAccount: PublicKey,
  vault: PublicKey,
  seller: PublicKey,
  sellerTokenAccount: PublicKey,
  usdtMint: PublicKey,
): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from([183, 82, 24, 245, 248, 30, 204, 246]), // discriminator
    u64LE(amountMicro),
    u64LE(rate),
  ])

  return new TransactionInstruction({
    programId: SAFE_P2P_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: escrowState,             isSigner: false, isWritable: true  },
      { pubkey: tradeAccount,            isSigner: false, isWritable: true  },
      { pubkey: vault,                   isSigner: false, isWritable: true  },
      { pubkey: seller,                  isSigner: true,  isWritable: true  },
      { pubkey: sellerTokenAccount,      isSigner: false, isWritable: true  },
      { pubkey: usdtMint,                isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,        isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  })
}

// ── Shared shell — defined OUTSIDE component so React never remounts it ───────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="terminal-page fixed inset-0 z-50 flex flex-col overflow-auto"
      style={{ background: '#000', fontFamily: MONO }}
    >
      {children}
      <div
        className="shrink-0 px-4 py-2 border-t"
        style={{
          color: GREEN_DIM,
          borderColor: '#0d260d',
          fontSize: '0.7rem',
          letterSpacing: '0.03em',
        }}
      >
        {'>'} safe p2p escrow&nbsp;&nbsp;|&nbsp;&nbsp;devnet&nbsp;&nbsp;|&nbsp;&nbsp;sell / create trade
      </div>
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

type Phase = 'form' | 'signing' | 'success' | 'error'

export function CreateTradeFeature() {
  const { connection }                   = useConnection()
  const { publicKey, sendTransaction }   = useWallet()

  const [phase, setPhase]         = useState<Phase>('form')
  const [amount, setAmount]       = useState('')
  const [rate, setRate]           = useState('')
  const [marketRate, setMarketRate] = useState<number | null>(null)

  useEffect(() => {
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=pkr')
      .then(r => r.json())
      .then(d => setMarketRate(Math.round(d?.tether?.pkr ?? 0)))
      .catch(() => {})
  }, [])
  const [payMethod, setPayMethod] = useState('EasyPaisa')
  const [payAccount, setPayAccount] = useState('')
  const [payName, setPayName]     = useState('')
  const [tradeId, setTradeId]     = useState(0n)
  const [txSig, setTxSig]         = useState('')
  const [errorMsg, setErrorMsg]   = useState('')

  // ── Derived preview values
  const amountNum    = parseFloat(amount) || 0
  const rateNum      = Math.floor(parseFloat(rate) || 0)
  const amountMicro  = BigInt(Math.floor(amountNum * 10 ** USDT_DECIMALS))
  const feeMicro     = (amountMicro * 5n) / 1000n
  const totalMicro   = amountMicro + feeMicro
  const feeDisplay   = Number(feeMicro)   / 10 ** USDT_DECIMALS
  const totalDisplay = Number(totalMicro) / 10 ** USDT_DECIMALS
  const buyerPays    = amountNum * rateNum

  const isValid     = !!publicKey && amountNum >= 10 && rateNum > 0 && !!payAccount.trim()
  const showSummary = amountNum >= 10 && rateNum > 0

  // ── Submit
  async function handleCreate() {
    if (!publicKey || !isValid) return
    setPhase('signing')
    setErrorMsg('')

    try {
      const tradeCounter   = await fetchTradeCounter(connection)
      const [escrowState]  = escrowStatePDA()
      const [tradeAccount] = tradePDA(tradeCounter)
      const [vault]        = vaultPDA(tradeCounter)
      const usdtMint       = new PublicKey(USDT_MINT)
      const sellerAta      = getAssociatedTokenAddressSync(usdtMint, publicKey)

      const ix = buildCreateTradeIx(
        amountMicro,
        BigInt(rateNum),
        escrowState,
        tradeAccount,
        vault,
        publicKey,
        sellerAta,
        usdtMint,
      )

      const tx  = new Transaction().add(ix)
      const sig = await sendTransaction(tx, connection)
      await connection.confirmTransaction(sig, 'confirmed')

      // Save payment info off-chain keyed by trade PDA
      fetch('/api/trade-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pda:     tradeAccount.toBase58(),
          method:  payMethod,
          account: payAccount.trim(),
          name:    payName.trim(),
        }),
      }).catch(() => {}) // non-blocking — don't fail the trade if this fails

      setTradeId(tradeCounter)
      setTxSig(sig)
      setPhase('success')
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e)
      setErrorMsg(raw.length > 200 ? raw.slice(0, 200) + '…' : raw)
      setPhase('error')
    }
  }

  // ── Signing
  if (phase === 'signing') {
    return (
      <Shell>
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <div style={{ color: GREEN, fontSize: 'clamp(0.85rem, 2.5vw, 1rem)', letterSpacing: '0.06em' }}>
            {'>'} CREATING TRADE...
          </div>
          <div style={{ color: GREEN, fontSize: 'clamp(0.85rem, 2.5vw, 1rem)', letterSpacing: '0.06em' }}>
            {'>'} APPROVE IN WALLET<span className="terminal-cursor"> _</span>
          </div>
        </div>
      </Shell>
    )
  }

  // ── Success
  if (phase === 'success') {
    return (
      <Shell>
        <div className="flex justify-end px-6 py-4 shrink-0">
          <WalletButton />
        </div>
        <div
          className="flex-1 flex flex-col px-4 pb-8"
          style={{ maxWidth: '480px', margin: '0 auto', width: '100%' }}
        >
          <div style={{ color: GREEN }}>
            <div style={{ marginBottom: '20px', fontSize: 'clamp(0.9rem, 2.5vw, 1.05rem)', letterSpacing: '0.08em' }}>
              {'>'} TRADE CREATED
            </div>
            <div
              style={{
                border: `1px solid ${GREEN_DIM}`,
                padding: '16px',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                fontSize: 'clamp(0.75rem, 2vw, 0.85rem)',
                letterSpacing: '0.04em',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: GREEN_DIM }}>TRADE ID</span>
                <span style={{ color: '#00ff41' }}>#{tradeId.toString().padStart(7, '0')}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: GREEN_DIM }}>STATUS</span>
                <span>OPEN — AWAITING BUYER</span>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginTop: '6px',
                  paddingTop: '8px',
                  borderTop: `1px solid ${GREEN_DIM}`,
                }}
              >
                <span style={{ color: GREEN_DIM }}>TX</span>
                <span style={{ fontSize: '0.68rem' }}>
                  {txSig.slice(0, 10)}…{txSig.slice(-10)}
                </span>
              </div>
            </div>
            <div style={{ marginTop: '24px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <Link href="/my-trades" style={{ width: '100%' }}>
                <button
                  className="terminal-menu-btn w-full py-3 px-4 border text-center"
                  style={{
                    color: GREEN, borderColor: GREEN, background: 'transparent',
                    fontFamily: MONO, fontSize: 'clamp(0.75rem, 2.5vw, 0.9rem)', letterSpacing: '0.1em',
                  }}
                >
                  [ VIEW MY TRADES ]
                </button>
              </Link>
              <button
                onClick={() => { setPhase('form'); setAmount(''); setRate('') }}
                className="terminal-menu-btn w-full py-3 px-4 border text-center"
                style={{
                  color: GREEN_DIM, borderColor: GREEN_DIM, background: 'transparent',
                  fontFamily: MONO, fontSize: 'clamp(0.75rem, 2.5vw, 0.9rem)', letterSpacing: '0.1em',
                }}
              >
                [ CREATE ANOTHER ]
              </button>
            </div>
          </div>
        </div>
      </Shell>
    )
  }

  // ── Error
  if (phase === 'error') {
    return (
      <Shell>
        <div className="flex justify-between items-center px-6 py-4 shrink-0">
          <Link href="/" style={{ color: GREEN_DIM, fontSize: '0.8rem', letterSpacing: '0.08em', textDecoration: 'none' }}>
            {'<'} BACK
          </Link>
          <WalletButton />
        </div>
        <div
          className="flex-1 flex flex-col px-4 pb-8"
          style={{ maxWidth: '480px', margin: '0 auto', width: '100%' }}
        >
          <div style={{ color: RED, marginBottom: '10px', fontSize: 'clamp(0.85rem, 2.5vw, 1rem)', letterSpacing: '0.06em' }}>
            {'>'} ERROR
          </div>
          <div
            style={{
              border: `1px solid ${RED}`,
              padding: '12px',
              color: RED,
              fontSize: '0.78rem',
              wordBreak: 'break-word',
              letterSpacing: '0.02em',
              lineHeight: 1.6,
            }}
          >
            {errorMsg}
          </div>
          <button
            onClick={() => setPhase('form')}
            className="terminal-menu-btn w-full py-3 px-4 border text-center"
            style={{
              marginTop: '20px', color: GREEN, borderColor: GREEN, background: 'transparent',
              fontFamily: MONO, fontSize: 'clamp(0.75rem, 2.5vw, 0.9rem)', letterSpacing: '0.1em',
            }}
          >
            [ TRY AGAIN ]
          </button>
        </div>
      </Shell>
    )
  }

  // ── Form (default)
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
      <div
        className="flex-1 flex flex-col px-4 pb-8"
        style={{ maxWidth: '480px', margin: '0 auto', width: '100%' }}
      >
        {/* Title */}
        <div style={{ marginBottom: '28px' }}>
          <div style={{ color: GREEN, fontSize: 'clamp(1rem, 3vw, 1.2rem)', letterSpacing: '0.15em' }}>
            {'>'} SELL USDT
          </div>
          <div style={{ color: GREEN_DIM, fontSize: '0.72rem', letterSpacing: '0.05em', marginTop: '5px' }}>
            lock USDT in escrow — collect PKR off-chain
          </div>
        </div>

        {/* Wallet guard */}
        {!publicKey && (
          <div
            style={{
              border: `1px solid ${GREEN_DIM}`,
              padding: '14px 16px',
              marginBottom: '20px',
              color: GREEN_DIM,
              fontSize: '0.8rem',
              letterSpacing: '0.05em',
            }}
          >
            {'>'} CONNECT WALLET TO CONTINUE<span className="terminal-cursor"> _</span>
          </div>
        )}

        {/* Amount */}
        <div style={{ marginBottom: '18px' }}>
          <span style={{ display: 'block', color: GREEN_DIM, fontSize: '0.72rem', letterSpacing: '0.1em', marginBottom: '6px' }}>
            {'>'} AMOUNT (USDT) — MIN 10
          </span>
          <input
            type="number"
            min="10"
            step="1"
            placeholder="100"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            style={{
              background: 'transparent',
              border: `1px solid ${GREEN_DIM}`,
              color: GREEN,
              fontFamily: MONO,
              fontSize: 'clamp(0.85rem, 2.5vw, 0.95rem)',
              padding: '9px 12px',
              width: '100%',
              outline: 'none',
              letterSpacing: '0.05em',
            }}
          />
        </div>

        {/* Rate */}
        <div style={{ marginBottom: '18px' }}>
          <span style={{ display: 'block', color: GREEN_DIM, fontSize: '0.72rem', letterSpacing: '0.1em', marginBottom: '6px' }}>
            {'>'} PKR RATE (per 1 USDT)
          </span>
          {marketRate && (
            <div style={{
              marginBottom: '8px', padding: '6px 10px',
              border: `1px solid ${GREEN_DIM}`, fontSize: '0.78rem',
              letterSpacing: '0.06em', display: 'flex', justifyContent: 'space-between',
            }}>
              <span style={{ color: GREEN_DIM }}>live market rate</span>
              <span style={{ color: GREEN }}>~{marketRate.toLocaleString()} PKR / USDT</span>
            </div>
          )}
          <input
            type="number"
            min="1"
            step="1"
            placeholder="280"
            value={rate}
            onChange={e => setRate(e.target.value)}
            style={{
              background: 'transparent',
              border: `1px solid ${GREEN_DIM}`,
              color: GREEN,
              fontFamily: MONO,
              fontSize: 'clamp(0.85rem, 2.5vw, 0.95rem)',
              padding: '9px 12px',
              width: '100%',
              outline: 'none',
              letterSpacing: '0.05em',
            }}
          />
        </div>

        {/* Payment Method */}
        <div style={{ marginBottom: '18px' }}>
          <span style={{ display: 'block', color: GREEN_DIM, fontSize: '0.72rem', letterSpacing: '0.1em', marginBottom: '6px' }}>
            {'>'} HOW WILL BUYER SEND PKR TO YOU?
          </span>
          <select
            value={payMethod}
            onChange={e => setPayMethod(e.target.value)}
            style={{
              background: '#000',
              border: `1px solid ${GREEN_DIM}`,
              color: GREEN,
              fontFamily: MONO,
              fontSize: 'clamp(0.85rem, 2.5vw, 0.95rem)',
              padding: '9px 12px',
              width: '100%',
              outline: 'none',
              letterSpacing: '0.05em',
              cursor: 'pointer',
            }}
          >
            <option value="EasyPaisa">EasyPaisa</option>
            <option value="JazzCash">JazzCash</option>
            <option value="Bank Transfer">Bank Transfer</option>
            <option value="Raast">Raast</option>
            <option value="Other">Other</option>
          </select>
        </div>

        {/* Account Number */}
        <div style={{ marginBottom: '18px' }}>
          <span style={{ display: 'block', color: GREEN_DIM, fontSize: '0.72rem', letterSpacing: '0.1em', marginBottom: '6px' }}>
            {'>'} YOUR ACCOUNT / PHONE NUMBER *
          </span>
          <input
            type="text"
            placeholder="03001234567"
            value={payAccount}
            onChange={e => setPayAccount(e.target.value)}
            style={{
              background: 'transparent',
              border: `1px solid ${payAccount.trim() ? GREEN_DIM : RED}`,
              color: GREEN,
              fontFamily: MONO,
              fontSize: 'clamp(0.85rem, 2.5vw, 0.95rem)',
              padding: '9px 12px',
              width: '100%',
              outline: 'none',
              letterSpacing: '0.05em',
            }}
          />
        </div>

        {/* Account Name */}
        <div style={{ marginBottom: '18px' }}>
          <span style={{ display: 'block', color: GREEN_DIM, fontSize: '0.72rem', letterSpacing: '0.1em', marginBottom: '6px' }}>
            {'>'} ACCOUNT NAME <span style={{ color: GREEN_DIM, fontSize: '0.65rem' }}>(optional)</span>
          </span>
          <input
            type="text"
            placeholder="Muhammad Ali"
            value={payName}
            onChange={e => setPayName(e.target.value)}
            style={{
              background: 'transparent',
              border: `1px solid ${GREEN_DIM}`,
              color: GREEN,
              fontFamily: MONO,
              fontSize: 'clamp(0.85rem, 2.5vw, 0.95rem)',
              padding: '9px 12px',
              width: '100%',
              outline: 'none',
              letterSpacing: '0.05em',
            }}
          />
        </div>

        {/* Summary */}
        {showSummary && (
          <div style={{ borderTop: `1px solid ${GREEN_DIM}`, paddingTop: '14px', marginBottom: '4px' }}>
            <div style={{ color: GREEN_DIM, fontSize: '0.68rem', letterSpacing: '0.12em', marginBottom: '10px' }}>
              ── TRADE SUMMARY ──────────────────────
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 'clamp(0.72rem, 2vw, 0.82rem)', color: GREEN, padding: '3px 0', letterSpacing: '0.03em' }}>
              <span>AMOUNT</span>
              <span>{amountNum.toFixed(6)} USDT</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 'clamp(0.72rem, 2vw, 0.82rem)', color: GREEN_DIM, padding: '3px 0', letterSpacing: '0.03em' }}>
              <span>FEE (0.5%)</span>
              <span>+ {feeDisplay.toFixed(6)} USDT</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 'clamp(0.72rem, 2vw, 0.85rem)', color: '#00ff41', padding: '6px 0 3px', letterSpacing: '0.03em', borderTop: `1px solid ${GREEN_DIM}`, marginTop: '4px' }}>
              <span>TOTAL LOCKED</span>
              <span>{totalDisplay.toFixed(6)} USDT</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 'clamp(0.72rem, 2vw, 0.82rem)', color: GREEN, padding: '3px 0', letterSpacing: '0.03em', marginTop: '4px' }}>
              <span>BUYER PAYS (OFF-CHAIN)</span>
              <span>{buyerPays.toLocaleString()} PKR</span>
            </div>
          </div>
        )}

        {/* Submit */}
        <div style={{ marginTop: '28px' }}>
          <button
            onClick={handleCreate}
            disabled={!isValid}
            className={isValid ? 'terminal-menu-btn' : ''}
            style={{
              width: '100%',
              padding: '14px',
              border: `1px solid ${isValid ? GREEN : GREEN_DIM}`,
              color: isValid ? GREEN : GREEN_DIM,
              background: 'transparent',
              fontFamily: MONO,
              fontSize: 'clamp(0.8rem, 2.5vw, 0.95rem)',
              letterSpacing: '0.12em',
              cursor: isValid ? 'pointer' : 'default',
              textAlign: 'center',
            }}
          >
            [ CREATE TRADE ]
          </button>
        </div>

        {/* Footnote */}
        <div style={{ marginTop: '18px', color: GREEN_DIM, fontSize: '0.65rem', letterSpacing: '0.03em', lineHeight: 1.7 }}>
          {'>'} USDT + fee locked in on-chain escrow vault.<br />
          {'>'} released to buyer only after you confirm PKR received.<br />
          {'>'} min trade: 10 USDT | fee: 0.5%
        </div>
      </div>
    </Shell>
  )
}
