use crate::constants::*;
use crate::error::EscrowError;
use crate::state::{TradeAccount, TradeStatus};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
#[instruction(trade_id: u64)]
pub struct JoinTrade<'info> {
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

    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(mut)]
    pub buyer_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn join_trade(ctx: Context<JoinTrade>, trade_id: u64) -> Result<()> {
    require!(
        ctx.accounts.trade_account.status == TradeStatus::Open,
        EscrowError::TradeNotOpen
    );
    require!(
        ctx.accounts.trade_account.seller != ctx.accounts.buyer.key(),
        EscrowError::SellerCannotBeBuyer
    );

    let fee = ctx.accounts.trade_account.amount * FEE_BPS / 1000;

    // Buyer pays 0.5% fee into the vault
    let cpi_accounts = Transfer {
        from: ctx.accounts.buyer_token_account.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.buyer.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts);
    token::transfer(cpi_ctx, fee)?;

    let trade = &mut ctx.accounts.trade_account;
    trade.buyer = ctx.accounts.buyer.key();
    trade.joined_at = Clock::get()?.unix_timestamp;
    trade.status = TradeStatus::Active;

    msg!("Trade {} joined by buyer {}", trade_id, trade.buyer);
    Ok(())
}
