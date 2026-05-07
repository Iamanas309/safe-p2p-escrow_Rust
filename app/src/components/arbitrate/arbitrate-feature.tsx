'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { WalletButton } from '@/components/solana/solana-provider'
import { SAFE_P2P_ESCROW_PROGRAM_ID } from '@/lib/constants'

const NULL_PK = '11111111111111111111111111111111'

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

// ── Main component ────────────────────────────────────────────────────────────

export function ArbitrateFeature() {
  const { connection }                 = useConnection()
  const { publicKey, sendTransaction } = useWallet()

  const [slot, setSlot]             = useState<number>(-2)
  const [disputes, setDisputes]     = useState<DisputeInfo[]>([])
  const [claimsMap, setClaimsMap]   = useState<Map<string, DisputeClaims>>(new Map())
  const [loading, setLoading]       = useState(true)
  const [actingOn, setActingOn]     = useState<bigint | null>(null)
  const [errorMsg, setErrorMsg]     = useState('')
  const [successMsg, setSuccessMsg] = useState('')
  const [txSig, setTxSig]           = useState('')

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

      if (wallet && active.length > 0) {
        const entries = await Promise.all(
          active.map(async d => {
            try {
              const res = await fetch(
                `/api/dispute-claim?trade_pda=${d.tradePda.toBase58()}&wallet=${wallet}`,
              )
              if (res.ok) return [d.tradePda.toBase58(), await res.json()] as [string, DisputeClaims]
            } catch { /* ignore */ }
            return [d.tradePda.toBase58(), { buyer: null, seller: null }] as [string, DisputeClaims]
          }),
        )
        setClaimsMap(new Map(entries))
      }
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
      setSuccessMsg(`Vote cast — ${voteForBuyer ? 'Buyer wins' : 'Seller wins'} on trade #${d.tradeId}`)
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
          <span style={{ color: '#fff', fontWeight: 600, fontSize: '0.88rem' }}>Dispute Panel</span>
          {isArbitrator && (
            <span style={{
              fontSize: '0.65rem', fontWeight: 700, padding: '2px 8px', borderRadius: 6,
              background: 'rgba(245,158,11,0.12)', color: '#f59e0b',
              border: '1px solid rgba(245,158,11,0.25)',
            }}>
              Slot {slot + 1}/3
            </span>
          )}
        </div>
        <WalletButton />
      </div>

      {/* Body */}
      <div className="defi-body">
        <div style={{ maxWidth: 540, margin: '0 auto', padding: '24px 20px 60px', width: '100%' }}>

          {/* Not connected */}
          {!publicKey && (
            <div className="glass-card" style={{ padding: '36px', textAlign: 'center' }}>
              <div style={{ fontSize: '2rem', marginBottom: 12 }}>🔗</div>
              <div style={{ color: '#94a3b8' }}>Connect your wallet to access the dispute panel</div>
            </div>
          )}

          {/* Loading */}
          {publicKey && loading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#64748b', padding: '32px 0' }}>
              <span style={{
                width: 16, height: 16, borderRadius: '50%',
                border: '2px solid rgba(168,85,247,0.3)', borderTopColor: '#a855f7',
                display: 'inline-block', animation: 'spin 0.8s linear infinite',
              }} />
              Loading disputes…
            </div>
          )}

          {/* Not an arbitrator */}
          {publicKey && !loading && !isArbitrator && (
            <div className="glass-card" style={{ padding: '28px', textAlign: 'center' }}>
              <div style={{ fontSize: '2rem', marginBottom: 12 }}>🔒</div>
              <div style={{ color: '#cbd5e1', fontWeight: 600, marginBottom: 8 }}>Access Restricted</div>
              <div style={{ color: '#64748b', fontSize: '0.85rem', lineHeight: 1.7, marginBottom: 20 }}>
                Only registered arbitrators can vote on disputes.<br />
                Stake 50 USDT to claim an arbitrator slot.
              </div>
              <Link href="/become-arbitrator" style={{ textDecoration: 'none' }}>
                <button className="btn-gradient" style={{
                  fontSize: '0.85rem', padding: '9px 20px', border: 'none', cursor: 'pointer',
                }}>
                  Become Arbitrator
                </button>
              </Link>
            </div>
          )}

          {/* Arbitrator view */}
          {publicKey && !loading && isArbitrator && (
            <>
              {/* Status strip */}
              <div className="glass-card-sm" style={{ padding: '12px 16px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ color: '#64748b', fontSize: '0.68rem', letterSpacing: '0.06em', marginBottom: 2 }}>YOUR STATUS</div>
                  <div style={{ color: '#fff', fontWeight: 600, fontSize: '0.88rem' }}>
                    Arbitrator · Slot {slot + 1} of 3
                  </div>
                </div>
                {pendingVotes.length > 0 ? (
                  <div style={{
                    background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)',
                    borderRadius: 8, padding: '6px 12px', textAlign: 'center',
                  }}>
                    <div style={{ color: '#f59e0b', fontWeight: 700, fontSize: '1rem' }}>{pendingVotes.length}</div>
                    <div style={{ color: '#78450a', fontSize: '0.65rem' }}>pending</div>
                  </div>
                ) : (
                  <div style={{ color: '#10b981', fontSize: '0.8rem' }}>✓ All clear</div>
                )}
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
                  <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: 4 }}>⚠ Error</div>
                  <div style={{ fontSize: '0.75rem', wordBreak: 'break-word' }}>{errorMsg}</div>
                </div>
              )}

              {/* Disputes header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <span style={{ color: '#475569', fontSize: '0.8rem' }}>
                  {disputes.length} active dispute{disputes.length !== 1 ? 's' : ''}
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

              {disputes.length === 0 ? (
                <div className="glass-card" style={{ padding: '40px', textAlign: 'center' }}>
                  <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>⚖️</div>
                  <div style={{ color: '#94a3b8' }}>No active disputes — the network is clean</div>
                </div>
              ) : (
                disputes.map(d => {
                  const alreadyVoted = d.voters.includes(wallet)
                  const isActing     = actingOn === d.disputeId

                  return (
                    <div key={d.disputeId.toString()} className="glass-card-sm" style={{
                      padding: '16px', marginBottom: 12,
                      opacity: isActing ? 0.6 : 1, transition: 'opacity 0.2s',
                      borderColor: alreadyVoted ? 'rgba(255,255,255,0.06)' : 'rgba(245,158,11,0.2)',
                    }}>
                      {/* Card header */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ color: '#64748b', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.06em' }}>
                            DISPUTE #{String(d.disputeId).padStart(5, '0')}
                          </span>
                          <Link href={`/trade/${d.tradeId.toString()}`} style={{ textDecoration: 'none' }}>
                            <span style={{
                              fontSize: '0.7rem', fontFamily: 'monospace', color: '#60a5fa',
                              background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.2)',
                              borderRadius: 5, padding: '2px 7px',
                            }}>
                              Trade #{String(d.tradeId).padStart(5, '0')} ↗
                            </span>
                          </Link>
                        </div>
                        {alreadyVoted ? (
                          <span style={{
                            fontSize: '0.65rem', fontWeight: 700, padding: '2px 8px', borderRadius: 6,
                            background: 'rgba(16,185,129,0.12)', color: '#10b981',
                            border: '1px solid rgba(16,185,129,0.25)',
                          }}>
                            VOTED
                          </span>
                        ) : (
                          <span style={{
                            fontSize: '0.65rem', fontWeight: 700, padding: '2px 8px', borderRadius: 6,
                            background: 'rgba(245,158,11,0.12)', color: '#f59e0b',
                            border: '1px solid rgba(245,158,11,0.25)',
                          }}>
                            NEEDS VOTE
                          </span>
                        )}
                      </div>

                      {/* Info */}
                      <div className="defi-row">
                        <span style={{ color: '#64748b' }}>Raised by</span>
                        <span style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#94a3b8' }}>
                          {d.raisedBy.slice(0, 6)}…{d.raisedBy.slice(-6)}
                        </span>
                      </div>
                      <div className="defi-row">
                        <span style={{ color: '#64748b' }}>Votes cast</span>
                        <span style={{ color: '#cbd5e1' }}>{d.votedCount}/3 arbitrators</span>
                      </div>

                      {/* Vote bars */}
                      <div style={{ marginTop: 14, marginBottom: 14 }}>
                        {/* Buyer bar */}
                        <div style={{ marginBottom: 8 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                            <span style={{ color: '#64748b', fontSize: '0.72rem' }}>Buyer wins</span>
                            <span style={{ color: '#10b981', fontSize: '0.72rem', fontWeight: 600 }}>{d.votesForBuyer}/3</span>
                          </div>
                          <div style={{ height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.06)' }}>
                            <div style={{
                              height: '100%', borderRadius: 3,
                              width: `${(d.votesForBuyer / 3) * 100}%`,
                              background: 'linear-gradient(90deg,#10b981,#34d399)',
                              transition: 'width 0.3s ease',
                            }} />
                          </div>
                        </div>
                        {/* Seller bar */}
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                            <span style={{ color: '#64748b', fontSize: '0.72rem' }}>Seller wins</span>
                            <span style={{ color: '#ef4444', fontSize: '0.72rem', fontWeight: 600 }}>{d.votesForSeller}/3</span>
                          </div>
                          <div style={{ height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.06)' }}>
                            <div style={{
                              height: '100%', borderRadius: 3,
                              width: `${(d.votesForSeller / 3) * 100}%`,
                              background: 'linear-gradient(90deg,#ef4444,#f87171)',
                              transition: 'width 0.3s ease',
                            }} />
                          </div>
                        </div>
                      </div>

                      {/* Claims */}
                      {(() => {
                        const claims = claimsMap.get(d.tradePda.toBase58())
                        if (!claims) return null
                        return (
                          <div style={{ marginBottom: 14 }}>
                            <div style={{ color: '#475569', fontSize: '0.65rem', letterSpacing: '0.08em', marginBottom: 10 }}>
                              SUBMITTED CLAIMS
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                              {(['buyer', 'seller'] as const).map(side => {
                                const claim = claims[side]
                                return (
                                  <div key={side} style={{
                                    background: 'rgba(15,23,42,0.6)',
                                    border: '1px solid rgba(255,255,255,0.07)',
                                    borderRadius: 8, padding: '10px 12px',
                                  }}>
                                    <div style={{ color: '#64748b', fontSize: '0.63rem', fontWeight: 600, marginBottom: 6, letterSpacing: '0.06em' }}>
                                      {side.toUpperCase()}
                                    </div>
                                    {claim ? (
                                      <>
                                        <div style={{ color: '#cbd5e1', fontSize: '0.75rem', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                          {claim.claim_text}
                                        </div>
                                        {claim.evidence_url && (
                                          <a href={claim.evidence_url} target="_blank" rel="noopener noreferrer"
                                            style={{ display: 'inline-block', marginTop: 6, color: '#818cf8', fontSize: '0.7rem', textDecoration: 'none' }}>
                                            Evidence →
                                          </a>
                                        )}
                                      </>
                                    ) : (
                                      <div style={{ color: '#334155', fontSize: '0.73rem', fontStyle: 'italic' }}>
                                        No claim yet
                                      </div>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )
                      })()}

                      {/* Vote actions */}
                      {isActing ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#f59e0b', fontSize: '0.82rem' }}>
                          <span style={{
                            width: 14, height: 14, borderRadius: '50%',
                            border: '2px solid rgba(245,158,11,0.3)', borderTopColor: '#f59e0b',
                            display: 'inline-block', animation: 'spin 0.8s linear infinite',
                          }} />
                          Submitting vote…
                        </div>
                      ) : alreadyVoted ? (
                        <div style={{ color: '#334155', fontSize: '0.75rem' }}>
                          Your vote is recorded — waiting for other arbitrators
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                          <button
                            className="btn-gradient"
                            onClick={() => handleVote(d, true)}
                            style={{ fontSize: '0.82rem', padding: '8px 18px', border: 'none', cursor: 'pointer' }}
                          >
                            Buyer Won ✓
                          </button>
                          <button
                            onClick={() => handleVote(d, false)}
                            style={{
                              fontSize: '0.82rem', padding: '8px 18px', borderRadius: 8, cursor: 'pointer',
                              background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
                              color: '#f87171', fontWeight: 600,
                            }}
                          >
                            Seller Won ✓
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
      </div>

      {/* Status bar */}
      <div style={{
        flexShrink: 0, padding: '9px 24px',
        borderTop: '1px solid rgba(255,255,255,0.05)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ color: '#475569', fontSize: '0.68rem', fontFamily: 'monospace' }}>SafeP2P</span>
        <span style={{ color: '#475569', fontSize: '0.68rem' }}>devnet · dispute panel</span>
      </div>
    </div>
  )
}
