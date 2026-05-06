import { PublicKey } from '@solana/web3.js'

export const SAFE_P2P_ESCROW_PROGRAM_ID = new PublicKey(
  'CtKjEzbZLj2FUWz1Rt15q4A5EW38NPCpoTXX9bcXUjgt'
)

export const ESCROW_SEED = 'escrow'
export const TRADE_SEED = 'trade'
export const VAULT_SEED = 'vault'
export const DISPUTE_SEED = 'dispute'
export const ARBITRATOR_VAULT_SEED = 'arb_vault'

// Confirmed from devnet arbitrator_vault token account (initialized 2026-05-04)
export const USDT_MINT = '2YytyJvKbp9SCpn4wiSUgKTguhiKWqdErUWmLqTZ68us'

export const USDT_DECIMALS = 6
