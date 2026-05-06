use crate::constants::*;
use crate::error::EscrowError;
use crate::state::EscrowState;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct RemoveArbitrator<'info> {
    #[account(mut, seeds = [ESCROW_SEED], bump = escrow_state.bump)]
    pub escrow_state: Account<'info, EscrowState>,

    #[account(
        mut,
        seeds = [ARBITRATOR_VAULT_SEED],
        bump = escrow_state.arbitrator_vault_bump,
    )]
    pub arbitrator_vault: Account<'info, TokenAccount>,

    // The arbitrator being removed
    /// CHECK: we verify this matches a slot in escrow_state.arbitrators
    pub arbitrator: UncheckedAccount<'info>,

    // Token account to refund stake to (only used on self-removal, ignored on slash)
    #[account(mut)]
    pub arbitrator_token_account: Account<'info, TokenAccount>,

    // The caller — either admin (slash) or the arbitrator themselves (self-removal)
    pub caller: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn remove_arbitrator(ctx: Context<RemoveArbitrator>) -> Result<()> {
    let caller_key = ctx.accounts.caller.key();
    let arbitrator_key = ctx.accounts.arbitrator.key();
    let escrow_state = &ctx.accounts.escrow_state;

    let is_admin = caller_key == escrow_state.admin;
    let is_self =
        caller_key == arbitrator_key && escrow_state.arbitrators.contains(&arbitrator_key);

    require!(is_admin || is_self, EscrowError::NotArbitrator);

    // Find the slot
    let slot = escrow_state
        .arbitrators
        .iter()
        .position(|a| *a == arbitrator_key)
        .ok_or(EscrowError::NotArbitrator)?;

    let balance = escrow_state.arbitrator_balances[slot];

    // Clear the slot
    let state = &mut ctx.accounts.escrow_state;
    state.arbitrators[slot] = Pubkey::default();
    state.arbitrator_balances[slot] = 0;

    if is_admin {
        // Slash — stake stays in vault, nothing transferred
        msg!("Arbitrator {} slashed by admin", arbitrator_key);
    } else {
        // Self-removal — refund full balance (stake + any earnings)
        require!(balance > 0, EscrowError::NothingToWithdraw);

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
            balance,
        )?;

        msg!(
            "Arbitrator {} removed, {} refunded",
            arbitrator_key,
            balance
        );
    }

    Ok(())
}
