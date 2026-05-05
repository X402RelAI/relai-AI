// `paySPR(...)` — buyer-side end-to-end helper for SPR on Solana.
// Vendored from 402-everywhere/examples/spr-agent/src/pay-spr.mjs and
// extended with:
//   - HTTP-fetched circuit artefacts (no filesystem dependency)
//   - `traceMethod()` calls so each HTTP / on-chain / compute step
//     surfaces under the demo's STEP badges.
//
// Flow:
//   1. parse `relai:quote:…` payload                         (local)
//   2. derive buyer note (V4 commitment + secrets)           (local, Poseidon-7)
//   3. build + sign + submit pool.deposit_note tx            (USDC → pool)
//   4. POST /solana-deposit-confirmed                        (server resolves PDA)
//   5. fetch pool / asp / quote witnesses                    (Merkle paths)
//   6. snarkjs.groth16.fullProve(pairing circuit)            (local)
//   7. POST /solana-pairing-relay                            (operator records match on-chain)
//   8. POST /solana-pairing-proof                            (best-effort: stash bundle)

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { createHash, randomBytes } from "node:crypto";

import { parseShieldedQuotePayload } from "./parse-quote-payload.mjs";
import { computeShieldedCommitment } from "./shielded-note-fields.mjs";
import {
  fetchSolanaPairingWitnesses,
  announceSolanaDeposit,
  submitPairingRelay,
  recordPairingProof,
} from "./buyer-flow.mjs";
import { generatePairingProof } from "./pairing-prover.mjs";
import { loadPairingArtifacts } from "./circuit-artifacts.mjs";
import { traceMethod } from "../shared/visuals.mjs";

const NETWORKS = {
  "solana-devnet": {
    rpcUrl: "https://api.devnet.solana.com",
    poolProgramId: "GW43ARYCQgzVmnX7Nx9mx1s8AjJSdrpAbthaMpKJU8aj",
    usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  },
  solana: {
    rpcUrl: "https://api.mainnet-beta.solana.com",
    poolProgramId: null,
    usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
};

const POOL_SEED = Buffer.from("shielded-pool");
const DEPOSIT_SEED = Buffer.from("shielded-deposit");
const SPR_POOL_ID_DEFAULT = "solana-devnet-spr";
const SPR_ASSET_ID_DEFAULT = "usdc";
const SPR_NOTE_VERSION_DEFAULT = 1;

function anchorDiscriminator(ixName) {
  return createHash("sha256").update(`global:${ixName}`).digest().subarray(0, 8);
}

function encodeU64LE(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

function deriveShieldedPoolPda(poolProgramId, usdcMint) {
  return PublicKey.findProgramAddressSync([POOL_SEED, usdcMint.toBuffer()], poolProgramId);
}

function deriveShieldedDepositPda(poolProgramId, poolPda, commitment) {
  return PublicKey.findProgramAddressSync(
    [DEPOSIT_SEED, poolPda.toBuffer(), commitment],
    poolProgramId,
  );
}

function randHex32() {
  return "0x" + randomBytes(32).toString("hex");
}

export async function deriveBuyerNoteForQuote(quote, options = {}) {
  if (!quote.amount || !quote.expiry) {
    throw new Error("deriveBuyerNoteForQuote: quote payload missing amount or expiry");
  }
  const amount = BigInt(quote.amount);
  const poolId = options.poolId ?? SPR_POOL_ID_DEFAULT;
  const assetId = options.assetId ?? SPR_ASSET_ID_DEFAULT;
  const noteVersion = options.noteVersion ?? SPR_NOTE_VERSION_DEFAULT;

  const secret = randHex32();
  const blinding = randHex32();
  const nonce = randHex32();

  const commitmentHex = await computeShieldedCommitment({
    secret, poolId, assetId, denomination: amount.toString(), blinding, nonce, version: noteVersion,
  });
  const commitment = Buffer.from(commitmentHex.slice(2), "hex");

  return {
    commitment,
    amount,
    expiry: Number(quote.expiry),
    secret,
    blinding,
    nonce,
    poolId,
    assetId,
    noteVersion,
  };
}

function buildPoolDepositInstruction({ poolProgramId, usdcMint, buyer, note }) {
  const [pool] = deriveShieldedPoolPda(poolProgramId, usdcMint);
  const [deposit] = deriveShieldedDepositPda(poolProgramId, pool, note.commitment);
  const buyerAta = getAssociatedTokenAddressSync(usdcMint, buyer, false);
  const poolVault = getAssociatedTokenAddressSync(usdcMint, pool, true);

  const discriminator = anchorDiscriminator("deposit_note");
  const data = Buffer.concat([discriminator, note.commitment, encodeU64LE(note.amount)]);

  return {
    ix: new TransactionInstruction({
      programId: poolProgramId,
      keys: [
        { pubkey: buyer,                  isSigner: true,  isWritable: true },
        { pubkey: pool,                   isSigner: false, isWritable: true },
        { pubkey: deposit,                isSigner: false, isWritable: true },
        { pubkey: poolVault,              isSigner: false, isWritable: true },
        { pubkey: buyerAta,               isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID,       isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    }),
    pool,
    deposit,
    poolVault,
    buyerAta,
  };
}

async function waitForLeafIndex(connection, depositPda, { maxAttempts = 8, intervalMs = 1500 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const info = await connection.getAccountInfo(depositPda, "confirmed");
    if (info && info.data.length >= 97) {
      const data = info.data;
      const leafIndex = Number(data.readBigUInt64LE(80));
      return leafIndex;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`paySPR: deposit PDA at ${depositPda.toBase58()} did not appear within ${maxAttempts * intervalMs}ms`);
}

function explorerUrlForSolana(signature, network) {
  const cluster = network === "solana-devnet" ? "?cluster=devnet" : "";
  return `https://solscan.io/tx/${signature}${cluster}`;
}

export async function paySPR(params) {
  const { baseUrl, walletKeypair, payload } = params;

  const quote = await traceMethod(
    { kind: "compute", label: "parse `relai:quote:…` payload  (local)" },
    async () => {
      const q = parseShieldedQuotePayload(payload);
      if (!q) throw new Error("paySPR: payload could not be parsed");
      return q;
    },
  );

  const network = params.network || quote.network || "solana-devnet";
  const cluster = NETWORKS[network];
  if (!cluster) throw new Error(`paySPR: unsupported network ${network}`);
  if (!cluster.poolProgramId) {
    throw new Error(`paySPR: no shielded-pool program id configured for ${network}`);
  }

  const rpcUrl = params.rpcUrl || cluster.rpcUrl;
  const poolProgramId = new PublicKey(params.poolProgramId || cluster.poolProgramId);
  const usdcMint = new PublicKey(params.usdcMint || cluster.usdcMint);
  const connection = new Connection(rpcUrl, "confirmed");

  const buyerNote = await traceMethod(
    { kind: "compute", label: "poseidon(buyer note) → commitment  (off-chain)" },
    () => deriveBuyerNoteForQuote(quote),
  );
  const commitmentHex = "0x" + buyerNote.commitment.toString("hex");

  const { ix, deposit: depositPda } = buildPoolDepositInstruction({
    poolProgramId,
    usdcMint,
    buyer: walletKeypair.publicKey,
    note: buyerNote,
  });

  const depositTxSig = await traceMethod(
    { kind: "chain", label: "solana.deposit_note  (on-chain · buyer signs)" },
    async () => {
      const depositTx = new Transaction().add(ix);
      depositTx.feePayer = walletKeypair.publicKey;
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      depositTx.recentBlockhash = blockhash;
      depositTx.sign(walletKeypair);
      const sig = await connection.sendRawTransaction(depositTx.serialize());
      await connection.confirmTransaction(sig, "confirmed");
      return sig;
    },
  );

  await traceMethod(
    { kind: "http", label: "POST /v1/shielded-payment-requests/:id/solana-deposit-confirmed" },
    () =>
      announceSolanaDeposit({
        baseUrl,
        quoteId: quote.quoteId,
        commitmentHex,
        depositTxHash: depositTxSig,
        depositPda: depositPda.toBase58(),
      }),
  );

  await waitForLeafIndex(connection, depositPda);

  // Solana SPR uses three separate witness routes; ASP can lag a few seconds.
  let witnesses;
  await traceMethod(
    { kind: "http", label: "GET  pool/asp/quote witnesses  (×3, retried until ASP fresh)" },
    async () => {
      for (let i = 0; i < 8; i++) {
        try {
          witnesses = await fetchSolanaPairingWitnesses({
            baseUrl,
            network,
            commitment: commitmentHex,
            quoteId: quote.quoteId,
          });
          if (witnesses.pool && witnesses.asp && witnesses.quote) return;
        } catch (err) {
          if (!String(err?.message || "").includes("404")) throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      throw new Error("paySPR: failed to fetch all three witnesses after retries");
    },
  );

  const quoteWitness = witnesses.quote;
  const witness = {
    amount: quote.amount,
    quote: {
      quoteId: quote.quoteId,
      sellerSecret: quote.sellerSecret,
      nonce: quote.nonce,
      merkle: {
        root: quoteWitness.root,
        leafIndex: quoteWitness.leafIndex,
        pathElements: quoteWitness.pathElements,
        pathIndices: quoteWitness.pathIndices,
      },
    },
    payment: {
      noteVersion: buyerNote.noteVersion,
      poolId: buyerNote.poolId,
      assetId: buyerNote.assetId,
      secret: buyerNote.secret,
      blinding: buyerNote.blinding,
      nonce: buyerNote.nonce,
      merkle: {
        root: witnesses.pool.root,
        leafIndex: witnesses.pool.leafIndex,
        pathElements: witnesses.pool.pathElements,
        pathIndices: witnesses.pool.pathIndices,
      },
      asp: {
        root: witnesses.asp.root,
        leafIndex: witnesses.asp.leafIndex,
        pathElements: witnesses.asp.pathElements,
        pathIndices: witnesses.asp.pathIndices,
      },
    },
  };

  const { wasmBytes, zkeyBytes } = await traceMethod(
    { kind: "http", label: "GET  pairing.wasm + pairing.zkey  (~5 MB)" },
    () => loadPairingArtifacts(),
  );

  const proof = await traceMethod(
    { kind: "compute", label: "snarkjs.groth16.fullProve  (Groth16 · pairing)" },
    () => generatePairingProof({ witness, wasmBytes, zkeyBytes }),
  );

  const relay = await traceMethod(
    { kind: "http", label: "POST /v1/shielded-payment-requests/:id/solana-pairing-relay" },
    () =>
      submitPairingRelay({
        baseUrl,
        quoteId: quote.quoteId,
        network,
        proofBase64: proof.proofBase64,
        publicSignals: proof.publicSignals,
      }),
  );

  if (relay.ok && relay.signature) {
    await recordPairingProof({
      baseUrl,
      quoteId: quote.quoteId,
      proofBase64: proof.proofBase64,
      publicSignals: proof.publicSignals,
      txHash: relay.signature,
    }).catch(() => { /* best-effort */ });
  }

  return {
    quoteId: quote.quoteId,
    buyerNote,
    commitmentHex,
    depositTxSig,
    depositExplorerUrl: explorerUrlForSolana(depositTxSig, network),
    pairingTxSig: relay.signature ?? null,
    pairingExplorerUrl: relay.signature ? explorerUrlForSolana(relay.signature, network) : null,
    alreadyRelayed: !!relay.alreadyRelayed,
    buyerPubkey: walletKeypair.publicKey.toBase58(),
  };
}
