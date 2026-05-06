use crate::constants::*;
use crate::state::EscrowState;
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = EscrowState::LEN,
        seeds = [ESCROW_SEED],
        bump
    )]
    pub escrow_state: Account<'info, EscrowState>,

    // Single vault that holds all arbitrator stakes + earnings
    #[account(
        init,
        payer = admin,
        token::mint = usdt_mint,
        token::authority = escrow_state,
        seeds = [ARBITRATOR_VAULT_SEED],
        bump
    )]
    pub arbitrator_vault: Account<'info, TokenAccount>,

    pub usdt_mint: Account<'info, Mint>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
    let state = &mut ctx.accounts.escrow_state;

    state.admin = ctx.accounts.admin.key();
    state.trade_counter = 0;
    state.dispute_counter = 0;
    state.arbitrators = [Pubkey::default(); 3];
    state.arbitrator_balances = [0u64; 3];
    state.collected_fees = 0;
    state.arbitrator_vault = ctx.accounts.arbitrator_vault.key();
    state.arbitrator_vault_bump = ctx.bumps.arbitrator_vault;
    state.bump = ctx.bumps.escrow_state;

    msg!("SafeP2P Escrow initialized. Admin: {}", state.admin);
    Ok(())
}
