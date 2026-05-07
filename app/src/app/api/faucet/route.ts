import { NextRequest, NextResponse } from 'next/server'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import {
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
} from '@solana/spl-token'

const RPC_URL   = 'https://api.devnet.solana.com'
const USDT_MINT = new PublicKey('2YytyJvKbp9SCpn4wiSUgKTguhiKWqdErUWmLqTZ68us')
const AMOUNT    = 1_000_000_000n

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body?.wallet) return NextResponse.json({ error: 'missing wallet' }, { status: 400 })

  let walletPk: PublicKey
  try { walletPk = new PublicKey(body.wallet) } catch {
    return NextResponse.json({ error: 'invalid wallet address' }, { status: 400 })
  }

  const rawKey = process.env.ADMIN_KEYPAIR
  if (!rawKey) return NextResponse.json({ error: 'faucet not configured' }, { status: 500 })

  let admin: Keypair
  try {
    admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(rawKey)))
  } catch (e) {
    return NextResponse.json({ error: `keypair parse failed: ${e}` }, { status: 500 })
  }

  try {
    const conn = new Connection(RPC_URL, 'confirmed')
    const ata  = getAssociatedTokenAddressSync(USDT_MINT, walletPk)
    const tx   = new Transaction()

    try { await getAccount(conn, ata) } catch {
      tx.add(createAssociatedTokenAccountInstruction(admin.publicKey, ata, walletPk, USDT_MINT))
    }

    tx.add(createMintToInstruction(USDT_MINT, ata, admin.publicKey, AMOUNT))

    const { blockhash } = await conn.getLatestBlockhash()
    tx.recentBlockhash = blockhash
    tx.feePayer = admin.publicKey
    tx.sign(admin)

    const sig = await conn.sendRawTransaction(tx.serialize())
    await conn.confirmTransaction(sig, 'confirmed')

    return NextResponse.json({ ok: true, sig })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
