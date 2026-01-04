#!/usr/bin/env node
/**
 * Accurate total secondary issuance paid to miners from genesis..tip (mainnet),
 * using ONLY block headers:
 *
 * miner_secondary_i = floor( s_i * U_{i-1} / C_{i-1} )
 *
 * Epoch packed field on YOUR chain (confirmed by samples):
 *   epoch = (length << 40) | (index << 24) | number
 *
 * Extras:
 *  - Streamed computation (no full header cache) with windowed parallel fetch.
 *  - Progress printing with speed/ETA.
 *  - Every 1000 epochs prints samples for first/10th/last block.
 *
 * Env:
 *  - RPC_URL (default http://127.0.0.1:8114)
 *  - CONCURRENCY (default 16)
 *  - START (default 1)
 *  - END (default tip)
 *  - EPOCH_PRINT_STEP (default 1000)
 *  - WINDOW_MULT (default 200)  // windowSize = CONCURRENCY * WINDOW_MULT
 */

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8114";
const CONCURRENCY = Number(process.env.CONCURRENCY || "16");
const EPOCH_PRINT_STEP = Number(process.env.EPOCH_PRINT_STEP || "1000");
const WINDOW_MULT = Number(process.env.WINDOW_MULT || "200");

// Mainnet constant (shannons per epoch). Adjust if you run a different chain.
const SECONDARY_EPOCH_REWARD = 61_369_863_013_698n;

async function rpc(method, params, { timeoutMs = 30_000, retries = 3 } = {}) {
  const body = { id: 42, jsonrpc: "2.0", method, params };
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      clearTimeout(t);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
      return json.result;
    } catch (e) {
      clearTimeout(t);
      if (attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
}

async function getHeaderByNumber(n) {
  return rpc("get_header_by_number", ["0x" + n.toString(16)]);
}

function u64leFromHex16(hex16) {
  const buf = Buffer.from(hex16, "hex");
  let x = 0n;
  for (let i = 0; i < 8; i++) x |= BigInt(buf[i]) << (8n * BigInt(i));
  return x;
}

function parseDao(daoHex) {
  const h = daoHex.startsWith("0x") ? daoHex.slice(2) : daoHex;
  if (h.length !== 64) throw new Error(`dao field must be 32 bytes, got hexlen=${h.length}`);
  const seg = (i) => h.slice(i * 16, (i + 1) * 16);
  const C = u64leFromHex16(seg(0));
  const U = u64leFromHex16(seg(3));
  return { C, U };
}

// ✅ Your chain: epoch = (length<<40) | (index<<24) | number
function parseEpochPacked(epochHex) {
  const e = BigInt(epochHex);
  const length = Number(e >> 40n);                 // high 24 bits
  const index  = Number((e >> 24n) & 0xFFFFn);     // middle 16 bits
  const number = Number(e & 0xFFFFFFn);            // low 24 bits
  return { number, index, length };
}

function perBlockSecondary(epochLength, epochIndex) {
  const L = BigInt(epochLength);
  if (L === 0n) throw new RangeError("Division by zero (epoch.length=0)");
  const q = SECONDARY_EPOCH_REWARD / L;
  const m = SECONDARY_EPOCH_REWARD % L;
  const idx = BigInt(epochIndex);
  return idx < m ? (q + 1n) : q;
}

function formatCkbFromShannon(shannon) {
  const sign = shannon < 0n ? "-" : "";
  const x = shannon < 0n ? -shannon : shannon;
  const CKB = 100_000_000n;
  const intPart = x / CKB;
  const frac = x % CKB;
  const fracStr = frac.toString().padStart(8, "0").replace(/0+$/, "");
  return fracStr.length ? `${sign}${intPart}.${fracStr}` : `${sign}${intPart}`;
}

function fmtHMS(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s
    .toString()
    .padStart(2, "0")}`;
}

function printProgress(done, total, startAt) {
  const now = Date.now();
  const elapsedSec = (now - startAt) / 1000;
  const speed = elapsedSec > 0 ? done / elapsedSec : 0;
  const pct = (done / total) * 100;
  const remain = total - done;
  const etaSec = speed > 0 ? remain / speed : 0;
  console.log(
    `Processed blocks: ${done.toLocaleString()} / ${total.toLocaleString()} ` +
    `(${pct.toFixed(2)}%) | ${speed.toFixed(0)} blk/s | ETA ${fmtHMS(etaSec)}`
  );
}

function shouldPrintEpoch(epochNumber) {
  return EPOCH_PRINT_STEP > 0 && epochNumber % EPOCH_PRINT_STEP === 0;
}

function toHex(n) {
  return "0x" + n.toString(16);
}

function printCheckSample({ label, blockNumber, epoch, s_i, Cprev, Uprev, miner_i }) {
  const ratio = Cprev === 0n ? 0 : Number(Uprev) / Number(Cprev);
  const displayBlock = blockNumber + 11;

  console.log("==== CHECK SAMPLE ====");
  console.log(`label              = ${label}`);
  console.log(`epoch_number        = ${epoch.number}`);
  console.log(`block_number        = ${blockNumber} (${toHex(blockNumber)})`);
  console.log(`epoch_index         = ${epoch.index}`);
  console.log(`epoch_length        = ${epoch.length}`);
  console.log(`epoch_packed        = ${epoch.raw}`);
  console.log(`per_block_secondary = ${s_i} shannons (${formatCkbFromShannon(s_i)} CKB)`);
  console.log(`prev_C              = ${Cprev}`);
  console.log(`prev_U              = ${Uprev}`);
  console.log(`U_over_C            = ${ratio.toFixed(12)}`);
  console.log(`miner_secondary     = ${miner_i} shannons (${formatCkbFromShannon(miner_i)} CKB)`);

  // ✅ what you asked for: +11 block number
  console.log(`reward_display_blk  = ${displayBlock} (${toHex(displayBlock)})`);

  console.log("======================");
}

async function main() {
  const tip = await rpc("get_tip_header", []);
  const tipNumber = Number(BigInt(tip.number));

  const start = Number(process.env.START || "1");
  const end = Number(process.env.END || String(tipNumber));
  if (start < 1) throw new Error("START must be >= 1 (needs previous header)");
  if (end > tipNumber) throw new Error(`END (${end}) > tip (${tipNumber})`);

  console.log(`RPC_URL=${RPC_URL}`);
  console.log(`Range: [${start}, ${end}] (tip=${tipNumber})`);
  console.log(`CONCURRENCY=${CONCURRENCY}`);
  console.log(`EPOCH_PRINT_STEP=${EPOCH_PRINT_STEP}`);
  console.log(`WINDOW_MULT=${WINDOW_MULT}`);
  console.log(`SECONDARY_EPOCH_REWARD=${SECONDARY_EPOCH_REWARD} shannons/epoch`);

  let prevHeader = await getHeaderByNumber(start - 1);

  let totalMinerSecondary = 0n;
  const totalBlocks = end - start + 1;
  let processed = 0;

  // epochNumber -> Set<index>
  const printed = new Map();
  const markPrinted = (ep, idx) => {
    let s = printed.get(ep);
    if (!s) printed.set(ep, (s = new Set()));
    s.add(idx);
  };
  const isPrinted = (ep, idx) => (printed.get(ep)?.has(idx) ?? false);

  const t0 = Date.now();

  let cur = start;
  const windowSize = Math.max(1, CONCURRENCY * WINDOW_MULT);

  while (cur <= end) {
    const winFrom = cur;
    const winTo = Math.min(end, winFrom + windowSize - 1);
    const count = winTo - winFrom + 1;

    const out = new Array(count);
    let next = winFrom;

    async function worker() {
      while (true) {
        const n = next++;
        if (n > winTo) return;
        const h = await getHeaderByNumber(n);
        out[n - winFrom] = h;
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    for (let k = 0; k < out.length; k++) {
      const i = winFrom + k;
      const curHeader = out[k];

      const { C: Cprev, U: Uprev } = parseDao(prevHeader.dao);

      if (typeof curHeader.epoch !== "string") {
        console.error("BAD header.epoch type at block", i, "epoch=", curHeader.epoch);
        process.exit(1);
      }

      const ep = parseEpochPacked(curHeader.epoch);
      ep.raw = curHeader.epoch;

      if (!Number.isFinite(ep.length) || ep.length <= 0) {
        console.error("BAD epoch length at block", i, "epoch=", curHeader.epoch);
        console.error("parsed epoch=", ep);
        console.error("header=", curHeader);
        process.exit(1);
      }

      const s_i = perBlockSecondary(ep.length, ep.index);
      const miner_i = (s_i * Uprev) / Cprev;
      totalMinerSecondary += miner_i;

      if (shouldPrintEpoch(ep.number)) {
        const wantIdxs = [0, 10, Math.max(0, ep.length - 1)];
        if (wantIdxs.includes(ep.index) && !isPrinted(ep.number, ep.index)) {
          const label =
            ep.index === 0 ? "first" :
              ep.index === 10 ? "tenth" :
                ep.index === ep.length - 1 ? "last" : `idx_${ep.index}`;

          printCheckSample({ label, blockNumber: i, epoch: ep, s_i, Cprev, Uprev, miner_i });
          markPrinted(ep.number, ep.index);
        }
      }

      processed++;
      if (processed % 200000 === 0) printProgress(processed, totalBlocks, t0);

      prevHeader = curHeader;
    }

    cur = winTo + 1;
  }

  printProgress(processed, totalBlocks, t0);
  console.log("---- RESULT ----");
  console.log(`Total miner secondary (shannons): ${totalMinerSecondary}`);
  console.log(`Total miner secondary (CKB):     ${formatCkbFromShannon(totalMinerSecondary)} CKB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
