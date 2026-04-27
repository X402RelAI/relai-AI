// Build, sign and broadcast the `deposit_note` instruction for the Solana
// shielded-pool program. Mirrors the on-chain Anchor program at
// `contracts/solana-escrow/programs/solana-shielded-pool/src/lib.rs` in the
// reference 402-everywhere repo.
//
// Layout (Anchor):
//   discriminator(deposit_note) || commitment[32] || amount_le_u64
// Accounts (in order):
//   depositor (signer, writable)
//   pool PDA (writable)               [seeds: "shielded-pool", usdc_mint]
//   deposit PDA (writable)             [seeds: "shielded-deposit", pool, commitment]
//   pool_vault ATA (writable)
//   depositor ATA (writable)
//   token_program
//   system_program

import crypto from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Commitment,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";

function anchorDiscriminator(name: string): Buffer {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function writeU64LE(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  let normalized = BigInt.asUintN(64, value);
  for (let i = 0; i < 8; i += 1) {
    buf[i] = Number(normalized & 0xffn);
    normalized >>= 8n;
  }
  return buf;
}

function commitmentBytes(commitment: string): Buffer {
  const normalized = commitment.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("commitment must be 32-byte hex");
  }
  return Buffer.from(normalized, "hex");
}

export function deriveShieldedPoolPda(programId: string, usdcMint: string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("shielded-pool"), new PublicKey(usdcMint).toBuffer()],
    new PublicKey(programId),
  );
  return pda;
}

export function deriveShieldedDepositPda(
  programId: string,
  pool: PublicKey,
  commitment: string,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("shielded-deposit"), pool.toBuffer(), commitmentBytes(commitment)],
    new PublicKey(programId),
  );
  return pda;
}

/**
 * Decode a Solana secret key from JSON byte array (canonical CLI format) or
 * base58. Throws on malformed input. Caller is expected to load the secret
 * outside the LLM context (e.g. process.env at startup) and never expose it as
 * a tool parameter.
 */
export function loadSolanaKeypair(secret: string): Keypair {
  const trimmed = String(secret || "").trim();
  if (!trimmed) throw new Error("Solana secret key is empty");
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed) as number[];
    if (!Array.isArray(arr) || arr.length !== 64) {
      throw new Error("Solana secret key JSON array must contain 64 bytes");
    }
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

export type SolanaDepositInput = {
  rpcUrl: string;
  programId: string;
  usdcMint: string;
  depositor: Keypair;
  commitment: string;
  totalAmountMicro: bigint;
};

export type SolanaDepositResult = {
  depositTxHash: string;
  poolPda: string;
  depositPda: string;
  poolVaultAta: string;
  depositorAta: string;
  ataCreated: boolean;
};

export async function depositToShieldedPool(
  input: SolanaDepositInput,
  opts: { commitment?: Commitment } = {},
): Promise<SolanaDepositResult> {
  const commitmentLevel: Commitment = opts.commitment ?? "confirmed";
  const connection = new Connection(input.rpcUrl, commitmentLevel);

  const programPK = new PublicKey(input.programId);
  const mintPK = new PublicKey(input.usdcMint);
  const poolPda = deriveShieldedPoolPda(input.programId, input.usdcMint);
  const depositPda = deriveShieldedDepositPda(input.programId, poolPda, input.commitment);
  const poolVaultAta = getAssociatedTokenAddressSync(mintPK, poolPda, true, TOKEN_PROGRAM_ID);
  const depositorAta = getAssociatedTokenAddressSync(
    mintPK,
    input.depositor.publicKey,
    false,
    TOKEN_PROGRAM_ID,
  );

  let needsAtaCreation = false;
  try {
    await getAccount(connection, depositorAta, commitmentLevel, TOKEN_PROGRAM_ID);
  } catch (err) {
    const msg = String((err as Error).message || err);
    if (msg.includes("could not find account") || msg.includes("TokenAccountNotFoundError")) {
      needsAtaCreation = true;
    } else {
      throw err;
    }
  }

  const depositIxData = Buffer.concat([
    anchorDiscriminator("deposit_note"),
    commitmentBytes(input.commitment),
    writeU64LE(input.totalAmountMicro),
  ]);

  const depositIx = new TransactionInstruction({
    programId: programPK,
    keys: [
      { pubkey: input.depositor.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolPda, isSigner: false, isWritable: true },
      { pubkey: depositPda, isSigner: false, isWritable: true },
      { pubkey: poolVaultAta, isSigner: false, isWritable: true },
      { pubkey: depositorAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: depositIxData,
  });

  const ixs: TransactionInstruction[] = [];
  let ataCreated = false;
  if (needsAtaCreation) {
    ixs.push(
      createAssociatedTokenAccountInstruction(
        input.depositor.publicKey,
        depositorAta,
        input.depositor.publicKey,
        mintPK,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    ataCreated = true;
  }
  ixs.push(depositIx);

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitmentLevel);
  const message = new TransactionMessage({
    payerKey: input.depositor.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([input.depositor]);

  const signature = await connection.sendTransaction(tx, { skipPreflight: false });
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    commitmentLevel,
  );

  return {
    depositTxHash: signature,
    poolPda: poolPda.toBase58(),
    depositPda: depositPda.toBase58(),
    poolVaultAta: poolVaultAta.toBase58(),
    depositorAta: depositorAta.toBase58(),
    ataCreated,
  };
}

export async function readBuyerBalances(input: {
  rpcUrl: string;
  usdcMint: string;
  owner: PublicKey;
}): Promise<{ solLamports: number; usdcMicro: bigint; ataExists: boolean }> {
  const connection = new Connection(input.rpcUrl, "confirmed");
  const solLamports = await connection.getBalance(input.owner, "confirmed");
  const ata = getAssociatedTokenAddressSync(
    new PublicKey(input.usdcMint),
    input.owner,
    false,
    TOKEN_PROGRAM_ID,
  );
  let usdcMicro = 0n;
  let ataExists = false;
  try {
    const acc = await getAccount(connection, ata, "confirmed", TOKEN_PROGRAM_ID);
    usdcMicro = acc.amount;
    ataExists = true;
  } catch {
    // ATA missing → balance is 0
  }
  return { solLamports, usdcMicro, ataExists };
}

export async function airdropSolDevnet(input: {
  rpcUrl: string;
  recipient: PublicKey;
  lamports?: number;
}): Promise<string> {
  const connection = new Connection(input.rpcUrl, "confirmed");
  const lamports = input.lamports ?? 1_000_000_000;
  const sig = await connection.requestAirdrop(input.recipient, lamports);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  return sig;
}
