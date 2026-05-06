'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { WalletButton } from '@/components/solana/solana-provider'
import { SAFE_P2P_ESCROW_PROGRAM_ID } from '@/lib/constants'

const GREEN     = '#00cc33'
const GREEN_DIM = '#006622'
const RED       = '#cc3300'
const YELLOW    = '#ccaa00'
const MONO      = "'Courier New', monospace"
const NULL_PK   = '11111111111111111111111111111111'

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

interface DisputeInfo {
  disputeId:      bigint
  tradeId:        bigint
  raisedBy:       string
  votesForBuyer:  number
  votesForSeller: number
  voters:         string[]
  votedCount:     number
  disputePda:     PublicKey
  tradePda:       PublicKey
}

// ── PDA helpers ───────────────────────────────────────────────────────────────

function escrowStatePDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('escrow')], SAFE_P2P_ESCROW_PROGRAM_ID)
}

function disputePDA(disputeId: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('dispute'), u64LE(disputeId)], SAFE_P2P_ESCROW_PROGRAM_ID,
  )
}

function tradePDA(tradeId: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('trade'), u64LE(tradeId)], SAFE_P2P_ESCROW_PROGRAM_ID,
  )
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

// EscrowState layout: 8 disc | 32 admin | 8 trade_ctr | 8 dispute_ctr | 96 arbitrators[3] | ...
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchArbitratorSlot(connection: any, wallet: string): Promise<number> {
  const [pda] = escrowStatePDA()
  const info  = await connection.getAccountInfo(pda)
  if (!info) return -1
  const d = info.data as Buffer
  for (let i = 0; i < 3; i++) {
    const pk = new PublicKey(d.slice(56 + i * 32, 88 + i * 32)).toBase58()
    if (pk === wallet) return i
  }
  return -1
}

// DisputeAccount: 8 disc | 8 dispute_id | 8 trade_id | 32 raised_by |
//   1 votes_for_buyer | 1 votes_for_seller | 1 is_resolved | 8 created_at |
//   96 voters[3] | 1 bump  = 164 bytes
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchActiveDisputes(connection: any): Promise<DisputeInfo[]> {
  const accounts = await connection.getProgramAccounts(SAFE_P2P_ESCROW_PROGRAM_ID, {
    filters: [{ dataSize: 164 }],
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (accounts as any[])
    .filter(({ account }: { account: { data: Buffer } }) => account.data[58] === 0)
    .map(({ account }: { account: { data: Buffer } }) => {
      const d = account.data
      const disputeId = readU64LE(d, 8)
      const tradeId   = readU64LE(d, 16)
      const voters = [
        new PublicKey(d.slice(67,  99)).toBase58(),
        new PublicKey(d.slice(99,  131)).toBase58(),
        new PublicKey(d.slice(131, 163)).toBase58(),
      ]
      const [dpda] = disputePDA(disputeId)
      const [tpda] = tradePDA(tradeId)
      return {
        disputeId,
        tradeId,
        raisedBy:       new PublicKey(d.slice(24, 56)).toBase58(),
        votesForBuyer:  d[56],
        votesForSeller: d[57],
        voters,
        votedCount:     voters.filter(v => v !== NULL_PK).length,
        disputePda:     dpda,
        tradePda:       tpda,
      }
    })
}

// ── Instruction builder ───────────────────────────────────────────────────────

function buildVoteIx(
  arbitrator: PublicKey,
  escrowState: PublicKey,
  disputeAccount: PublicKey,
  tradeAccount: PublicKey,
  disputeId: bigint,
  voteForBuyer: boolean,
): TransactionInstruction {
  const data = Buffer.alloc(17)
  Buffer.from([7, 213, 96, 171, 252, 59, 55, 23]).copy(data, 0)
  u64LE(disputeId).copy(data, 8)
  data[16] = voteForBuyer ? 1 : 0
  return new TransactionInstruction({
    programId: SAFE_P2P_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: escrowState,    isSigner: false, isWritable: false },
      { pubkey: disputeAccount, isSigner: false, isWritable: true  },
      { pubkey: tradeAccount,   isSigner: false, isWritable: false },
      { pubkey: arbitrator,     isSigner: true,  isWritable: false },
    ],
    data,
  })
}

// ── Shell ─────────────────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="terminal-page fixed inset-0 z-50 flex flex-col overflow-auto"
      style={{ background: '#000', fontFamily: MONO }}>
      {children}
      <div className="shrink-0 px-4 py-2 border-t"
        style={{ color: GREEN_DIM, borderColor: '#0d260d', fontSize: '0.7rem', letterSpacing: '0.03em' }}>
        {'>'} safe p2p escrow&nbsp;&nbsp;|&nbsp;&nbsp;devnet&nbsp;&nbsp;|&nbsp;&nbsp;dispute panel
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function ArbitrateFeature() {
  const { connection }                 = useConnection()
  const { publicKey, sendTransaction } = useWallet()

  const [slot, setSlot]               = useState<number>(-2) // -2 = loading, -1 = not arb
  const [disputes, setDisputes]       = useState<DisputeInfo[]>([])
  const [loading, setLoading]         = useState(true)
  const [actingOn, setActingOn]       = useState<bigint | null>(null)
  const [errorMsg, setErrorMsg]       = useState('')
  const [successMsg, setSuccessMsg]   = useState('')
  const [txSig, setTxSig]             = useState('')

  const wallet = publicKey?.toBase58() ?? ''

  const load = useCallback(async () => {
    setLoading(true)
    setErrorMsg('')
    try {
      const [arbSlot, active] = await Promise.all([
        wallet ? fetchArbitratorSlot(connection, wallet) : Promise.resolve(-1),
        fetchActiveDisputes(connection),
      ])
      setSlot(arbSlot)
      setDisputes(active)
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [connection, wallet])

  useEffect(() => { load() }, [load])

  async function handleVote(d: DisputeInfo, voteForBuyer: boolean) {
    if (!publicKey) return
    setActingOn(d.disputeId)
    setErrorMsg('')
    setSuccessMsg('')
    try {
      const [escrowState] = escrowStatePDA()
      const tx = new Transaction()
      tx.add(buildVoteIx(publicKey, escrowState, d.disputePda, d.tradePda, d.disputeId, voteForBuyer))
      const sig = await sendTransaction(tx, connection)
      await connection.confirmTransaction(sig, 'confirmed')
      setTxSig(sig)
      const label = `#${d.tradeId.toString().padStart(7, '0')}`
      setSuccessMsg(`VOTE CAST — ${voteForBuyer ? 'FOR BUYER' : 'FOR SELLER'} on trade ${label}`)
      await load()
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e)
      setErrorMsg(raw.length > 200 ? raw.slice(0, 200) + '…' : raw)
    } finally {
      setActingOn(null)
    }
  }

  const isArbitrator = slot >= 0
  const pendingVotes = disputes.filter(d => !d.voters.includes(wallet))

  return (
    <Shell>
      {/* Header */}
      <div className="flex justify-between items-center px-6 py-4 shrink-0">
        <Link href="/" style={{ color: GREEN_DIM, fontSize: '0.8rem', letterSpacing: '0.08em', textDecoration: 'none' }}>
          {'<'} BACK
        </Link>
        <WalletButton />
      </div>

      <div className="flex-1 px-4 pb-8" style={{ maxWidth: '520px', margin: '0 auto', width: '100%' }}>

        {/* Title */}
        <div style={{ marginBottom: '20px' }}>
          <div style={{ color: GREEN, fontSize: 'clamp(1rem, 3vw, 1.2rem)', letterSpacing: '0.15em' }}>
            {'>'} DISPUTE PANEL
          </div>
          <div style={{ color: GREEN_DIM, fontSize: '0.72rem', letterSpacing: '0.05em', marginTop: '4px' }}>
            active disputes awaiting arbitrator votes
          </div>
        </div>

        {/* Not connected */}
        {!publicKey && (
          <div style={{ border: `1px solid ${GREEN_DIM}`, padding: '14px', color: GREEN_DIM, fontSize: '0.8rem', letterSpacing: '0.05em' }}>
            {'>'} CONNECT WALLET<span className="terminal-cursor"> _</span>
          </div>
        )}

        {/* Loading */}
        {publicKey && loading && (
          <div style={{ color: GREEN, fontSize: '0.85rem', letterSpacing: '0.06em' }}>
            {'>'} LOADING<span className="terminal-cursor"> _</span>
          </div>
        )}

        {/* Not an arbitrator */}
        {publicKey && !loading && !isArbitrator && (
          <div style={{ border: `1px solid ${RED}`, padding: '16px' }}>
            <div style={{ color: RED, fontSize: '0.8rem', letterSpacing: '0.08em', marginBottom: '10px' }}>
              {'>'} ACCESS RESTRICTED
            </div>
            <div style={{ color: GREEN_DIM, fontSize: '0.72rem', letterSpacing: '0.03em', lineHeight: 1.8, marginBottom: '14px' }}>
              only registered arbitrators can vote on disputes.<br />
              stake 50 USDT to claim an arbitrator slot.
            </div>
            <Link href="/become-arbitrator" style={{ textDecoration: 'none' }}>
              <button
                className="terminal-menu-btn"
                style={{ border: `1px solid ${GREEN}`, color: GREEN, background: 'transparent',
                  fontFamily: MONO, fontSize: '0.75rem', letterSpacing: '0.08em', padding: '6px 14px', cursor: 'pointer' }}
              >
                [ BECOME ARBITRATOR ]
              </button>
            </Link>
          </div>
        )}

        {/* Arbitrator view */}
        {publicKey && !loading && isArbitrator && (
          <>
            {/* Your status */}
            <div style={{ border: `1px solid ${GREEN}`, padding: '10px 14px', marginBottom: '20px', fontSize: '0.75rem', letterSpacing: '0.04em' }}>
              <span style={{ color: GREEN_DIM }}>YOUR SLOT&nbsp;&nbsp;</span>
              <span style={{ color: GREEN }}>{slot + 1} of 3</span>
              <span style={{ color: GREEN_DIM }}>&nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;</span>
              {pendingVotes.length > 0
                ? <span style={{ color: YELLOW }}>{pendingVotes.length} dispute{pendingVotes.length > 1 ? 's' : ''} need your vote</span>
                : <span style={{ color: GREEN_DIM }}>no pending votes — all clear</span>
              }
            </div>

            {/* Success */}
            {successMsg && (
              <div style={{ border: `1px solid ${GREEN}`, padding: '10px 14px', color: GREEN, fontSize: '0.78rem', letterSpacing: '0.05em', marginBottom: '14px' }}>
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

            {/* Error */}
            {errorMsg && (
              <div style={{ border: `1px solid ${RED}`, padding: '10px 14px', color: RED, fontSize: '0.75rem', marginBottom: '14px', wordBreak: 'break-word' }}>
                {errorMsg}
              </div>
            )}

            {/* Disputes header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <span style={{ color: GREEN_DIM, fontSize: '0.68rem', letterSpacing: '0.1em' }}>
                ── ACTIVE DISPUTES ({disputes.length}) ──────────────────
              </span>
              <button onClick={load} className="terminal-menu-btn"
                style={{ border: `1px solid ${GREEN_DIM}`, color: GREEN_DIM, background: 'transparent',
                  fontFamily: MONO, fontSize: '0.68rem', letterSpacing: '0.08em', padding: '3px 10px' }}>
                [ ↻ ]
              </button>
            </div>

            {disputes.length === 0 ? (
              <div style={{ border: `1px solid ${GREEN_DIM}`, padding: '20px 16px', color: GREEN_DIM,
                fontSize: '0.78rem', letterSpacing: '0.05em', textAlign: 'center' }}>
                {'>'} no active disputes — the network is clean
              </div>
            ) : (
              disputes.map(d => {
                const alreadyVoted = d.voters.includes(wallet)
                const isActing     = actingOn === d.disputeId
                const tradeLabel   = `#${d.tradeId.toString().padStart(7, '0')}`
                const borderColor  = alreadyVoted ? GREEN_DIM : YELLOW

                return (
                  <div key={d.disputeId.toString()} style={{
                    border: `1px solid ${borderColor}`,
                    padding: '16px', marginBottom: '12px',
                    opacity: isActing ? 0.6 : 1, transition: 'opacity 0.2s',
                  }}>
                    {/* Card header */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ color: YELLOW, fontSize: '0.75rem', letterSpacing: '0.1em' }}>
                          DISPUTE
                        </span>
                        <Link href={`/trade/${d.tradeId.toString()}`} style={{ textDecoration: 'none' }}>
                          <span className="terminal-menu-btn" style={{
                            color: '#00ff41', fontSize: '0.72rem', letterSpacing: '0.08em',
                            border: '1px solid #006622', padding: '2px 7px', display: 'inline-block',
                          }}>
                            [ {tradeLabel} → ]
                          </span>
                        </Link>
                      </div>
                      {alreadyVoted
                        ? <span style={{ color: GREEN, fontSize: '0.65rem', letterSpacing: '0.1em', border: `1px solid ${GREEN}`, padding: '1px 6px' }}>VOTED</span>
                        : <span style={{ color: YELLOW, fontSize: '0.65rem', letterSpacing: '0.1em', border: `1px solid ${YELLOW}`, padding: '1px 6px' }}>NEEDS VOTE</span>
                      }
                    </div>

                    {/* Info rows */}
                    <div style={{ fontSize: '0.72rem', letterSpacing: '0.03em', lineHeight: 2, marginBottom: '12px' }}>
                      <div>
                        <span style={{ color: GREEN_DIM }}>RAISED BY&nbsp;&nbsp;&nbsp;</span>
                        <span style={{ color: GREEN }}>{d.raisedBy.slice(0, 8)}…{d.raisedBy.slice(-8)}</span>
                      </div>
                      <div>
                        <span style={{ color: GREEN_DIM }}>VOTES CAST&nbsp;&nbsp;</span>
                        <span style={{ color: GREEN }}>{d.votedCount} / 3 arbitrators voted</span>
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 20px' }}>
                        <span>
                          <span style={{ color: GREEN_DIM }}>FOR BUYER&nbsp;&nbsp;&nbsp;</span>
                          <span style={{ color: d.votesForBuyer > 0 ? GREEN : GREEN_DIM }}>
                            {'█'.repeat(d.votesForBuyer)}{'░'.repeat(3 - d.votesForBuyer)} {d.votesForBuyer}
                          </span>
                        </span>
                        <span>
                          <span style={{ color: GREEN_DIM }}>FOR SELLER&nbsp;</span>
                          <span style={{ color: d.votesForSeller > 0 ? RED : GREEN_DIM }}>
                            {'█'.repeat(d.votesForSeller)}{'░'.repeat(3 - d.votesForSeller)} {d.votesForSeller}
                          </span>
                        </span>
                      </div>
                    </div>

                    {/* Vote actions */}
                    {isActing ? (
                      <div style={{ color: YELLOW, fontSize: '0.75rem', letterSpacing: '0.04em' }}>
                        {'>'} submitting vote…<span className="terminal-cursor"> _</span>
                      </div>
                    ) : alreadyVoted ? (
                      <div style={{ color: GREEN_DIM, fontSize: '0.72rem', letterSpacing: '0.03em' }}>
                        {'>'} your vote is recorded — waiting for other arbitrators
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                        <button onClick={() => handleVote(d, true)} className="terminal-menu-btn"
                          style={{ border: `1px solid ${GREEN}`, color: GREEN, background: 'transparent',
                            fontFamily: MONO, fontSize: '0.75rem', letterSpacing: '0.08em',
                            padding: '7px 16px', cursor: 'pointer' }}>
                          [ BUYER WON ]
                        </button>
                        <button onClick={() => handleVote(d, false)} className="terminal-menu-btn"
                          style={{ border: `1px solid ${RED}`, color: RED, background: 'transparent',
                            fontFamily: MONO, fontSize: '0.75rem', letterSpacing: '0.08em',
                            padding: '7px 16px', cursor: 'pointer' }}>
                          [ SELLER WON ]
                        </button>
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </>
        )}
      </div>
    </Shell>
  )
}
