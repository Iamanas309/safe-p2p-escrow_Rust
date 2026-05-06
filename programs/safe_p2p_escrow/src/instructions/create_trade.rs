use crate::constants::*;
use crate::error::EscrowError;
use crate::state::{EscrowState, TradeAccount, TradeStatus};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct CreateTrade<'info> {
    #[account(mut, seeds = [ESCROW_SEED], bump = escrow_state.bump)]
    pub escrow_state: Account<'info, EscrowState>,

    #[account(
        init,
        payer = seller,
        space = TradeAccount::LEN,
        seeds = [TRADE_SEED, escrow_state.trade_counter.to_le_bytes().as_ref()],
        bump
    )]
    pub trade_account: Account<'info, TradeAccount>,

    // PDA-owned token account — only the program can sign transfers out of here
    #[account(
        init,
        payer = seller,
        token::mint = usdt_mint,
        token::authority = trade_account,
        seeds = [VAULT_SEED, escrow_state.trade_counter.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(mut)]
    pub seller_token_account: Account<'info, TokenAccount>,

    pub usdt_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn create_trade(ctx: Context<CreateTrade>, amount: u64, rate: u64) -> Result<()> {
    require!(amount >= MIN_TRADE_AMOUNT, EscrowError::InvalidAmount);
    require!(rate > 0, EscrowError::InvalidRate);

    let fee = amount * FEE_BPS / 1000;
    let total = amount + fee;

    // Seller deposits principal + 0.5% fee into the per-trade vault
    let cpi_accounts = Transfer {
        from: ctx.accounts.seller_token_account.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.seller.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts);
    token::transfer(cpi_ctx, total)?;

    let state = &mut ctx.accounts.escrow_state;
    let trade = &mut ctx.accounts.trade_account;

    trade.trade_id = state.trade_counter;
    trade.seller = ctx.accounts.seller.key();
    trade.buyer = Pubkey::default();
    trade.amount = amount;
    trade.rate = rate;
    trade.created_at = Clock::get()?.unix_timestamp;
    trade.joined_at = 0;
    trade.status = TradeStatus::Open;
    trade.bump = ctx.bumps.trade_account;
    trade.vault_bump = ctx.bumps.vault;

    state.trade_counter += 1;
    msg!("Trade {} created by seller {}", trade.trade_id, trade.seller);
    Ok(())
}
