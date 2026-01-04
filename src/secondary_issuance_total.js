// src/secondary_issuance_total.js
// Node >= 18

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8114";

// 每个 epoch 的二级发行（单位：shannons / epoch）
const SECONDARY_EPOCH_REWARD = 613_698_63013698n;

// 1 CKB = 1e8 shannons
const SHANNONS_PER_CKB = 100_000_000n;

/* ----------------------- RPC helper ----------------------- */

async function rpc(method, params, { timeoutMs = 30_000, retries = 3 } = {}) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: ctrl.signal,
      });
      const json = await res.json();
      if (json.error) throw new Error(`${method} error: ${JSON.stringify(json.error)}`);
      return json.result;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 300 * i));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

/* ----------------------- epoch parser (use your version) ----------------------- */

function parseEpochPacked(epochHex) {
  const e = BigInt(epochHex);
  const length = Number(e >> 40n);                 // high 24 bits
  const index  = Number((e >> 24n) & 0xFFFFn);     // middle 16 bits
  const number = Number(e & 0xFFFFFFn);            // low 24 bits
  return { number, index, length };
}

/* ----------------------- formatting ----------------------- */

function formatCKB(shannons) {
  const v = shannons < 0n ? -shannons : shannons;
  const sign = shannons < 0n ? "-" : "";
  const whole = v / SHANNONS_PER_CKB;
  const frac = v % SHANNONS_PER_CKB;
  return `${sign}${whole.toString()}.${frac.toString().padStart(8, "0")}`;
}

/* ----------------------- main ----------------------- */

async function main() {
  const tip = await rpc("get_tip_header", []);
  const { number, index, length } = parseEpochPacked(tip.epoch);

  // (epochNumber - 1) * reward + reward * index / length
  const fullEpochs = BigInt(Math.max(0, number - 1));
  const part = (SECONDARY_EPOCH_REWARD * BigInt(index)) / BigInt(length);
  const total = fullEpochs * SECONDARY_EPOCH_REWARD + part;

  console.log("RPC_URL = ", RPC_URL);
  console.log("TIP_BLOCK = ", BigInt(tip.number).toString(), `(hex=${tip.number})`);
  console.log("EPOCH = ", `${number} (${index}/${length})`, `(packed=${tip.epoch})`);
  console.log("SECONDARY_EPOCH_REWARD = ", formatCKB(SECONDARY_EPOCH_REWARD), "CKB/epoch");
  console.log("--------------------------------");
  console.log("Secondary issuance total (estimated) = ", formatCKB(total), "CKB");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
