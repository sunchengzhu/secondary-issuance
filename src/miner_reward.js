// src/miner_reward.js
// Node >= 18
//
// Miner reward = sum of block.transactions[0].outputs[0].capacity
// from height 0 to (tip - END_OFFSET), using JSON-RPC batch.
// Supports checkpoint resume.

import fs from "fs";
import path from "path";

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8114";
const BATCH_SIZE = Number(process.env.BATCH_SIZE || "200");
const END_OFFSET = BigInt(process.env.END_OFFSET || "11");
const LOG_EVERY_BATCH = Number(process.env.LOG_EVERY_BATCH || "20");

// checkpoint file path
const CHECKPOINT_FILE =
  process.env.CHECKPOINT_FILE || path.join(process.cwd(), "miner_reward.checkpoint.json");

// write checkpoint every N batches (default 1 = every batch)
const CHECKPOINT_EVERY_BATCH = Number(process.env.CHECKPOINT_EVERY_BATCH || "1");

/* ---------------- helpers ---------------- */

function toHex(n) {
  return "0x" + BigInt(n).toString(16);
}

function formatCKB(shannons) {
  const whole = shannons / 100_000_000n;
  const frac = shannons % 100_000_000n;
  return `${whole}.${frac.toString().padStart(8, "0")}`;
}

function extractMinerReward(block) {
  if (!block) return null;
  const tx0 = block.transactions?.[0];
  if (!tx0) return null;
  const out0 = tx0.outputs?.[0];
  if (!out0 || out0.capacity == null) return null;
  return BigInt(out0.capacity);
}

async function rpcSingle(method, params, { timeoutMs = 60_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
      signal: ctrl.signal,
    });
    const json = await res.json();
    if (json.error) throw new Error(`${method} error: ${JSON.stringify(json.error)}`);
    return json.result;
  } finally {
    clearTimeout(t);
  }
}

async function rpcBatch(calls, { timeoutMs = 120_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(calls),
      signal: ctrl.signal,
    });
    return await res.json(); // array
  } finally {
    clearTimeout(t);
  }
}

async function getTip() {
  const header = await rpcSingle("get_tip_header", []);
  return {
    tipHex: header.number,
    tipDec: BigInt(header.number),
    tipHash: header.hash,
  };
}

/* ---------------- checkpoint I/O ---------------- */

function loadCheckpoint() {
  if (!fs.existsSync(CHECKPOINT_FILE)) return null;
  try {
    const raw = fs.readFileSync(CHECKPOINT_FILE, "utf8");
    const j = JSON.parse(raw);
    if (typeof j.next_height !== "string" || typeof j.sum_shannons !== "string") return null;
    return {
      nextHeight: BigInt(j.next_height),
      sum: BigInt(j.sum_shannons),
      endHeight: j.end_height != null ? BigInt(j.end_height) : null,
      updatedAt: j.updated_at || null,
    };
  } catch {
    return null;
  }
}

function atomicWriteJson(filePath, obj) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

function saveCheckpoint({ nextHeight, sum, endHeight }) {
  atomicWriteJson(CHECKPOINT_FILE, {
    next_height: nextHeight.toString(),
    sum_shannons: sum.toString(),
    end_height: endHeight.toString(),
    updated_at: new Date().toISOString(),
  });
}

/* ---------------- main ---------------- */

async function main() {
  const { tipHex, tipDec, tipHash } = await getTip();
  const endHeight = tipDec - END_OFFSET;

  console.log("RPC_URL        =", RPC_URL);
  console.log("TIP_HEIGHT     =", tipDec.toString(), `(hex=${tipHex})`);
  console.log("TIP_HASH       =", tipHash);
  console.log("END_HEIGHT     =", endHeight.toString(), `(tip-${END_OFFSET.toString()})`);
  console.log("BATCH_SIZE     =", BATCH_SIZE);
  console.log("CHECKPOINT     =", CHECKPOINT_FILE);
  console.log("--------------------------------");

  // resume
  let startHeight = 0n;
  let sum = 0n;

  const ckpt = loadCheckpoint();
  if (ckpt) {
    // 如果 endHeight 变了（tip 变了），也可以继续跑：我们只需跑到新的 endHeight
    startHeight = ckpt.nextHeight;
    sum = ckpt.sum;
    console.log(
      `[resume] next_height=${startHeight.toString()} sum=${formatCKB(sum)} CKB updated_at=${ckpt.updatedAt || "?"}`
    );
  }

  if (startHeight > endHeight) {
    console.log("[done] checkpoint already beyond endHeight, nothing to do.");
    console.log("Miner reward total =", formatCKB(sum), "CKB");
    return;
  }

  let batchCount = 0;
  const started = Date.now();

  for (let base = startHeight; base <= endHeight; base += BigInt(BATCH_SIZE)) {
    const calls = [];
    let actual = 0;

    for (let i = 0; i < BATCH_SIZE; i++) {
      const h = base + BigInt(i);
      if (h > endHeight) break;
      calls.push({
        id: i,
        jsonrpc: "2.0",
        method: "get_block_by_number",
        params: [toHex(h)],
      });
      actual++;
    }

    const results = await rpcBatch(calls);

    const byId = new Map(results.map((r) => [r.id, r]));
    for (let i = 0; i < actual; i++) {
      const r = byId.get(i);
      if (!r || r.error) continue;
      const cap = extractMinerReward(r.result);
      if (cap != null) sum += cap;
    }

    batchCount++;

    const scanned = base + BigInt(actual); // “已处理到”的下一个高度
    if (batchCount % CHECKPOINT_EVERY_BATCH === 0) {
      saveCheckpoint({ nextHeight: scanned, sum, endHeight });
    }

    if (batchCount % LOG_EVERY_BATCH === 0) {
      const pct = Number(scanned * 10_000n / (endHeight + 1n)) / 100; // +1 让 0..end 更像“总量”
      const elapsedSec = (Date.now() - started) / 1000;
      const speed = Number(scanned - startHeight) / Math.max(1, elapsedSec); // blocks/sec
      const remaining = Number((endHeight + 1n) - scanned);
      const etaMin = (remaining / Math.max(1e-9, speed)) / 60;

      console.log(
        `[progress] scanned<=${scanned.toString()}/${(endHeight + 1n).toString()} (${pct.toFixed(2)}%) ` +
        `sum=${formatCKB(sum)} CKB ` +
        `elapsed=${elapsedSec.toFixed(1)}s ETA=${etaMin.toFixed(1)}min`
      );
    }
  }

  // final checkpoint
  saveCheckpoint({ nextHeight: endHeight + 1n, sum, endHeight });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log("--------------------------------");
  console.log("Miner reward total =", sum.toString(), "shannons");
  console.log("Miner reward total =", formatCKB(sum), "CKB");
  console.log("Elapsed            =", `${elapsed}s`);
  console.log(`Checkpoint saved   = ${CHECKPOINT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
