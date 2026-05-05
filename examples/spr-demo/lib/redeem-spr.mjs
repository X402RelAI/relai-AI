// `redeemSPR(...)` — seller-side end-to-end helper for SPR on Solana.
// Vendored from 402-everywhere/examples/spr-agent/src/redeem-spr.mjs and
// extended with HTTP-fetched circuit artefacts + traceMethod() calls.
//
// Flow:
//   1. derive stealth keypair from wallet.signMessage(`relai-spr-stealth-seller:v1:<quoteId>`)
//   2. fetch redeem-proof-input    (service-key-gated)
//   3. snarkjs.groth16.fullProve   (redeem circuit)
//   4. POST /solana-redeem-relay   → operator broadcasts payout-to-seller
//      → on-chain split: 0.95 → stealth ATA, 0.05 → fee collector ATA
//   5. build stealth-claim tx      (transferChecked stealth_ata → main_ata)
//      partial-signed by stealth, fee_payer = relayer
//   6. POST /solana-stealth-claim-relay → operator co-signs + broadcasts
//      → 0.95 USDC ends up in seller's main wallet ATA

import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createTransferCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { deriveSellerStealthKeypairFromKeypair } from "./stealth-keypair.mjs";
import { generateRedeemProof } from "./redeem-prover.mjs";
import {
  getRedeemProofInput,
  submitRedeemRelay,
  submitStealthClaimRelay,
  netFromFace,
} from "./redeem-flow.mjs";
import { loadRedeemArtifacts } from "./circuit-artifacts.mjs";
import { traceMethod } from "../shared/visuals.mjs";

const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";
const SOLANA_MAINNET_RPC = "https://api.mainnet-beta.solana.com";

function rpcUrlForNetwork(network) {
  if (network === "solana-devnet") return SOLANA_DEVNET_RPC;
  if (network === "solana") return SOLANA_MAINNET_RPC;
  throw new Error(`redeemSPR: unsupported network ${network}`);
}

function usdcMintForNetwork(network) {
  if (network === "solana-devnet") {
    return new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  }
  if (network === "solana") {
    return new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  }
  throw new Error(`redeemSPR: no USDC mint for ${network}`);
}

function explorerUrlForSolana(signature, network) {
  const cluster = network === "solana-devnet" ? "?cluster=devnet" : "";
  return `https://solscan.io/tx/${signature}${cluster}`;
}

export async function redeemSPR(params) {
  const { baseUrl, serviceKey, quoteId, walletKeypair, rpcUrl, usdcMint } = params;

  const stealthKp = await traceMethod(
    { kind: "compute", label: "derive stealth keypair  sha256(wallet.sign(challenge))" },
    async () => deriveSellerStealthKeypairFromKeypair({ quoteId, walletKeypair }),
  );

  const proofInput = await traceMethod(
    { kind: "http", label: "GET  /v1/shielded-payment-requests/:id/redeem-proof-input" },
    () => getRedeemProofInput({ baseUrl, serviceKey, quoteId }),
  );

  const network = params.network || proofInput.network;
  if (!network) throw new Error("redeemSPR: cannot resolve network for quote");
  const connection = new Connection(rpcUrl || rpcUrlForNetwork(network), "confirmed");
  const mint = usdcMint ? new PublicKey(usdcMint) : usdcMintForNetwork(network);

  const { wasmBytes, zkeyBytes } = await traceMethod(
    { kind: "http", label: "GET  redeem.wasm + redeem.zkey  (~1.5 MB)" },
    () => loadRedeemArtifacts(),
  );

  const redeemProof = await traceMethod(
    { kind: "compute", label: "snarkjs.groth16.fullProve  (Groth16 · redeem)" },
    () =>
      generateRedeemProof({
        proofInput: {
          amount: proofInput.amount,
          sellerSecret: proofInput.sellerSecret,
          nonce: proofInput.nonce,
          quoteId: proofInput.quoteId,
        },
        recipientBytes: stealthKp.publicKey.toBytes(),
        wasmBytes,
        zkeyBytes,
      }),
  );

  const facePaid = BigInt(proofInput.amount);
  const relay = await traceMethod(
    { kind: "http", label: "POST /v1/shielded-payment-requests/:id/solana-redeem-relay" },
    () =>
      submitRedeemRelay({
        baseUrl,
        quoteId,
        network,
        proofBase64: redeemProof.proofBase64,
        recipientHex: redeemProof.recipientHex,
        recipientPubkey: stealthKp.publicKey.toBase58(),
        quoteNullifierHex: redeemProof.quoteNullifierHex,
        claimedAmountAtomic: facePaid.toString(),
      }),
  );
  if (!relay.ok) throw new Error(`redeemSPR: relay failed (${relay.reason || "unknown"})`);

  const relayerPubkey = relay.relayer ? new PublicKey(relay.relayer) : null;

  const { net } = netFromFace(facePaid.toString());
  const stealthAta = getAssociatedTokenAddressSync(mint, stealthKp.publicKey, false);
  const mainAta = getAssociatedTokenAddressSync(mint, walletKeypair.publicKey, false);

  let claimSignature = null;
  await traceMethod(
    { kind: "chain", label: "build stealth→main claim tx  (partial-signed, relayer fee_payer)" },
    async () => {
      const claimTx = new Transaction();
      const mainAtaInfo = await connection.getAccountInfo(mainAta);
      if (!mainAtaInfo) {
        if (!relayerPubkey) {
          throw new Error("redeemSPR: relayer pubkey missing on already-redeemed path; cannot build claim tx without it (main ATA missing)");
        }
        claimTx.add(
          createAssociatedTokenAccountIdempotentInstruction(
            relayerPubkey,
            mainAta,
            walletKeypair.publicKey,
            mint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID,
          ),
        );
      }
      claimTx.add(
        createTransferCheckedInstruction(
          stealthAta, mint, mainAta, stealthKp.publicKey, net, 6, [], TOKEN_PROGRAM_ID,
        ),
      );
      if (!relayerPubkey) return; // already-redeemed short-circuit
      claimTx.feePayer = relayerPubkey;
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      claimTx.recentBlockhash = blockhash;
      claimTx.partialSign(stealthKp);
      const txBase64 = claimTx.serialize({ requireAllSignatures: false }).toString("base64");
      const claimRes = await submitStealthClaimRelay({
        baseUrl,
        network,
        txBase64,
        expectedAuthority: stealthKp.publicKey.toBase58(),
      });
      claimSignature = claimRes.signature ?? null;
    },
  );

  void SystemProgram;

  return {
    redeemSignature: relay.signature ?? "",
    redeemExplorerUrl: relay.signature ? explorerUrlForSolana(relay.signature, network) : null,
    claimSignature,
    claimExplorerUrl: claimSignature ? explorerUrlForSolana(claimSignature, network) : null,
    alreadyRedeemed: !!relay.alreadyRedeemed,
    stealthPubkey: stealthKp.publicKey.toBase58(),
    netAmountAtomic: net.toString(),
    feeAmountAtomic: (facePaid - net).toString(),
    network,
  };
}
