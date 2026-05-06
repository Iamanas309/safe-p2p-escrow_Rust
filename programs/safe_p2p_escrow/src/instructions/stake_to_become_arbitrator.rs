use crate::constants::*;
use crate::error::EscrowError;
use crate::state::EscrowState;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct StakeToBecomeArbitrator<'info> {
    #[account(mut, seeds = [ESCROW_SEED], bump = escrow_state.bump)]
    pub escrow_state: Account<'info, EscrowState>,

    #[account(mut)]
    pub candidate: Signer<'info>,

    #[account(
        mut,
        constraint = candidate_token_account.owner == candidate.key() @ EscrowError::NotArbitrator
    )]
    pub candidate_token_account: Account<'info, TokenAccount>,

    // Global vault that holds arbitrator stakes
    #[account(
        mut,
        seeds = [ARBITRATOR_VAULT_SEED],
        bump = escrow_state.arbitrator_vault_bump,
    )]
    pub arbitrator_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn stake_to_become_arbitrator(ctx: Context<StakeToBecomeArbitrator>) -> Result<()> {
    let escrow_state = &ctx.accounts.escrow_state;
    let candidate_key = ctx.accounts.candidate.key();

    // Must not already be an arbitrator
    require!(
        !escrow_state.arbitrators.contains(&candidate_key),
        EscrowError::AlreadyArbitrator
    );

    // Find an empty slot
    let slot = escrow_state
        .arbitrators
        .iter()
        .position(|a| *a == Pubkey::default())
        .ok_or(EscrowError::ArbitratorSlotsFull)?;

    // Transfer 50 USDT stake into arbitrator vault
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.candidate_token_account.to_account_info(),
                to: ctx.accounts.arbitrator_vault.to_account_info(),
                authority: ctx.accounts.candidate.to_account_info(),
            },
        ),
        ARBITRATOR_FEE,
    )?;

    let state = &mut ctx.accounts.escrow_state;
    state.arbitrators[slot] = candidate_key;
    state.arbitrator_balances[slot] += ARBITRATOR_FEE;

    msg!("Arbitrator {} staked in slot {}", candidate_key, slot);
    Ok(())
}
