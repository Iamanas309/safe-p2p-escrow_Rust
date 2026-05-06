#![allow(ambiguous_glob_reexports)]

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
pub use constants::*;
pub use instructions::cancel_trade::*;
pub use instructions::confirm_payment::*;
pub use instructions::create_trade::*;
pub use instructions::initialize::*;
pub use instructions::join_trade::*;
pub use instructions::raise_dispute::*;
pub use instructions::remove_arbitrator::*;
pub use instructions::resolve_deadlock::*;
pub use instructions::resolve_dispute::*;
pub use instructions::stake_to_become_arbitrator::*;
pub use instructions::vote_on_dispute::*;
pub use instructions::withdraw_arbitrator_earnings::*;

declare_id!("CtKjEzbZLj2FUWz1Rt15q4A5EW38NPCpoTXX9bcXUjgt");

#[program]
pub mod safe_p2p_escrow {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        instructions::initialize::initialize(ctx)
    }

    pub fn cancel_trade(ctx: Context<CancelTrade>, trade_id: u64) -> Result<()> {
        instructions::cancel_trade::cancel_trade(ctx, trade_id)
    }

    pub fn create_trade(ctx: Context<CreateTrade>, amount: u64, rate: u64) -> Result<()> {
        instructions::create_trade::create_trade(ctx, amount, rate)
    }

    pub fn join_trade(ctx: Context<JoinTrade>, trade_id: u64) -> Result<()> {
        instructions::join_trade::join_trade(ctx, trade_id)
    }

    pub fn confirm_payment(ctx: Context<ConfirmPayment>, trade_id: u64) -> Result<()> {
        instructions::confirm_payment::confirm_payment(ctx, trade_id)
    }

    pub fn raise_dispute(ctx: Context<RaiseDispute>, trade_id: u64) -> Result<()> {
        instructions::raise_dispute::raise_dispute(ctx, trade_id)
    }

    pub fn vote_on_dispute(
        ctx: Context<VoteOnDispute>,
        dispute_id: u64,
        vote_for_buyer: bool,
    ) -> Result<()> {
        instructions::vote_on_dispute::vote_on_dispute(ctx, dispute_id, vote_for_buyer)
    }

    pub fn resolve_dispute(ctx: Context<ResolveDispute>, dispute_id: u64) -> Result<()> {
        instructions::resolve_dispute::resolve_dispute(ctx, dispute_id)
    }

    pub fn resolve_deadlock(
        ctx: Context<ResolveDeadlock>,
        dispute_id: u64,
        vote_for_buyer: bool,
    ) -> Result<()> {
        instructions::resolve_deadlock::resolve_deadlock(ctx, dispute_id, vote_for_buyer)
    }

    pub fn stake_to_become_arbitrator(ctx: Context<StakeToBecomeArbitrator>) -> Result<()> {
        instructions::stake_to_become_arbitrator::stake_to_become_arbitrator(ctx)
    }

    pub fn remove_arbitrator(ctx: Context<RemoveArbitrator>) -> Result<()> {
        instructions::remove_arbitrator::remove_arbitrator(ctx)
    }

    pub fn withdraw_arbitrator_earnings(ctx: Context<WithdrawArbitratorEarnings>) -> Result<()> {
        instructions::withdraw_arbitrator_earnings::withdraw_arbitrator_earnings(ctx)
    }
}
