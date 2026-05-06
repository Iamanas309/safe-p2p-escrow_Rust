use crate::constants::*;
use crate::error::EscrowError;
use crate::state::{DisputeAccount, EscrowState, TradeAccount, TradeStatus};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
#[instruction(dispute_id: u64)]
pub struct ResolveDeadlock<'info> {
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
        constraint = admin.key() == escrow_state.admin @ EscrowError::NotAdmin
    )]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn resolve_deadlock(
    ctx: Context<ResolveDeadlock>,
    dispute_id: u64,
    vote_for_buyer: bool,
) -> Result<()> {
    let dispute = &ctx.accounts.dispute_account;
    let trade = &ctx.accounts.trade_account;

    require!(!dispute.is_resolved, EscrowError::DisputeAlreadyResolved);
    require!(
        trade.status == TradeStatus::Disputed,
        EscrowError::TradeNotDisputed
    );

    // Admin can only resolve after 2 days
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= dispute.created_at + 2 * 86400,
        EscrowError::TooEarlyForAdminResolve
    );

    let winner_account = if vote_for_buyer {
        ctx.accounts.buyer_token_account.to_account_info()
    } else {
        ctx.accounts.seller_token_account.to_account_info()
    };

    let amount = trade.amount;
    let trade_id = ctx.accounts.dispute_account.trade_id;
    let trade_id_bytes = trade_id.to_le_bytes();
    let bump_bytes = [ctx.accounts.trade_account.bump];
    let seeds: &[&[u8]] = &[TRADE_SEED, &trade_id_bytes, &bump_bytes];
    let signer_seeds = &[seeds];

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

    msg!("Deadlock dispute {} resolved by admin", dispute_id);
    Ok(())
}
