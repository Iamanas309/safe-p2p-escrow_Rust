import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import fs from "fs";

const PROGRAM_ID = new PublicKey(
  "CtKjEzbZLj2FUWz1Rt15q4A5EW38NPCpoTXX9bcXUjgt"
);
const ESCROW_SEED = Buffer.from("escrow");
const ARB_VAULT_SEED = Buffer.from("arb_vault");

async function main() {
  // Load wallet from disk
  const walletKeypair = Keypair.fromSecretKey(
    Buffer.from(
      JSON.parse(
        fs.readFileSync(
          process.env.HOME + "/.config/solana/id.json",
          "utf-8"
        )
      )
    )
  );

  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  // Load IDL
  const idl = JSON.parse(
    fs.readFileSync(
      process.cwd() + "/target/idl/safe_p2p_escrow.json",
      "utf-8"
    )
  );

  const program = new Program(idl, provider);

  // Check if escrow state PDA already exists (program may already be initialized)
  const [escrowStatePDA] = PublicKey.findProgramAddressSync(
    [ESCROW_SEED],
    PROGRAM_ID
  );
  const [arbVaultPDA] = PublicKey.findProgramAddressSync(
    [ARB_VAULT_SEED],
    PROGRAM_ID
  );

  const existing = await connection.getAccountInfo(escrowStatePDA);
  if (existing) {
    console.log("✅ Escrow state account already exists on-chain.");
    console.log("   PDA:", escrowStatePDA.toBase58());
    console.log("   Program is deployed and initialized.");
    console.log(
      "\n🔗 Explorer:",
      `https://explorer.solana.com/address/${PROGRAM_ID.toBase58()}?cluster=devnet`
    );
    return;
  }

  console.log("Creating USDT mint for this test...");
  const usdtMint = await createMint(
    connection,
    walletKeypair,   // payer
    walletKeypair.publicKey, // mint authority
    null,            // freeze authority
    6                // decimals (USDT uses 6)
  );
  console.log("USDT mint created:", usdtMint.toBase58());

  console.log("\nCalling initialize...");
  const tx = await program.methods
    .initialize()
    .accounts({
      escrowState: escrowStatePDA,
      arbitratorVault: arbVaultPDA,
      usdtMint: usdtMint,
      admin: walletKeypair.publicKey,
    })
    .rpc();

  console.log("\n✅ Initialize transaction:", tx);
  console.log(
    "🔗 Explorer:",
    `https://explorer.solana.com/tx/${tx}?cluster=devnet`
  );
  console.log(
    "🔗 Program:",
    `https://explorer.solana.com/address/${PROGRAM_ID.toBase58()}?cluster=devnet`
  );
  console.log("\nSanity check passed — program is live on devnet!");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
