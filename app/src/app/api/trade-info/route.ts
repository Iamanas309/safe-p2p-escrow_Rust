import { NextRequest, NextResponse } from 'next/server'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY!

function sbHeaders(extra?: Record<string, string>) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  }
}

export async function GET(req: NextRequest) {
  const pda = req.nextUrl.searchParams.get('pda')
  if (!pda) return NextResponse.json(null)

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/trade_info?pda=eq.${encodeURIComponent(pda)}&select=method,account,name`,
    { headers: sbHeaders(), cache: 'no-store' },
  )
  const rows = await res.json()
  if (!Array.isArray(rows) || rows.length === 0) return NextResponse.json(null)
  return NextResponse.json(rows[0])
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body?.pda || !body?.method || !body?.account) {
    return NextResponse.json({ error: 'missing fields' }, { status: 400 })
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/trade_info`, {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'resolution=merge-duplicates' }),
    body: JSON.stringify({
      pda:     body.pda,
      method:  body.method,
      account: body.account,
      name:    body.name ?? '',
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    return NextResponse.json({ error: err }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
