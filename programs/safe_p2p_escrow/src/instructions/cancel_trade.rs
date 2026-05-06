use crate::constants::*;
use crate::error::EscrowError;
use crate::state::{EscrowState, TradeAccount, TradeStatus};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};

#[derive(Accounts)]
#[instruction(trade_id: u64)]
pub struct CancelTrade<'info> {
    #[account(mut, seeds = [ESCROW_SEED], bump = escrow_state.bump)]
    pub escrow_state: Account<'info, EscrowState>,

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

    pub authority: Signer<'info>,

    #[account(
        mut,
        constraint = seller_token_account.owner == trade_account.seller @ EscrowError::NotSeller
    )]
    pub seller_token_account: Account<'info, TokenAccount>,

    // Admin's USDT wallet — receives penalty fees on Active-trade cancellations
    #[account(
        mut,
        constraint = admin_token_account.owner == escrow_state.admin @ EscrowError::NotAdmin
    )]
    pub admin_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn cancel_trade(ctx: Context<CancelTrade>, trade_id: u64) -> Result<()> {
    // Snapshot all values we need before any mutable borrows
    let status = ctx.accounts.trade_account.status.clone();
    let seller = ctx.accounts.trade_account.seller;
    let buyer = ctx.accounts.trade_account.buyer;
    let joined_at = ctx.accounts.trade_account.joined_at;
    let amount = ctx.accounts.trade_account.amount;
    let fee = amount * FEE_BPS / 1000;
    let trade_bump = ctx.accounts.trade_account.bump;
    let authority_key = ctx.accounts.authority.key();

    require!(
        status == TradeStatus::Open || status == TradeStatus::Active,
        EscrowError::TradeNotCancellable
    );

    if status == TradeStatus::Open {
        // No buyer yet — only seller can pull back
        require!(authority_key == seller, EscrowError::NotSeller);
    } else {
        // Active: either party may cancel, but not before 30 min have elapsed
        require!(
            authority_key == seller || authority_key == buyer,
            EscrowError::NotSellerOrBuyer
        );
        let now = Clock::get()?.unix_timestamp;
        require!(
            now - joined_at >= 30 * 60,
            EscrowError::CantCancelBefore30Mins
        );
    }

    let trade_id_bytes = trade_id.to_le_bytes();
    let bump_bytes = [trade_bump];
    let seeds: &[&[u8]] = &[TRADE_SEED, &trade_id_bytes, &bump_bytes];
    let signer_seeds = &[seeds];

    if status == TradeStatus::Open {
        // Full refund: amount + seller fee. No penalty — buyer never committed.
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.seller_token_account.to_account_info(),
                    authority: ctx.accounts.trade_account.to_account_info(),
                },
                signer_seeds,
            ),
            amount + fee,
        )?;
    } else {
        // Refund principal + seller's own fee back to seller
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.seller_token_account.to_account_info(),
                    authority: ctx.accounts.trade_account.to_account_info(),
                },
                signer_seeds,
            ),
            amount + fee,
        )?;

        // Only the buyer's 0.5% fee is kept as penalty
        let buyer_fee = fee;
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.admin_token_account.to_account_info(),
                    authority: ctx.accounts.trade_account.to_account_info(),
                },
                signer_seeds,
            ),
            buyer_fee,
        )?;

        ctx.accounts.escrow_state.collected_fees += buyer_fee;
    }

    // Close vault and return its rent-exempt lamports to the cancelling party
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.authority.to_account_info(),
            authority: ctx.accounts.trade_account.to_account_info(),
        },
        signer_seeds,
    ))?;

    ctx.accounts.trade_account.status = TradeStatus::Cancelled;
    msg!("Trade {} cancelled", trade_id);
    Ok(())
}
