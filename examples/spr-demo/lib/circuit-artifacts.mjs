// Fetch SPR circuit artefacts (.wasm + .zkey) once per run and hand them
// to snarkjs as Uint8Array. The reference spr-agent points at filesystem
// paths under `frontend/public/zk/...`; the demo runs against the live
// API (`https://relai.fi`), so we pull them over HTTPS.
//
// Override URLs via env if the hosting layout changes:
//   SPR_PAIRING_WASM_URL / SPR_PAIRING_ZKEY_URL
//   SPR_REDEEM_WASM_URL  / SPR_REDEEM_ZKEY_URL

const FRONTEND_BASE = process.env.RELAI_FRONTEND_URL || "https://relai.fi";

const URLS = {
  pairing: {
    wasm: process.env.SPR_PAIRING_WASM_URL || `${FRONTEND_BASE}/zk/shielded-payment-pairing/pairing.wasm`,
    zkey: process.env.SPR_PAIRING_ZKEY_URL || `${FRONTEND_BASE}/zk/shielded-payment-pairing/pairing.zkey`,
  },
  redeem: {
    wasm: process.env.SPR_REDEEM_WASM_URL || `${FRONTEND_BASE}/zk/shielded-payment-redeem/redeem.wasm`,
    zkey: process.env.SPR_REDEEM_ZKEY_URL || `${FRONTEND_BASE}/zk/shielded-payment-redeem/redeem.zkey`,
  },
};

const cache = new Map();

async function fetchAsBytes(url) {
  if (cache.has(url)) return cache.get(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url} → HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  const bytes = new Uint8Array(ab);
  cache.set(url, bytes);
  return bytes;
}

export async function loadPairingArtifacts() {
  const [wasmBytes, zkeyBytes] = await Promise.all([
    fetchAsBytes(URLS.pairing.wasm),
    fetchAsBytes(URLS.pairing.zkey),
  ]);
  return { wasmBytes, zkeyBytes };
}

export async function loadRedeemArtifacts() {
  const [wasmBytes, zkeyBytes] = await Promise.all([
    fetchAsBytes(URLS.redeem.wasm),
    fetchAsBytes(URLS.redeem.zkey),
  ]);
  return { wasmBytes, zkeyBytes };
}
