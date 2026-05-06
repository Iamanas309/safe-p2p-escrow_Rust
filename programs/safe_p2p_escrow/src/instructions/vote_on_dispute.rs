use crate::constants::*;
use crate::error::EscrowError;
use crate::state::{DisputeAccount, EscrowState, TradeAccount, TradeStatus};
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(dispute_id: u64)]
pub struct VoteOnDispute<'info> {
    #[account(seeds = [ESCROW_SEED], bump = escrow_state.bump)]
    pub escrow_state: Account<'info, EscrowState>,

    #[account(
        mut,
        seeds = [DISPUTE_SEED, dispute_id.to_le_bytes().as_ref()],
        bump = dispute_account.bump,
    )]
    pub dispute_account: Account<'info, DisputeAccount>,

    #[account(
        seeds = [TRADE_SEED, dispute_account.trade_id.to_le_bytes().as_ref()],
        bump = trade_account.bump,
    )]
    pub trade_account: Account<'info, TradeAccount>,

    pub arbitrator: Signer<'info>,
}

pub fn vote_on_dispute(
    ctx: Context<VoteOnDispute>,
    dispute_id: u64,
    vote_for_buyer: bool,
) -> Result<()> {
    let escrow_state = &ctx.accounts.escrow_state;
    let dispute = &mut ctx.accounts.dispute_account;
    let trade = &ctx.accounts.trade_account;
    let arbitrator_key = ctx.accounts.arbitrator.key();

    // Must be one of the 3 registered arbitrators
    let arb_index = escrow_state
        .arbitrators
        .iter()
        .position(|a| *a == arbitrator_key)
        .ok_or(EscrowError::NotArbitrator)?;

    require!(
        trade.status == TradeStatus::Disputed,
        EscrowError::TradeNotDisputed
    );
    require!(!dispute.is_resolved, EscrowError::DisputeAlreadyResolved);
    require!(
        !dispute.voters.contains(&arbitrator_key),
        EscrowError::AlreadyVoted
    );

    if vote_for_buyer {
        dispute.votes_for_buyer += 1;
    } else {
        dispute.votes_for_seller += 1;
    }

    dispute.voters[arb_index] = arbitrator_key;

    msg!(
        "Arbitrator {} voted {} on dispute {}",
        arbitrator_key,
        if vote_for_buyer {
            "for buyer"
        } else {
            "for seller"
        },
        dispute_id
    );
    Ok(())
}
