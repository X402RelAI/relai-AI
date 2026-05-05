// Minimal Solana wallet helpers — balance read + devnet airdrop +
// JSON-or-base58 keypair loader. Carved out so the demo's pre-flight
// inspection can run without dragging in the full @solana/web3.js
// transaction builder surface.

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import bs58 from "bs58";

export function loadSolanaKeypair(secret) {
  const trimmed = String(secret || "").trim();
  if (!trimmed) throw new Error("Solana secret key is empty");
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed);
    if (!Array.isArray(arr) || arr.length !== 64) {
      throw new Error("Solana secret key JSON array must contain 64 bytes");
    }
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

export async function readBalances({ rpcUrl, usdcMint, owner }) {
  const connection = new Connection(rpcUrl, "confirmed");
  const solLamports = await connection.getBalance(owner, "confirmed");
  const ata = getAssociatedTokenAddressSync(new PublicKey(usdcMint), owner, false, TOKEN_PROGRAM_ID);
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

export async function airdropSolDevnet({ rpcUrl, recipient, lamports = 1_000_000_000 }) {
  const connection = new Connection(rpcUrl, "confirmed");
  const sig = await connection.requestAirdrop(recipient, lamports);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}
