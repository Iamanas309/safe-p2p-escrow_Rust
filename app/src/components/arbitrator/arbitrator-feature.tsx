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

const GREEN     = '#00cc33'
const GREEN_DIM = '#006622'
const RED       = '#cc3300'
const YELLOW    = '#ccaa00'
const MONO      = "'Courier New', monospace"

const NULL_PUBKEY = '11111111111111111111111111111111'
const STAKE_AMOUNT = 50 // USDT

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
    [Buffer.from('trade'), u64LE(tradeId)],
    SAFE_P2P_ESCROW_PROGRAM_ID,
  )
}

function disputePDA(disputeId: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('dispute'), u64LE(disputeId)],
    SAFE_P2P_ESCROW_PROGRAM_ID,
  )
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

// EscrowState layout: 8 disc | 32 admin | 8 trade_ctr | 8 dispute_ctr |
//                     96 arbitrators[3] | 24 arb_balances[3] | ...
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function _fetchEscrowInfo(connection: any): Promise<EscrowInfo> {
  const [pda] = escrowStatePDA()
  const info  = await connection.getAccountInfo(pda)
  if (!info) throw new Error('ESCROW NOT INITIALIZED')

  const d = info.data as Buffer
  const arbitrators: string[] = []
  const balances: bigint[]    = []

  for (let i = 0; i < 3; i++) {
    arbitrators.push(new PublicKey(d.slice(56 + i * 32, 88 + i * 32)).toBase58())
    balances.push(readU64LE(d, 152 + i * 8))
  }

  return { arbitrators, balances }
}

// DisputeAccount layout (164 bytes):
//   8 disc | 8 dispute_id | 8 trade_id | 32 raised_by |
//   1 votes_for_buyer | 1 votes_for_seller | 1 is_resolved |
//   8 created_at | 96 voters[3] | 1 bump
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchDisputes(connection: any): Promise<DisputeInfo[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accounts: any[] = await connection.getProgramAccounts(SAFE_P2P_ESCROW_PROGRAM_ID, {
    filters: [{ dataSize: 164 }],
  })
  return accounts
    .filter(({ account }: { account: { data: Buffer } }) => account.data[58] === 0) // is_resolved === false
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
      { pubkey: escrowState,            isSigner: false, isWritable: true  },
      { pubkey: candidate,              isSigner: true,  isWritable: true  },
      { pubkey: candidateTokenAccount,  isSigner: false, isWritable: true  },
      { pubkey: arbitratorVault,        isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,       isSigner: false, isWritable: false },
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
        {'>'} safe p2p escrow&nbsp;&nbsp;|&nbsp;&nbsp;devnet&nbsp;&nbsp;|&nbsp;&nbsp;arbitrator panel
      </div>
    </div>
  )
}

// ── Slot card ─────────────────────────────────────────────────────────────────

function SlotCard({
  slotIndex,
  occupant,
  balance,
  wallet,
  acting,
  onStake,
  onWithdraw,
  onLeave,
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
  const isEmpty  = occupant === NULL_PUBKEY
  const isYours  = !isEmpty && occupant === wallet
  const earned   = (Number(balance) / 10 ** USDT_DECIMALS).toFixed(6)
  const hasEarned = balance > 0n

  const borderColor = isYours ? GREEN : GREEN_DIM

  return (
    <div
      style={{
        border: `1px solid ${borderColor}`,
        padding: '16px',
        marginBottom: '10px',
        opacity: acting ? 0.6 : 1,
        transition: 'opacity 0.2s',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
        <span style={{ color: GREEN_DIM, fontSize: '0.72rem', letterSpacing: '0.12em' }}>
          SLOT {slotIndex + 1}
        </span>
        {isEmpty ? (
          <span style={{ color: GREEN_DIM, fontSize: '0.68rem', letterSpacing: '0.1em', border: `1px solid ${GREEN_DIM}`, padding: '1px 6px' }}>
            EMPTY
          </span>
        ) : isYours ? (
          <span style={{ color: GREEN, fontSize: '0.68rem', letterSpacing: '0.1em', border: `1px solid ${GREEN}`, padding: '1px 6px' }}>
            YOU
          </span>
        ) : (
          <span style={{ color: YELLOW, fontSize: '0.68rem', letterSpacing: '0.1em', border: `1px solid ${YELLOW}`, padding: '1px 6px' }}>
            OCCUPIED
          </span>
        )}
      </div>

      {!isEmpty && (
        <div style={{ marginBottom: '8px', fontSize: '0.75rem', letterSpacing: '0.03em' }}>
          <span style={{ color: GREEN_DIM }}>ARBITRATOR&nbsp;&nbsp;</span>
          <span style={{ color: isYours ? '#00ff41' : GREEN, fontSize: '0.7rem' }}>
            {occupant.slice(0, 8)}…{occupant.slice(-8)}
          </span>
        </div>
      )}

      {!isEmpty && (
        <div style={{ marginBottom: '12px', fontSize: '0.75rem', letterSpacing: '0.03em' }}>
          <span style={{ color: GREEN_DIM }}>EARNINGS&nbsp;&nbsp;&nbsp;&nbsp;</span>
          <span style={{ color: hasEarned ? '#00ff41' : GREEN_DIM }}>
            {earned} USDT
          </span>
        </div>
      )}

      {acting && (
        <div style={{ color: YELLOW, fontSize: '0.75rem', letterSpacing: '0.05em', marginBottom: '8px' }}>
          {'>'} processing…<span className="terminal-cursor"> _</span>
        </div>
      )}

      {!acting && (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {isEmpty && wallet && (
            <button
              onClick={onStake}
              className="terminal-menu-btn"
              style={{
                border: `1px solid ${GREEN}`, color: GREEN, background: 'transparent',
                fontFamily: MONO, fontSize: '0.75rem', letterSpacing: '0.08em', padding: '6px 14px', cursor: 'pointer',
              }}
            >
              [ STAKE {STAKE_AMOUNT} USDT ]
            </button>
          )}

          {isYours && hasEarned && (
            <button
              onClick={onWithdraw}
              className="terminal-menu-btn"
              style={{
                border: `1px solid ${GREEN}`, color: GREEN, background: 'transparent',
                fontFamily: MONO, fontSize: '0.75rem', letterSpacing: '0.08em', padding: '6px 14px', cursor: 'pointer',
              }}
            >
              [ WITHDRAW ]
            </button>
          )}

          {isYours && (
            <button
              onClick={onLeave}
              className="terminal-menu-btn"
              style={{
                border: `1px solid ${RED}`, color: RED, background: 'transparent',
                fontFamily: MONO, fontSize: '0.75rem', letterSpacing: '0.08em', padding: '6px 14px', cursor: 'pointer',
              }}
            >
              [ LEAVE SLOT ]
            </button>
          )}

          {isEmpty && !wallet && (
            <span style={{ color: GREEN_DIM, fontSize: '0.72rem', letterSpacing: '0.04em' }}>
              connect wallet to stake
            </span>
          )}
        </div>
      )}
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

  // ── Stake
  async function handleStake(slotIndex: number) {
    if (!publicKey) return
    await withAction(slotIndex, async () => {
      const [escrowState]     = escrowStatePDA()
      const [arbitratorVault] = arbVaultPDA()
      const usdtMint           = new PublicKey(USDT_MINT)
      const candidateAta       = getAssociatedTokenAddressSync(usdtMint, publicKey)

      const tx = new Transaction()
      const ataInfo = await connection.getAccountInfo(candidateAta)
      if (!ataInfo) {
        tx.add(createAssociatedTokenAccountInstruction(publicKey, candidateAta, publicKey, usdtMint))
      }
      tx.add(buildStakeIx(publicKey, candidateAta, escrowState, arbitratorVault))

      const sig = await sendTransaction(tx, connection)
      await connection.confirmTransaction(sig, 'confirmed')
      setTxSig(sig)
      setSuccessMsg(`SLOT ${slotIndex + 1} CLAIMED — you are now an arbitrator`)
    })
  }

  // ── Withdraw
  async function handleWithdraw(slotIndex: number) {
    if (!publicKey) return
    await withAction(slotIndex, async () => {
      const [escrowState]     = escrowStatePDA()
      const [arbitratorVault] = arbVaultPDA()
      const usdtMint           = new PublicKey(USDT_MINT)
      const arbitratorAta      = getAssociatedTokenAddressSync(usdtMint, publicKey)

      const tx = new Transaction()
      tx.add(buildWithdrawIx(publicKey, arbitratorAta, escrowState, arbitratorVault))

      const sig = await sendTransaction(tx, connection)
      await connection.confirmTransaction(sig, 'confirmed')
      setTxSig(sig)
      setSuccessMsg('EARNINGS WITHDRAWN TO YOUR WALLET')
    })
  }

  // ── Leave
  async function handleLeave(slotIndex: number) {
    if (!publicKey) return
    await withAction(slotIndex, async () => {
      const [escrowState]     = escrowStatePDA()
      const [arbitratorVault] = arbVaultPDA()
      const usdtMint           = new PublicKey(USDT_MINT)
      const arbitratorAta      = getAssociatedTokenAddressSync(usdtMint, publicKey)

      const tx = new Transaction()
      tx.add(buildRemoveIx(publicKey, arbitratorAta, publicKey, escrowState, arbitratorVault))

      const sig = await sendTransaction(tx, connection)
      await connection.confirmTransaction(sig, 'confirmed')
      setTxSig(sig)
      setSuccessMsg(`SLOT ${slotIndex + 1} FREED — stake returned to your wallet`)
    })
  }

  const wallet        = publicKey?.toBase58() ?? ''
  const slotsCount    = info?.arbitrators.filter(a => a !== NULL_PUBKEY).length ?? 0
  const yourSlot      = info?.arbitrators.findIndex(a => a === wallet) ?? -1
  const isArbitrator  = yourSlot >= 0
  const pendingVotes  = disputes.filter(d => wallet && !d.voters.includes(wallet))

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
      <div className="flex-1 px-4 pb-8" style={{ maxWidth: '520px', margin: '0 auto', width: '100%' }}>

        {/* Title */}
        <div style={{ marginBottom: '24px' }}>
          <div style={{ color: GREEN, fontSize: 'clamp(1rem, 3vw, 1.2rem)', letterSpacing: '0.15em' }}>
            {'>'} BECOME ARBITRATOR
          </div>
          <div style={{ color: GREEN_DIM, fontSize: '0.72rem', letterSpacing: '0.05em', marginTop: '4px' }}>
            stake {STAKE_AMOUNT} USDT to secure the network — earn dispute fees
          </div>
        </div>

        {/* Arbitrator status banner */}
        {isArbitrator && (
          <div style={{ border: `1px solid ${GREEN}`, padding: '10px 14px', marginBottom: '18px', color: GREEN, fontSize: '0.78rem', letterSpacing: '0.05em' }}>
            {'>'} YOU ARE ARBITRATOR — SLOT {yourSlot + 1}
            {pendingVotes.length > 0 && (
              <>
                <br />
                <span style={{ color: YELLOW, fontSize: '0.68rem' }}>
                  {pendingVotes.length} dispute{pendingVotes.length > 1 ? 's' : ''} waiting for your vote ↓
                </span>
              </>
            )}
            {pendingVotes.length === 0 && (
              <>
                <br />
                <span style={{ color: GREEN_DIM, fontSize: '0.68rem' }}>
                  no pending disputes — all clear
                </span>
              </>
            )}
          </div>
        )}

        {/* Success banner */}
        {successMsg && (
          <div style={{ border: `1px solid ${GREEN}`, padding: '10px 14px', marginBottom: '14px', color: GREEN, fontSize: '0.78rem', letterSpacing: '0.05em' }}>
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

        {/* Error banner */}
        {errorMsg && (
          <div style={{ border: `1px solid ${RED}`, padding: '10px 14px', color: RED, fontSize: '0.75rem', marginBottom: '14px', wordBreak: 'break-word', letterSpacing: '0.02em' }}>
            {errorMsg}
          </div>
        )}

        {/* Slots header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <span style={{ color: GREEN_DIM, fontSize: '0.72rem', letterSpacing: '0.1em' }}>
            ── ARBITRATOR SLOTS ({slotsCount}/3 FILLED) ──────────
          </span>
          <button
            onClick={load}
            className="terminal-menu-btn"
            style={{ border: `1px solid ${GREEN_DIM}`, color: GREEN_DIM, background: 'transparent', fontFamily: MONO, fontSize: '0.68rem', letterSpacing: '0.08em', padding: '3px 10px' }}
          >
            [ ↻ ]
          </button>
        </div>

        {/* Slot cards */}
        {loading ? (
          <div style={{ color: GREEN, fontSize: '0.85rem', letterSpacing: '0.06em' }}>
            {'>'} LOADING<span className="terminal-cursor"> _</span>
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

        {/* ── Dispute panel link ── */}
        {isArbitrator && !loading && (
          <div style={{ marginTop: '28px', borderTop: `1px solid ${GREEN_DIM}`, paddingTop: '16px' }}>
            <div style={{ color: GREEN_DIM, fontSize: '0.68rem', letterSpacing: '0.1em', marginBottom: '10px' }}>
              ── VOTE ON DISPUTES ─────────────────────────
            </div>
            <div style={{ color: GREEN_DIM, fontSize: '0.72rem', letterSpacing: '0.03em', lineHeight: 1.8, marginBottom: '12px' }}>
              {pendingVotes.length > 0
                ? <span style={{ color: YELLOW }}>{'>'} {pendingVotes.length} dispute{pendingVotes.length > 1 ? 's' : ''} waiting for your vote</span>
                : <span>{'>'} no active disputes — all clear</span>
              }
            </div>
            <Link href="/arbitrate" style={{ textDecoration: 'none' }}>
              <button
                className="terminal-menu-btn"
                style={{ border: `1px solid ${GREEN}`, color: GREEN, background: 'transparent',
                  fontFamily: MONO, fontSize: '0.75rem', letterSpacing: '0.08em', padding: '7px 16px', cursor: 'pointer' }}
              >
                [ GO TO DISPUTE PANEL → ]
              </button>
            </Link>
          </div>
        )}

        {/* How it works */}
        <div style={{ marginTop: '28px', borderTop: `1px solid ${GREEN_DIM}`, paddingTop: '16px' }}>
          <div style={{ color: GREEN_DIM, fontSize: '0.68rem', letterSpacing: '0.1em', marginBottom: '10px' }}>
            ── HOW IT WORKS ─────────────────────────────
          </div>
          {[
            `stake ${STAKE_AMOUNT} USDT to claim an empty slot`,
            'when a trade is disputed, vote BUYER WON or SELLER WON',
            '2/3 majority wins — 1% of trade goes to voting arbitrators',
            'withdraw earnings anytime while keeping your slot',
            `leave at any time — your ${STAKE_AMOUNT} USDT stake is returned`,
          ].map((line, i) => (
            <div key={i} style={{ color: GREEN_DIM, fontSize: '0.72rem', letterSpacing: '0.03em', lineHeight: 1.8 }}>
              {'>'} {line}
            </div>
          ))}
        </div>

      </div>
    </Shell>
  )
}
