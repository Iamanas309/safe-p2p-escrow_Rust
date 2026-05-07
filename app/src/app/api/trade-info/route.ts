import { NextRequest, NextResponse } from 'next/server'
import { Connection, PublicKey } from '@solana/web3.js'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY!
const RPC_URL      = 'https://api.devnet.solana.com'
const PROGRAM_ID   = new PublicKey('CtKjEzbZLj2FUWz1Rt15q4A5EW38NPCpoTXX9bcXUjgt')

function sbHeaders(extra?: Record<string, string>) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  }
}

// ── On-chain helpers ──────────────────────────────────────────────────────────

function readPubkey(data: Buffer, offset: number): string {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58()
}

async function fetchTradeParties(tradePda: string): Promise<{ seller: string; buyer: string } | null> {
  const conn = new Connection(RPC_URL, 'confirmed')
  try {
    const info = await conn.getAccountInfo(new PublicKey(tradePda))
    if (!info || info.data.length < 80) return null
    const d = Buffer.from(info.data)
    return {
      seller: readPubkey(d, 16),
      buyer:  readPubkey(d, 48),
    }
  } catch {
    return null
  }
}

async function fetchArbitrators(): Promise<string[]> {
  const conn = new Connection(RPC_URL, 'confirmed')
  try {
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('escrow')], PROGRAM_ID,
    )
    const info = await conn.getAccountInfo(escrowPda)
    if (!info || info.data.length < 152) return []
    const d = Buffer.from(info.data)
    return [
      readPubkey(d, 56),
      readPubkey(d, 88),
      readPubkey(d, 120),
    ]
  } catch {
    return []
  }
}

const NULL_PK = '11111111111111111111111111111111'

// ── GET /api/dispute-claim?trade_pda=<pda>&wallet=<wallet> ────────────────────
// Returns { buyer: {...}, seller: {...} } if wallet is buyer, seller, or arbitrator

export async function GET(req: NextRequest) {
  const tradePda = req.nextUrl.searchParams.get('trade_pda')
  const wallet   = req.nextUrl.searchParams.get('wallet')

  if (!tradePda || !wallet) {
    return NextResponse.json({ error: 'missing params' }, { status: 400 })
  }

  // Verify caller is authorized: buyer, seller, or an arbitrator
  const [parties, arbitrators] = await Promise.all([
    fetchTradeParties(tradePda),
    fetchArbitrators(),
  ])

  if (!parties) {
    return NextResponse.json({ error: 'trade not found' }, { status: 404 })
  }

  const authorized =
    wallet === parties.buyer ||
    wallet === parties.seller ||
    arbitrators.filter(a => a !== NULL_PK).includes(wallet)

  if (!authorized) {
    return NextResponse.json({ error: 'not authorized' }, { status: 403 })
  }

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/dispute_claims?trade_pda=eq.${encodeURIComponent(tradePda)}&select=side,claim_text,evidence_url,updated_at`,
    { headers: sbHeaders(), cache: 'no-store' },
  )
  const rows: { side: string; claim_text: string; evidence_url: string | null; updated_at: string }[] = await res.json()

  const buyer  = rows.find(r => r.side === 'buyer')  ?? null
  const seller = rows.find(r => r.side === 'seller') ?? null

  return NextResponse.json({ buyer, seller })
}

// ── POST /api/dispute-claim ───────────────────────────────────────────────────
// Body: { trade_pda, side: 'buyer'|'seller', wallet, claim_text, evidence_url? }
// Verifies on-chain that wallet matches the claimed side, then upserts.

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body?.trade_pda || !body?.side || !body?.wallet || body?.claim_text === undefined) {
    return NextResponse.json({ error: 'missing fields' }, { status: 400 })
  }

  if (!['buyer', 'seller'].includes(body.side)) {
    return NextResponse.json({ error: 'invalid side' }, { status: 400 })
  }

  if (body.claim_text.length > 500) {
    return NextResponse.json({ error: 'claim_text exceeds 500 chars' }, { status: 400 })
  }

  if (body.evidence_url) {
    if (body.evidence_url.length > 500) {
      return NextResponse.json({ error: 'evidence_url exceeds 500 chars' }, { status: 400 })
    }
    try {
      const u = new URL(body.evidence_url)
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error()
    } catch {
      return NextResponse.json({ error: 'evidence_url must be a valid http/https URL' }, { status: 400 })
    }
  }

  // Verify on-chain that wallet is actually buyer/seller for that side
  const parties = await fetchTradeParties(body.trade_pda)
  if (!parties) {
    return NextResponse.json({ error: 'trade not found' }, { status: 404 })
  }

  const expected = body.side === 'buyer' ? parties.buyer : parties.seller
  if (body.wallet !== expected || expected === NULL_PK) {
    return NextResponse.json({ error: 'wallet does not match trade side' }, { status: 403 })
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/dispute_claims`, {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'resolution=merge-duplicates' }),
    body: JSON.stringify({
      trade_pda:    body.trade_pda,
      side:         body.side,
      claim_text:   body.claim_text,
      evidence_url: body.evidence_url ?? null,
      updated_at:   new Date().toISOString(),
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    return NextResponse.json({ error: err }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
