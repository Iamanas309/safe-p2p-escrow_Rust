use crate::constants::*;
use crate::error::EscrowError;
use crate::state::{DisputeAccount, EscrowState, TradeAccount, TradeStatus};
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(trade_id: u64)]
pub struct RaiseDispute<'info> {
    #[account(mut, seeds = [ESCROW_SEED], bump = escrow_state.bump)]
    pub escrow_state: Account<'info, EscrowState>,

    #[account(
        mut,
        seeds = [TRADE_SEED, trade_id.to_le_bytes().as_ref()],
        bump = trade_account.bump,
    )]
    pub trade_account: Account<'info, TradeAccount>,

    #[account(
        init,
        payer = buyer,
        space = DisputeAccount::LEN,
        seeds = [DISPUTE_SEED, escrow_state.dispute_counter.to_le_bytes().as_ref()],
        bump
    )]
    pub dispute_account: Account<'info, DisputeAccount>,

    #[account(mut)]
    pub buyer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn raise_dispute(ctx: Context<RaiseDispute>, trade_id: u64) -> Result<()> {
    require!(
        ctx.accounts.buyer.key() == ctx.accounts.trade_account.buyer,
        EscrowError::NotBuyer
    );
    require!(
        ctx.accounts.trade_account.status == TradeStatus::Active,
        EscrowError::TradeNotActive
    );

    ctx.accounts.trade_account.status = TradeStatus::Disputed;

    let dispute = &mut ctx.accounts.dispute_account;
    let dispute_id = ctx.accounts.escrow_state.dispute_counter;

    dispute.dispute_id = dispute_id;
    dispute.trade_id = trade_id;
    dispute.raised_by = ctx.accounts.buyer.key();
    dispute.votes_for_buyer = 0;
    dispute.votes_for_seller = 0;
    dispute.is_resolved = false;
    dispute.created_at = Clock::get()?.unix_timestamp;
    dispute.voters = [Pubkey::default(); 3];
    dispute.bump = ctx.bumps.dispute_account;

    ctx.accounts.escrow_state.dispute_counter += 1;

    msg!("Dispute {} raised on trade {}", dispute_id, trade_id);
    Ok(())
}
