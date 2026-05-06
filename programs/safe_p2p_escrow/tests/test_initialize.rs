
use {
    anchor_lang::{
        solana_program::{instruction::Instruction, pubkey::Pubkey, system_program},
        InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    std::str::FromStr,
};

#[test]
fn test_initialize() {
    let program_id = safe_p2p_escrow::id();
    let payer = Keypair::new();
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!("../../../target/deploy/safe_p2p_escrow.so");
    svm.add_program(program_id, bytes).unwrap();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();

    let (escrow_state, _bump) =
        Pubkey::find_program_address(&[safe_p2p_escrow::ESCROW_SEED], &program_id);

    let (arbitrator_vault, _vault_bump) =
        Pubkey::find_program_address(&[safe_p2p_escrow::ARBITRATOR_VAULT_SEED], &program_id);

    let usdt_mint = Keypair::new();

    let token_program =
        Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap();

    let instruction = Instruction::new_with_bytes(
        program_id,
        &safe_p2p_escrow::instruction::Initialize {}.data(),
        safe_p2p_escrow::accounts::Initialize {
            escrow_state,
            arbitrator_vault,
            usdt_mint: usdt_mint.pubkey(),
            admin: payer.pubkey(),
            token_program,
            system_program: system_program::id(),
        }
        .to_account_metas(None),
    );

    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[instruction], Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[payer]).unwrap();

    let res = svm.send_transaction(tx);
    assert!(res.is_ok());
}
