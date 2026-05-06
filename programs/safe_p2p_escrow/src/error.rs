use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("Amount is below minimum of 10 USDT")]
    InvalidAmount,

    #[msg("Rate must be greater than zero")]
    InvalidRate,

    #[msg("Trade is not open for joining")]
    TradeNotOpen,

    #[msg("Seller cannot be the buyer")]
    SellerCannotBeBuyer,

    #[msg("Trade is not in active status")]
    TradeNotActive,

    #[msg("Only the seller can perform this action")]
    NotSeller,

    #[msg("Only the buyer can perform this action")]
    NotBuyer,

    #[msg("Only the seller or buyer can perform this action")]
    NotSellerOrBuyer,

    #[msg("Cannot cancel before 30 minutes have passed")]
    CantCancelBefore30Mins,

    #[msg("Trade is not in disputed status")]
    TradeNotDisputed,

    #[msg("Arbitrator has already voted")]
    AlreadyVoted,

    #[msg("Not enough time has passed to resolve dispute")]
    TooEarlyToResolve,

    #[msg("Admin cannot resolve before 2 days have passed")]
    TooEarlyForAdminResolve,

    #[msg("Dispute is already resolved")]
    DisputeAlreadyResolved,

    #[msg("Address is already an arbitrator")]
    AlreadyArbitrator,

    #[msg("All arbitrator slots are full")]
    ArbitratorSlotsFull,

    #[msg("Not an arbitrator")]
    NotArbitrator,

    #[msg("Nothing to withdraw")]
    NothingToWithdraw,

    #[msg("Vote is a tie, admin must resolve")]
    VoteIsTie,

    #[msg("Trade cannot be cancelled in its current status")]
    TradeNotCancellable,

    #[msg("Only the admin can perform this action")]
    NotAdmin,
}
