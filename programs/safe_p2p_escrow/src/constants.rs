pub const ARBITRATOR_FEE: u64 = 50_000_000; // 50 USDT (6 decimals)
pub const MIN_TRADE_AMOUNT: u64 = 10_000_000; // 10 USDT (6 decimals)
pub const FEE_BPS: u64 = 5; // 0.5% = 5 basis points out of 1000
pub const TRADE_SEED: &[u8] = b"trade";
pub const VAULT_SEED: &[u8] = b"vault";
pub const DISPUTE_SEED: &[u8] = b"dispute";
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const MAX_ARBITRATORS: usize = 3;
pub const ARBITRATOR_VAULT_SEED: &[u8] = b"arb_vault";
