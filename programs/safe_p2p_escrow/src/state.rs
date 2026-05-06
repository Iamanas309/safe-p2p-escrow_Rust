use anchor_lang::prelude::*;

#[account]
pub struct EscrowState {
    pub admin: Pubkey,
    pub trade_counter: u64,
    pub dispute_counter: u64,
    pub arbitrators: [Pubkey; 3],
    pub arbitrator_balances: [u64; 3],
    pub collected_fees: u64,
    pub bump: u8,
    pub arbitrator_vault_bump: u8,
    pub arbitrator_vault: Pubkey,
}

impl EscrowState {
    pub const LEN: usize = 8   // discriminator
        + 32                   // admin
        + 8                    // trade_counter
        + 8                    // dispute_counter
        + (32 * 3)             // arbitrators
        + (8 * 3)              // arbitrator_balances
        + 8                    // collected_fees
        + 32                   // arbitrator_vault  ← ADD
        + 1                    // arbitrator_vault_bump ← ADD
        + 1; // bump
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum TradeStatus {
    Open,
    Active,
    Disputed,
    Completed,
    Cancelled,
}

#[account]
pub struct TradeAccount {
    pub trade_id: u64,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub amount: u64,
    pub rate: u64,
    pub created_at: i64,
    pub joined_at: i64,
    pub status: TradeStatus,
    pub bump: u8,
    pub vault_bump: u8,
}

impl TradeAccount {
    pub const LEN: usize = 8   // discriminator
        + 8                    // trade_id
        + 32                   // seller
        + 32                   // buyer
        + 8                    // amount
        + 8                    // rate
        + 8                    // created_at
        + 8                    // joined_at
        + 1                    // status (enum discriminant)
        + 1                    // bump
        + 1; // vault_bump
}

#[account]
pub struct DisputeAccount {
    pub dispute_id: u64,
    pub trade_id: u64,
    pub raised_by: Pubkey,
    pub votes_for_buyer: u8,
    pub votes_for_seller: u8,
    pub is_resolved: bool,
    pub created_at: i64,
    pub voters: [Pubkey; 3],
    pub bump: u8,
}

impl DisputeAccount {
    pub const LEN: usize = 8   // discriminator
        + 8                    // dispute_id
        + 8                    // trade_id
        + 32                   // raised_by
        + 1                    // votes_for_buyer
        + 1                    // votes_for_seller
        + 1                    // is_resolved
        + 8                    // created_at
        + (32 * 3)             // voters: [Pubkey; 3]
        + 1; // bump
}
