use crate::constants::*;
use crate::error::EscrowError;
use crate::state::EscrowState;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct WithdrawArbitratorEarnings<'info> {
    #[account(mut, seeds = [ESCROW_SEED], bump = escrow_state.bump)]
    pub escrow_state: Account<'info, EscrowState>,

    #[account(
        mut,
        seeds = [ARBITRATOR_VAULT_SEED],
        bump = escrow_state.arbitrator_vault_bump,
    )]
    pub arbitrator_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = arbitrator_token_account.owner == arbitrator.key() @ EscrowError::NotArbitrator
    )]
    pub arbitrator_token_account: Account<'info, TokenAccount>,

    pub arbitrator: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn withdraw_arbitrator_earnings(ctx: Context<WithdrawArbitratorEarnings>) -> Result<()> {
    let arbitrator_key = ctx.accounts.arbitrator.key();
    let escrow_state = &ctx.accounts.escrow_state;

    // Must be a registered arbitrator
    let slot = escrow_state
        .arbitrators
        .iter()
        .position(|a| *a == arbitrator_key)
        .ok_or(EscrowError::NotArbitrator)?;

    let balance = escrow_state.arbitrator_balances[slot];

    // Balance must exceed the locked stake — only earnings can be withdrawn
    require!(balance > ARBITRATOR_FEE, EscrowError::NothingToWithdraw);

    let earnings = balance - ARBITRATOR_FEE;

    // Deduct earnings, keep stake locked
    ctx.accounts.escrow_state.arbitrator_balances[slot] = ARBITRATOR_FEE;

    let bump_bytes = [ctx.accounts.escrow_state.bump];
    let seeds: &[&[u8]] = &[ESCROW_SEED, &bump_bytes];
    let signer_seeds = &[seeds];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.arbitrator_vault.to_account_info(),
                to: ctx.accounts.arbitrator_token_account.to_account_info(),
                authority: ctx.accounts.escrow_state.to_account_info(),
            },
            signer_seeds,
        ),
        earnings,
    )?;

    msg!(
        "Arbitrator {} withdrew {} earnings",
        arbitrator_key,
        earnings
    );
    Ok(())
}
