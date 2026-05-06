use crate::constants::*;
use crate::error::EscrowError;
use crate::state::{DisputeAccount, EscrowState, TradeAccount, TradeStatus};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
#[instruction(dispute_id: u64)]
pub struct ResolveDispute<'info> {
    #[account(mut, seeds = [ESCROW_SEED], bump = escrow_state.bump)]
    pub escrow_state: Box<Account<'info, EscrowState>>,

    #[account(
        mut,
        seeds = [DISPUTE_SEED, dispute_id.to_le_bytes().as_ref()],
        bump = dispute_account.bump,
    )]
    pub dispute_account: Box<Account<'info, DisputeAccount>>,

    #[account(
        mut,
        seeds = [TRADE_SEED, dispute_account.trade_id.to_le_bytes().as_ref()],
        bump = trade_account.bump,
    )]
    pub trade_account: Box<Account<'info, TradeAccount>>,

    #[account(
        mut,
        seeds = [VAULT_SEED, dispute_account.trade_id.to_le_bytes().as_ref()],
        bump = trade_account.vault_bump,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = buyer_token_account.owner == trade_account.buyer @ EscrowError::NotBuyer
    )]
    pub buyer_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = seller_token_account.owner == trade_account.seller @ EscrowError::NotSeller
    )]
    pub seller_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [ARBITRATOR_VAULT_SEED],
        bump = escrow_state.arbitrator_vault_bump,
    )]
    pub arbitrator_vault: Box<Account<'info, TokenAccount>>,

    pub caller: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn resolve_dispute(ctx: Context<ResolveDispute>, dispute_id: u64) -> Result<()> {
    let dispute = &ctx.accounts.dispute_account;
    let trade = &ctx.accounts.trade_account;

    require!(!dispute.is_resolved, EscrowError::DisputeAlreadyResolved);
    require!(
        trade.status == TradeStatus::Disputed,
        EscrowError::TradeNotDisputed
    );

    let all_voted = dispute.voters[0] != Pubkey::default()
        && dispute.voters[1] != Pubkey::default()
        && dispute.voters[2] != Pubkey::default();
    let now = Clock::get()?.unix_timestamp;
    let time_expired = now >= dispute.created_at + 86400;

    require!(all_voted || time_expired, EscrowError::TooEarlyToResolve);
    require!(
        dispute.votes_for_buyer != dispute.votes_for_seller,
        EscrowError::VoteIsTie
    );

    // Credit arbitrator rewards into escrow_state balances (withdrawn separately)
    let amount = trade.amount;
    let total_fees = amount * 10 / 1000; // 1% fee pool
    let voter_count = dispute.voters.iter().filter(|&&v| v != Pubkey::default()).count() as u64;
    let reward_per_arbitrator = total_fees / voter_count;

    for i in 0..3 {
        if ctx.accounts.dispute_account.voters[i] != Pubkey::default() {
            ctx.accounts.escrow_state.arbitrator_balances[i] += reward_per_arbitrator;
        }
    }

    let trade_id = ctx.accounts.dispute_account.trade_id;
    let trade_id_bytes = trade_id.to_le_bytes();
    let bump_bytes = [ctx.accounts.trade_account.bump];
    let seeds: &[&[u8]] = &[TRADE_SEED, &trade_id_bytes, &bump_bytes];
    let signer_seeds = &[seeds];

    // Move fee pool from trade vault into arbitrator vault so balances are redeemable
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.arbitrator_vault.to_account_info(),
                authority: ctx.accounts.trade_account.to_account_info(),
            },
            signer_seeds,
        ),
        total_fees,
    )?;

    let winner_account = if ctx.accounts.dispute_account.votes_for_buyer
        > ctx.accounts.dispute_account.votes_for_seller
    {
        ctx.accounts.buyer_token_account.to_account_info()
    } else {
        ctx.accounts.seller_token_account.to_account_info()
    };

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: winner_account,
                authority: ctx.accounts.trade_account.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    ctx.accounts.trade_account.status = TradeStatus::Completed;
    ctx.accounts.dispute_account.is_resolved = true;

    msg!("Dispute {} resolved", dispute_id);
    Ok(())
}
