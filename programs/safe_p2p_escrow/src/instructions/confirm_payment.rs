use crate::constants::*;
use crate::error::EscrowError;
use crate::state::{TradeAccount, TradeStatus};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
#[instruction(trade_id: u64)]
pub struct ConfirmPayment<'info> {
    #[account(
        mut,
        seeds = [TRADE_SEED, trade_id.to_le_bytes().as_ref()],
        bump = trade_account.bump,
    )]
    pub trade_account: Account<'info, TradeAccount>,

    #[account(
        mut,
        seeds = [VAULT_SEED, trade_id.to_le_bytes().as_ref()],
        bump = trade_account.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub seller: Signer<'info>,

    // Constrained to the buyer recorded in the trade so the seller can't redirect funds
    #[account(
        mut,
        constraint = buyer_token_account.owner == trade_account.buyer @ EscrowError::NotBuyer
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn confirm_payment(ctx: Context<ConfirmPayment>, trade_id: u64) -> Result<()> {
    require!(
        ctx.accounts.trade_account.seller == ctx.accounts.seller.key(),
        EscrowError::NotSeller
    );
    require!(
        ctx.accounts.trade_account.status == TradeStatus::Active,
        EscrowError::TradeNotActive
    );

    let amount = ctx.accounts.trade_account.amount;
    let bump = ctx.accounts.trade_account.bump;
    let trade_id_bytes = trade_id.to_le_bytes();
    let bump_bytes = [bump];

    // The vault's authority is the trade_account PDA — sign with its seeds
    let seeds: &[&[u8]] = &[TRADE_SEED, &trade_id_bytes, &bump_bytes];
    let signer_seeds = &[seeds];

    let cpi_accounts = Transfer {
        from: ctx.accounts.vault.to_account_info(),
        to: ctx.accounts.buyer_token_account.to_account_info(),
        authority: ctx.accounts.trade_account.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        cpi_accounts,
        signer_seeds,
    );
    token::transfer(cpi_ctx, amount)?;

    ctx.accounts.trade_account.status = TradeStatus::Completed;

    msg!("Trade {} completed, {} USDT sent to buyer", trade_id, amount);
    Ok(())
}
