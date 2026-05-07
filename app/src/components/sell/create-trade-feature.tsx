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

// ── Pure-JS u64 helpers ───────────────────────────────────────────────────────

function u64LE(value: bigint): Buffer {
  const bytes: number[] = []
  let v = value
  for (let i = 0; i < 8; i++) { bytes.push(Number(v & 0xffn)); v >>= 8n }
  return Buffer.from(bytes)
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  let result = 0n
  for (let i = 7; i >= 0; i--) result = (result << 8n) | BigInt(data[offset + i])
  return result
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

async function fetchTradeCounter(connection: Connection): Promise<bigint> {
  const [pda] = escrowStatePDA()
  const info  = await connection.getAccountInfo(pda)
  if (!info) throw new Error('Escrow not initialized — contact admin')
  return readU64LE(info.data, 40)
}

// ── Instruction builder ───────────────────────────────────────────────────────

function buildCreateTradeIx(
  amountMicro: bigint, rate: bigint,
  escrowState: PublicKey, tradeAccount: PublicKey, vault: PublicKey,
  seller: PublicKey, sellerTokenAccount: PublicKey, usdtMint: PublicKey,
): TransactionInstruction {
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
    data: Buffer.concat([Buffer.from([183, 82, 24, 245, 248, 30, 204, 246]), u64LE(amountMicro), u64LE(rate)]),
  })
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
        <span>sell / create trade</span>
      </div>
    </div>
  )
}

// ── Label helper ──────────────────────────────────────────────────────────────

function Label({ text, sub }: { text: string; sub?: string }) {
  return (
    <div style={{ marginBottom: '8px' }}>
      <span style={{ color: '#94a3b8', fontSize: '0.8rem', fontWeight: 500 }}>{text}</span>
      {sub && <span style={{ color: '#475569', fontSize: '0.72rem', marginLeft: '6px' }}>{sub}</span>}
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

type Phase = 'form' | 'signing' | 'success' | 'error'

export function CreateTradeFeature() {
  const { connection }                 = useConnection()
  const { publicKey, sendTransaction } = useWallet()

  const [phase, setPhase]           = useState<Phase>('form')
  const [amount, setAmount]         = useState('')
  const [rate, setRate]             = useState('')
  const [marketRate, setMarketRate] = useState<number | null>(null)
  const [payMethod, setPayMethod]   = useState('EasyPaisa')
  const [payAccount, setPayAccount] = useState('')
  const [payName, setPayName]       = useState('')
  const [tradeId, setTradeId]       = useState(0n)
  const [txSig, setTxSig]           = useState('')
  const [errorMsg, setErrorMsg]     = useState('')
  const [faucetState, setFaucetState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [faucetError, setFaucetError] = useState('')

  async function handleFaucet() {
    if (!publicKey) return
    setFaucetState('loading')
    setFaucetError('')
    try {
      const res = await fetch('/api/faucet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: publicKey.toBase58() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? JSON.stringify(data))
      setFaucetState('done')
    } catch (e: unknown) {
      setFaucetError(e instanceof Error ? e.message : String(e))
      setFaucetState('error')
    }
  }

  useEffect(() => {
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=pkr')
      .then(r => r.json())
      .then(d => setMarketRate(Math.round(d?.tether?.pkr ?? 0)))
      .catch(() => {})
  }, [])

  const amountNum    = parseFloat(amount) || 0
  const rateNum      = Math.floor(parseFloat(rate) || 0)
  const amountMicro  = BigInt(Math.floor(amountNum * 10 ** USDT_DECIMALS))
  const feeMicro     = (amountMicro * 5n) / 1000n
  const totalMicro   = amountMicro + feeMicro
  const feeDisplay   = Number(feeMicro)   / 10 ** USDT_DECIMALS
  const totalDisplay = Number(totalMicro) / 10 ** USDT_DECIMALS
  const buyerPays    = amountNum * rateNum

  // Rate validation — block if more than 5% below live market rate
  const rateBelowFloor = marketRate !== null && rateNum > 0 && rateNum < Math.round(marketRate * 0.95)
  const rateWarning    = marketRate !== null && rateNum > 0 && rateNum < marketRate && !rateBelowFloor

  // Account number validation
  function getAccountError(): string {
    if (!payAccount.trim()) return ''
    if (payMethod === 'EasyPaisa' || payMethod === 'JazzCash') {
      const digits = payAccount.replace(/\D/g, '')
      if (!digits.startsWith('03')) return `${payMethod} number must start with 03`
      if (digits.length !== 11)     return `${payMethod} number must be exactly 11 digits (e.g. 03001234567) — you entered ${digits.length}`
    } else if (payMethod === 'Bank Transfer' || payMethod === 'Raast') {
      if (payAccount.trim().length < 5) return 'Please enter a valid account number (min 5 characters)'
    }
    return ''
  }
  const accountError = getAccountError()

  const isValid     = !!publicKey && amountNum >= 10 && rateNum > 0 && !!payAccount.trim() && !rateBelowFloor && !accountError
  const showSummary = amountNum >= 10 && rateNum > 0

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

      const ix  = buildCreateTradeIx(amountMicro, BigInt(rateNum), escrowState, tradeAccount, vault, publicKey, sellerAta, usdtMint)
      const tx  = new Transaction().add(ix)
      const sig = await sendTransaction(tx, connection)
      await connection.confirmTransaction(sig, 'confirmed')

      fetch('/api/trade-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pda: tradeAccount.toBase58(), method: payMethod, account: payAccount.trim(), name: payName.trim() }),
      }).catch(() => {})

      setTradeId(tradeCounter)
      setTxSig(sig)
      setPhase('success')
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e)
      setErrorMsg(raw.length > 200 ? raw.slice(0, 200) + '…' : raw)
      setPhase('error')
    }
  }

  // ── Signing state ─────────────────────────────────────────────────────────

  if (phase === 'signing') {
    return (
      <Shell>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', position: 'relative', zIndex: 1 }}>
          <div style={{ width: 48, height: 48, borderRadius: '50%', border: '3px solid rgba(168,85,247,0.2)', borderTopColor: '#a855f7', animation: 'spin 0.8s linear infinite' }} />
          <div style={{ color: '#94a3b8', fontSize: '0.9rem' }}>Creating trade…</div>
          <div style={{ color: '#475569', fontSize: '0.78rem' }}>Approve in your wallet</div>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </Shell>
    )
  }

  // ── Success state ─────────────────────────────────────────────────────────

  if (phase === 'success') {
    return (
      <Shell>
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '16px 24px', flexShrink: 0, zIndex: 2, position: 'relative', borderBottom: '1px solid var(--defi-border)' }}>
          <WalletButton />
        </div>
        <div className="defi-body" style={{ padding: '24px' }}>
          <div style={{ maxWidth: '480px', margin: '0 auto', width: '100%' }}>

            <div style={{ textAlign: 'center', marginBottom: '28px' }}>
              <div style={{ fontSize: '2.5rem', marginBottom: '10px' }}>✅</div>
              <h2 style={{ color: '#fff', fontWeight: 700, fontSize: '1.3rem', margin: 0 }}>Trade Created</h2>
              <p style={{ color: '#64748b', fontSize: '0.82rem', marginTop: '6px' }}>Your USDT is locked in escrow and visible to buyers</p>
            </div>

            <div className="glass-card-sm" style={{ padding: '20px', marginBottom: '20px' }}>
              <div className="defi-row">
                <span style={{ color: 'var(--defi-text-mute)', fontSize: '0.82rem' }}>Trade ID</span>
                <span style={{ color: '#60a5fa', fontFamily: 'monospace', fontSize: '0.82rem' }}>
                  #{tradeId.toString().padStart(7, '0')}
                </span>
              </div>
              <div className="defi-row">
                <span style={{ color: 'var(--defi-text-mute)', fontSize: '0.82rem' }}>Status</span>
                <span className="badge badge-open">Open — awaiting buyer</span>
              </div>
              <div className="defi-row">
                <span style={{ color: 'var(--defi-text-mute)', fontSize: '0.82rem' }}>Transaction</span>
                <a
                  href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`}
                  target="_blank" rel="noopener noreferrer"
                  style={{ color: '#a78bfa', fontSize: '0.75rem', textDecoration: 'none' }}
                >
                  {txSig.slice(0, 8)}…{txSig.slice(-8)} ↗
                </a>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <Link href="/my-trades" style={{ textDecoration: 'none' }}>
                <button className="btn-gradient" style={{ width: '100%', padding: '13px', fontSize: '0.9rem' }}>
                  View My Trades
                </button>
              </Link>
              <button
                onClick={() => { setPhase('form'); setAmount(''); setRate(''); setPayAccount(''); setPayName('') }}
                className="btn-outline-defi"
                style={{ width: '100%', padding: '13px', fontSize: '0.9rem' }}
              >
                Create Another Trade
              </button>
            </div>
          </div>
        </div>
      </Shell>
    )
  }

  // ── Error state ───────────────────────────────────────────────────────────

  if (phase === 'error') {
    return (
      <Shell>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px', flexShrink: 0, zIndex: 2, position: 'relative', borderBottom: '1px solid var(--defi-border)' }}>
          <Link href="/" style={{ color: '#475569', fontSize: '0.85rem', textDecoration: 'none' }}>← Back</Link>
          <WalletButton />
        </div>
        <div className="defi-body" style={{ padding: '24px' }}>
          <div style={{ maxWidth: '480px', margin: '0 auto', width: '100%' }}>
            <div style={{ textAlign: 'center', marginBottom: '20px' }}>
              <div style={{ fontSize: '2rem', marginBottom: '8px' }}>⚠️</div>
              <h2 style={{ color: '#ef4444', fontWeight: 600, fontSize: '1.1rem', margin: 0 }}>Transaction Failed</h2>
            </div>
            <div className="defi-alert-error" style={{ marginBottom: '20px', wordBreak: 'break-word' }}>{errorMsg}</div>
            <button onClick={() => setPhase('form')} className="btn-gradient" style={{ width: '100%', padding: '13px' }}>
              Try Again
            </button>
          </div>
        </div>
      </Shell>
    )
  }

  // ── Form ──────────────────────────────────────────────────────────────────

  return (
    <Shell>
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '16px 24px', flexShrink: 0, zIndex: 2, position: 'relative',
        borderBottom: '1px solid var(--defi-border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <Link href="/" style={{ color: '#475569', fontSize: '0.85rem', textDecoration: 'none' }}>← Back</Link>
          <span style={{ color: '#475569' }}>|</span>
          <span style={{ color: '#fff', fontWeight: 600, fontSize: '0.9rem' }}>Sell USDT</span>
        </div>
        <WalletButton />
      </div>

      {/* Body */}
      <div className="defi-body" style={{ padding: '24px' }}>
        <div style={{ maxWidth: '480px', margin: '0 auto', width: '100%' }}>

          <p style={{ color: '#64748b', fontSize: '0.82rem', marginBottom: '16px' }}>
            Lock USDT in on-chain escrow · collect PKR from the buyer off-chain
          </p>

          {/* Devnet faucet */}
          {publicKey && (
            <div style={{
              marginBottom: '20px', padding: '12px 16px', borderRadius: 10,
              background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.18)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            }}>
              <div>
                <div style={{ color: '#34d399', fontSize: '0.75rem', fontWeight: 600, marginBottom: 2 }}>
                  Devnet Faucet
                </div>
                <div style={{ color: '#475569', fontSize: '0.72rem' }}>
                  Need test USDT? Get 1,000 USDT sent to your wallet instantly.
                </div>
              </div>
              {faucetState === 'done' ? (
                <span style={{ color: '#10b981', fontSize: '0.78rem', fontWeight: 600, whiteSpace: 'nowrap' }}>✓ 1000 USDT sent</span>
              ) : faucetState === 'error' ? (
                <div style={{ textAlign: 'right' }}>
                  <button
                    onClick={() => { setFaucetState('idle'); setFaucetError('') }}
                    style={{
                      background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
                      color: '#f87171', borderRadius: 8, padding: '7px 14px',
                      fontSize: '0.75rem', cursor: 'pointer', whiteSpace: 'nowrap',
                    }}
                  >
                    Failed — Retry
                  </button>
                  {faucetError && (
                    <div style={{ color: '#ef4444', fontSize: '0.68rem', marginTop: 4, maxWidth: 200, wordBreak: 'break-word' }}>
                      {faucetError}
                    </div>
                  )}
                </div>
              ) : (
                <button
                  onClick={handleFaucet}
                  disabled={faucetState === 'loading'}
                  style={{
                    background: 'linear-gradient(135deg,#10b981,#059669)',
                    color: '#fff', border: 'none', borderRadius: 8,
                    padding: '7px 16px', fontSize: '0.78rem', fontWeight: 600,
                    cursor: faucetState === 'loading' ? 'not-allowed' : 'pointer',
                    whiteSpace: 'nowrap', opacity: faucetState === 'loading' ? 0.6 : 1,
                  }}
                >
                  {faucetState === 'loading' ? 'Sending…' : 'Get 1000 USDT'}
                </button>
              )}
            </div>
          )}

          {/* Wallet guard */}
          {!publicKey && (
            <div className="glass-card-sm" style={{ padding: '16px', marginBottom: '20px', textAlign: 'center', color: '#64748b', fontSize: '0.85rem' }}>
              Connect your wallet to continue
            </div>
          )}

          <div className="glass-card" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>

            {/* Amount */}
            <div>
              <Label text="Amount (USDT)" sub="min 10" />
              <input
                type="number" min="10" step="1" placeholder="100"
                value={amount} onChange={e => setAmount(e.target.value)}
                className="defi-input"
              />
            </div>

            {/* Rate */}
            <div>
              <Label text="PKR Rate" sub="per 1 USDT" />
              {marketRate && (
                <div style={{
                  marginBottom: '8px', display: 'flex', justifyContent: 'space-between',
                  alignItems: 'center', padding: '8px 12px', borderRadius: '8px',
                  background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.15)',
                }}>
                  <span style={{ color: '#475569', fontSize: '0.76rem' }}>Live market rate</span>
                  <span style={{ color: '#10b981', fontSize: '0.82rem', fontWeight: 600 }}>
                    ~{marketRate.toLocaleString()} PKR / USDT
                  </span>
                </div>
              )}
              <input
                type="number" min="1" step="1" placeholder="280"
                value={rate} onChange={e => setRate(e.target.value)}
                className="defi-input"
                style={{ borderColor: rateBelowFloor ? 'rgba(239,68,68,0.6)' : rateWarning ? 'rgba(245,158,11,0.5)' : undefined }}
              />
              {rateBelowFloor && marketRate && (
                <div style={{ marginTop: 6, padding: '8px 12px', borderRadius: 8, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171', fontSize: '0.76rem' }}>
                  ⚠ Rate is more than 5% below live market price ({marketRate.toLocaleString()} PKR/USDT). Correct the rate to proceed.
                </div>
              )}
              {rateWarning && marketRate && (
                <div style={{ marginTop: 6, padding: '8px 12px', borderRadius: 8, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', color: '#fbbf24', fontSize: '0.76rem' }}>
                  Your rate is slightly below market ({marketRate.toLocaleString()} PKR/USDT) — buyers will prefer it, but double-check this is intentional.
                </div>
              )}
            </div>

            {/* Divider */}
            <div style={{ borderTop: '1px solid var(--defi-border)', margin: '0 -24px', padding: '0 24px' }} />

            {/* Payment method */}
            <div>
              <Label text="How will buyer send PKR?" />
              <select value={payMethod} onChange={e => setPayMethod(e.target.value)} className="defi-select">
                <option value="EasyPaisa">EasyPaisa</option>
                <option value="JazzCash">JazzCash</option>
                <option value="Bank Transfer">Bank Transfer</option>
                <option value="Raast">Raast</option>
                <option value="Other">Other</option>
              </select>
            </div>

            {/* Account number */}
            <div>
              <Label
                text="Your account / phone number"
                sub={
                  payMethod === 'EasyPaisa' || payMethod === 'JazzCash'
                    ? '11-digit mobile number'
                    : 'required'
                }
              />
              <input
                type="text" placeholder={
                  payMethod === 'EasyPaisa' || payMethod === 'JazzCash'
                    ? '03001234567'
                    : payMethod === 'Bank Transfer' ? 'Account number'
                    : 'Account / ID'
                }
                value={payAccount} onChange={e => setPayAccount(e.target.value)}
                className="defi-input"
                style={{ borderColor: accountError ? 'rgba(239,68,68,0.6)' : payAccount.trim() ? undefined : 'rgba(239,68,68,0.4)' }}
              />
              {accountError && (
                <div style={{ marginTop: 6, padding: '8px 12px', borderRadius: 8, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171', fontSize: '0.76rem' }}>
                  ⚠ {accountError}
                </div>
              )}
            </div>

            {/* Account name */}
            <div>
              <Label text="Account name" sub="optional" />
              <input
                type="text" placeholder="Muhammad Ali"
                value={payName} onChange={e => setPayName(e.target.value)}
                className="defi-input"
              />
            </div>

            {/* Summary */}
            {showSummary && (
              <div style={{
                background: 'rgba(255,255,255,0.03)', borderRadius: '10px',
                border: '1px solid var(--defi-border)', padding: '14px 16px',
              }}>
                <div style={{ color: '#64748b', fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '10px' }}>
                  Trade Summary
                </div>
                <div className="defi-row" style={{ padding: '5px 0' }}>
                  <span style={{ color: '#64748b', fontSize: '0.82rem' }}>Amount</span>
                  <span style={{ color: '#fff', fontSize: '0.82rem' }}>{amountNum.toFixed(2)} USDT</span>
                </div>
                <div className="defi-row" style={{ padding: '5px 0' }}>
                  <span style={{ color: '#64748b', fontSize: '0.82rem' }}>Fee (0.5%)</span>
                  <span style={{ color: '#f59e0b', fontSize: '0.82rem' }}>+{feeDisplay.toFixed(4)} USDT</span>
                </div>
                <div style={{ borderTop: '1px solid var(--defi-border)', marginTop: '6px', paddingTop: '8px' }}>
                  <div className="defi-row">
                    <span style={{ color: '#94a3b8', fontSize: '0.85rem', fontWeight: 600 }}>Total locked</span>
                    <span style={{ color: '#a78bfa', fontSize: '0.9rem', fontWeight: 700 }}>{totalDisplay.toFixed(4)} USDT</span>
                  </div>
                  <div className="defi-row" style={{ marginTop: '2px' }}>
                    <span style={{ color: '#64748b', fontSize: '0.82rem' }}>Buyer pays (off-chain)</span>
                    <span style={{ color: '#10b981', fontSize: '0.82rem', fontWeight: 600 }}>{buyerPays.toLocaleString()} PKR</span>
                  </div>
                </div>
              </div>
            )}

            {/* Submit */}
            <button
              onClick={handleCreate}
              disabled={!isValid}
              className={isValid ? 'btn-gradient' : 'btn-outline-defi'}
              style={{ width: '100%', padding: '14px', fontSize: '0.95rem' }}
            >
              {!publicKey ? 'Connect wallet first' : !isValid ? 'Fill all fields to continue' : 'Create Trade'}
            </button>

            {isValid && (
              <p style={{ color: '#334155', fontSize: '0.7rem', textAlign: 'center', lineHeight: 1.6, margin: 0 }}>
                USDT + fee locked in escrow vault on-chain.<br />
                Released to buyer only after you confirm PKR received.
              </p>
            )}
          </div>
        </div>
      </div>
    </Shell>
  )
}
