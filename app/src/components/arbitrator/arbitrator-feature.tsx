'use client'

import { useCallback, useEffect, useState } from 'react'
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

const NULL_PUBKEY  = '11111111111111111111111111111111'
const STAKE_AMOUNT = 50

// ── Pure-JS u64 helpers ───────────────────────────────────────────────────────

function readU64LE(data: Uint8Array, offset: number): bigint {
  let r = 0n
  for (let i = 7; i >= 0; i--) r = (r << 8n) | BigInt(data[offset + i])
  return r
}

function u64LE(value: bigint): Buffer {
  const buf = Buffer.alloc(8)
  for (let i = 0; i < 8; i++) { buf[i] = Number(value & 0xffn); value >>= 8n }
  return buf
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface EscrowInfo {
  arbitrators: string[]
  balances: bigint[]
}

interface DisputeInfo {
  disputeId: bigint
  tradeId: bigint
  raisedBy: string
  votesForBuyer: number
  votesForSeller: number
  voters: string[]
  disputePda: PublicKey
  tradePda: PublicKey
}

// ── PDA helpers ───────────────────────────────────────────────────────────────

function escrowStatePDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('escrow')], SAFE_P2P_ESCROW_PROGRAM_ID)
}

function arbVaultPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('arb_vault')], SAFE_P2P_ESCROW_PROGRAM_ID)
}

function tradePDA(tradeId: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('trade'), u64LE(tradeId)], SAFE_P2P_ESCROW_PROGRAM_ID,
  )
}

function disputePDA(disputeId: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('dispute'), u64LE(disputeId)], SAFE_P2P_ESCROW_PROGRAM_ID,
  )
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function _fetchEscrowInfo(connection: any): Promise<EscrowInfo> {
  const [pda] = escrowStatePDA()
  const info  = await connection.getAccountInfo(pda)
  if (!info) throw new Error('Escrow not initialized')

  const d = info.data as Buffer
  const arbitrators: string[] = []
  const balances: bigint[]    = []

  for (let i = 0; i < 3; i++) {
    arbitrators.push(new PublicKey(d.slice(56 + i * 32, 88 + i * 32)).toBase58())
    balances.push(readU64LE(d, 152 + i * 8))
  }

  return { arbitrators, balances }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchDisputes(connection: any): Promise<DisputeInfo[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accounts: any[] = await connection.getProgramAccounts(SAFE_P2P_ESCROW_PROGRAM_ID, {
    filters: [{ dataSize: 164 }],
  })
  return accounts
    .filter(({ account }: { account: { data: Buffer } }) => account.data[58] === 0)
    .map(({ account }: { account: { data: Buffer } }) => {
      const d = account.data
      const disputeId = readU64LE(d, 8)
      const tradeId   = readU64LE(d, 16)
      const [dpda] = disputePDA(disputeId)
      const [tpda] = tradePDA(tradeId)
      return {
        disputeId,
        tradeId,
        raisedBy:       new PublicKey(d.slice(24, 56)).toBase58(),
        votesForBuyer:  d[56],
        votesForSeller: d[57],
        voters: [
          new PublicKey(d.slice(67,  99)).toBase58(),
          new PublicKey(d.slice(99,  131)).toBase58(),
          new PublicKey(d.slice(131, 163)).toBase58(),
        ],
        disputePda: dpda,
        tradePda:   tpda,
      }
    })
}

// ── Instruction builders ──────────────────────────────────────────────────────

function buildStakeIx(
  candidate: PublicKey,
  candidateTokenAccount: PublicKey,
  escrowState: PublicKey,
  arbitratorVault: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: SAFE_P2P_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: escrowState,           isSigner: false, isWritable: true  },
      { pubkey: candidate,             isSigner: true,  isWritable: true  },
      { pubkey: candidateTokenAccount, isSigner: false, isWritable: true  },
      { pubkey: arbitratorVault,       isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,      isSigner: false, isWritable: false },
    ],
    data: Buffer.from([134, 217, 193, 186, 254, 144, 116, 236]),
  })
}

function buildWithdrawIx(
  arbitrator: PublicKey,
  arbitratorTokenAccount: PublicKey,
  escrowState: PublicKey,
  arbitratorVault: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: SAFE_P2P_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: escrowState,            isSigner: false, isWritable: true  },
      { pubkey: arbitratorVault,        isSigner: false, isWritable: true  },
      { pubkey: arbitratorTokenAccount, isSigner: false, isWritable: true  },
      { pubkey: arbitrator,             isSigner: true,  isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,       isSigner: false, isWritable: false },
    ],
    data: Buffer.from([237, 232, 253, 224, 99, 213, 37, 2]),
  })
}

function buildRemoveIx(
  arbitratorPk: PublicKey,
  arbitratorTokenAccount: PublicKey,
  caller: PublicKey,
  escrowState: PublicKey,
  arbitratorVault: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: SAFE_P2P_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: escrowState,            isSigner: false, isWritable: true  },
      { pubkey: arbitratorVault,        isSigner: false, isWritable: true  },
      { pubkey: arbitratorPk,           isSigner: false, isWritable: false },
      { pubkey: arbitratorTokenAccount, isSigner: false, isWritable: true  },
      { pubkey: caller,                 isSigner: true,  isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,       isSigner: false, isWritable: false },
    ],
    data: Buffer.from([177, 100, 82, 152, 42, 54, 58, 95]),
  })
}

// ── Slot card ─────────────────────────────────────────────────────────────────

function SlotCard({
  slotIndex, occupant, balance, wallet, acting,
  onStake, onWithdraw, onLeave,
}: {
  slotIndex: number
  occupant: string
  balance: bigint
  wallet: string
  acting: boolean
  onStake: () => void
  onWithdraw: () => void
  onLeave: () => void
}) {
  const isEmpty   = occupant === NULL_PUBKEY
  const isYours   = !isEmpty && occupant === wallet
  const isOther   = !isEmpty && !isYours
  const earned    = (Number(balance) / 10 ** USDT_DECIMALS).toFixed(4)
  const hasEarned = balance > 0n

  return (
    <div className="glass-card-sm" style={{
      padding: '16px', marginBottom: 10,
      opacity: acting ? 0.6 : 1, transition: 'opacity 0.2s',
      borderColor: isYours ? 'rgba(124,58,237,0.35)' : isOther ? 'rgba(245,158,11,0.2)' : 'rgba(255,255,255,0.06)',
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ color: '#64748b', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.1em' }}>
          SLOT {slotIndex + 1}
        </span>
        {isEmpty ? (
          <span style={{
            fontSize: '0.65rem', fontWeight: 600, padding: '2px 8px', borderRadius: 5,
            background: 'rgba(16,185,129,0.1)', color: '#10b981', border: '1px solid rgba(16,185,129,0.2)',
          }}>OPEN</span>
        ) : isYours ? (
          <span style={{
            fontSize: '0.65rem', fontWeight: 600, padding: '2px 8px', borderRadius: 5,
            background: 'rgba(124,58,237,0.15)', color: '#a78bfa', border: '1px solid rgba(124,58,237,0.3)',
          }}>YOU</span>
        ) : (
          <span style={{
            fontSize: '0.65rem', fontWeight: 600, padding: '2px 8px', borderRadius: 5,
            background: 'rgba(245,158,11,0.1)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.2)',
          }}>OCCUPIED</span>
        )}
      </div>

      {/* Info */}
      {!isEmpty && (
        <>
          <div className="defi-row">
            <span style={{ color: '#64748b' }}>Arbitrator</span>
            <span style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: isYours ? '#c4b5fd' : '#94a3b8' }}>
              {occupant.slice(0, 8)}…{occupant.slice(-8)}
            </span>
          </div>
          <div className="defi-row">
            <span style={{ color: '#64748b' }}>Earned</span>
            <span style={{ color: hasEarned ? '#10b981' : '#334155', fontWeight: hasEarned ? 600 : 400 }}>
              {earned} USDT
            </span>
          </div>
        </>
      )}

      {/* Actions */}
      <div style={{ marginTop: isEmpty ? 0 : 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {acting && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#f59e0b', fontSize: '0.8rem' }}>
            <span style={{
              width: 13, height: 13, borderRadius: '50%',
              border: '2px solid rgba(245,158,11,0.3)', borderTopColor: '#f59e0b',
              display: 'inline-block', animation: 'spin 0.8s linear infinite',
            }} />
            Processing…
          </div>
        )}

        {!acting && isEmpty && wallet && (
          <button
            className="btn-gradient"
            onClick={onStake}
            style={{ fontSize: '0.82rem', padding: '7px 16px', border: 'none', cursor: 'pointer' }}
          >
            Stake {STAKE_AMOUNT} USDT → Claim Slot
          </button>
        )}

        {!acting && isEmpty && !wallet && (
          <span style={{ color: '#334155', fontSize: '0.75rem' }}>Connect wallet to stake</span>
        )}

        {!acting && isYours && hasEarned && (
          <button
            onClick={onWithdraw}
            style={{
              fontSize: '0.82rem', padding: '7px 14px', borderRadius: 8, cursor: 'pointer',
              background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)',
              color: '#10b981', fontWeight: 600,
            }}
          >
            Withdraw Earnings
          </button>
        )}

        {!acting && isYours && (
          <button
            onClick={onLeave}
            style={{
              fontSize: '0.82rem', padding: '7px 14px', borderRadius: 8, cursor: 'pointer',
              background: 'rgba(100,116,139,0.06)', border: '1px solid rgba(100,116,139,0.2)',
              color: '#64748b', fontWeight: 600,
            }}
          >
            Leave Slot
          </button>
        )}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function ArbitratorFeature() {
  const { connection }                 = useConnection()
  const { publicKey, sendTransaction } = useWallet()

  const [info, setInfo]             = useState<EscrowInfo | null>(null)
  const [disputes, setDisputes]     = useState<DisputeInfo[]>([])
  const [loading, setLoading]       = useState(false)
  const [actingSlot, setActingSlot] = useState<number | null>(null)
  const [errorMsg, setErrorMsg]     = useState('')
  const [successMsg, setSuccessMsg] = useState('')
  const [txSig, setTxSig]           = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setErrorMsg('')
    try {
      const [result, disp] = await Promise.all([
        _fetchEscrowInfo(connection),
        fetchDisputes(connection),
      ])
      setInfo(result)
      setDisputes(disp)
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [connection])

  useEffect(() => { load() }, [load])

  async function withAction(slotIndex: number, fn: () => Promise<void>) {
    setActingSlot(slotIndex)
    setErrorMsg('')
    setSuccessMsg('')
    setTxSig('')
    try {
      await fn()
      await load()
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e)
      setErrorMsg(raw.length > 200 ? raw.slice(0, 200) + '…' : raw)
    } finally {
      setActingSlot(null)
    }
  }

  async function handleStake(slotIndex: number) {
    if (!publicKey) return
    await withAction(slotIndex, async () => {
      const [escrowState]     = escrowStatePDA()
      const [arbitratorVault] = arbVaultPDA()
      const usdtMint          = new PublicKey(USDT_MINT)
      const candidateAta      = getAssociatedTokenAddressSync(usdtMint, publicKey)
      const tx = new Transaction()
      const ataInfo = await connection.getAccountInfo(candidateAta)
      if (!ataInfo) tx.add(createAssociatedTokenAccountInstruction(publicKey, candidateAta, publicKey, usdtMint))
      tx.add(buildStakeIx(publicKey, candidateAta, escrowState, arbitratorVault))
      const sig = await sendTransaction(tx, connection)
      await connection.confirmTransaction(sig, 'confirmed')
      setTxSig(sig)
      setSuccessMsg(`Slot ${slotIndex + 1} claimed — you are now an arbitrator`)
    })
  }

  async function handleWithdraw(slotIndex: number) {
    if (!publicKey) return
    await withAction(slotIndex, async () => {
      const [escrowState]     = escrowStatePDA()
      const [arbitratorVault] = arbVaultPDA()
      const arbitratorAta     = getAssociatedTokenAddressSync(new PublicKey(USDT_MINT), publicKey)
      const tx = new Transaction()
      tx.add(buildWithdrawIx(publicKey, arbitratorAta, escrowState, arbitratorVault))
      const sig = await sendTransaction(tx, connection)
      await connection.confirmTransaction(sig, 'confirmed')
      setTxSig(sig)
      setSuccessMsg('Earnings withdrawn to your wallet')
    })
  }

  async function handleLeave(slotIndex: number) {
    if (!publicKey) return
    await withAction(slotIndex, async () => {
      const [escrowState]     = escrowStatePDA()
      const [arbitratorVault] = arbVaultPDA()
      const arbitratorAta     = getAssociatedTokenAddressSync(new PublicKey(USDT_MINT), publicKey)
      const tx = new Transaction()
      tx.add(buildRemoveIx(publicKey, arbitratorAta, publicKey, escrowState, arbitratorVault))
      const sig = await sendTransaction(tx, connection)
      await connection.confirmTransaction(sig, 'confirmed')
      setTxSig(sig)
      setSuccessMsg(`Slot ${slotIndex + 1} freed — stake returned to your wallet`)
    })
  }

  const wallet       = publicKey?.toBase58() ?? ''
  const slotsCount   = info?.arbitrators.filter(a => a !== NULL_PUBKEY).length ?? 0
  const yourSlot     = info?.arbitrators.findIndex(a => a === wallet) ?? -1
  const isArbitrator = yourSlot >= 0
  const pendingVotes = disputes.filter(d => wallet && !d.voters.includes(wallet))

  return (
    <div className="defi-page">

      {/* Top bar */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '16px 24px', flexShrink: 0, zIndex: 2,
        borderBottom: '1px solid rgba(255,255,255,0.05)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link href="/" style={{ color: '#475569', fontSize: '0.82rem', textDecoration: 'none' }}>
            ← Back
          </Link>
          <span style={{ color: 'rgba(255,255,255,0.1)' }}>|</span>
          <span style={{ color: '#fff', fontWeight: 600, fontSize: '0.88rem' }}>Become Arbitrator</span>
        </div>
        <WalletButton />
      </div>

      {/* Body */}
      <div className="defi-body">
        <div style={{ maxWidth: 520, margin: '0 auto', padding: '24px 20px 60px', width: '100%' }}>

          {/* Hero tagline */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ color: '#94a3b8', fontSize: '0.85rem', lineHeight: 1.6 }}>
              Stake {STAKE_AMOUNT} USDT · secure the network · earn dispute fees
            </div>
          </div>

          {/* Arbitrator status banner */}
          {isArbitrator && (
            <div style={{
              background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.25)',
              borderRadius: 10, padding: '12px 16px', marginBottom: 20,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div>
                <div style={{ color: '#a78bfa', fontWeight: 600, fontSize: '0.88rem' }}>
                  ⚖ You are Arbitrator · Slot {yourSlot + 1}
                </div>
                <div style={{ color: '#64748b', fontSize: '0.75rem', marginTop: 3 }}>
                  {pendingVotes.length > 0
                    ? `${pendingVotes.length} dispute${pendingVotes.length > 1 ? 's' : ''} waiting for your vote`
                    : 'No pending disputes — all clear'
                  }
                </div>
              </div>
              {pendingVotes.length > 0 && (
                <Link href="/arbitrate" style={{ textDecoration: 'none' }}>
                  <button className="btn-gradient" style={{
                    fontSize: '0.78rem', padding: '6px 14px', border: 'none', cursor: 'pointer', flexShrink: 0,
                  }}>
                    Vote Now →
                  </button>
                </Link>
              )}
            </div>
          )}

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
              <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: 4 }}>⚠ Error</div>
              <div style={{ fontSize: '0.75rem', wordBreak: 'break-word' }}>{errorMsg}</div>
            </div>
          )}

          {/* Slots header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ color: '#475569', fontSize: '0.8rem' }}>
              Arbitrator Slots ({slotsCount}/3 filled)
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

          {/* Slot cards */}
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#64748b', padding: '16px 0' }}>
              <span style={{
                width: 14, height: 14, borderRadius: '50%',
                border: '2px solid rgba(168,85,247,0.3)', borderTopColor: '#a855f7',
                display: 'inline-block', animation: 'spin 0.8s linear infinite',
              }} />
              Loading…
            </div>
          ) : info ? (
            info.arbitrators.map((occupant, i) => (
              <SlotCard
                key={i}
                slotIndex={i}
                occupant={occupant}
                balance={info.balances[i]}
                wallet={wallet}
                acting={actingSlot === i}
                onStake={() => handleStake(i)}
                onWithdraw={() => handleWithdraw(i)}
                onLeave={() => handleLeave(i)}
              />
            ))
          ) : null}

          {/* Dispute panel link for arbitrators */}
          {isArbitrator && !loading && (
            <div style={{ marginTop: 24 }}>
              <Link href="/arbitrate" style={{ textDecoration: 'none' }}>
                <button
                  style={{
                    width: '100%', fontSize: '0.88rem', padding: '11px',
                    borderRadius: 10, cursor: 'pointer',
                    background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)',
                    color: '#f59e0b', fontWeight: 600,
                  }}
                >
                  ⚖ Go to Dispute Panel →
                </button>
              </Link>
            </div>
          )}

          {/* How it works */}
          <div className="glass-card" style={{ padding: '16px 20px', marginTop: 28 }}>
            <div style={{ color: '#475569', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.08em', marginBottom: 12 }}>
              HOW IT WORKS
            </div>
            {[
              `Stake ${STAKE_AMOUNT} USDT to claim an empty slot`,
              'When a trade is disputed, vote Buyer Won or Seller Won',
              '2/3 majority wins — 1% of trade value goes to voting arbitrators',
              'Withdraw your earnings anytime while keeping your slot',
              `Leave at any time — your ${STAKE_AMOUNT} USDT stake is returned`,
            ].map((line, i) => (
              <div key={i} style={{ color: '#475569', fontSize: '0.78rem', lineHeight: 1.9, display: 'flex', gap: 8 }}>
                <span style={{ color: '#334155', flexShrink: 0 }}>→</span>
                <span>{line}</span>
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
      }}>
        <span style={{ color: '#475569', fontSize: '0.68rem', fontFamily: 'monospace' }}>SafeP2P</span>
        <span style={{ color: '#475569', fontSize: '0.68rem' }}>devnet · arbitrator panel</span>
      </div>
    </div>
  )
}
