import {  formatCKB, freeCapacity } from './ckb_capacity.js';

const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8114';

/* ----------------------- RPC helper ----------------------- */

async function rpc(method, params, { timeoutMs = 30_000, retries = 3 } = {}) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctrl.signal,
      });

      const json = await res.json();
      if (json.error) throw new Error(`${method} error: ${JSON.stringify(json.error)}`);
      return json.result;
    } catch (e) {
      lastErr = e;
      // 打印失败，避免“无声”
      console.error(`[rpc] ${method} attempt ${i}/${retries} failed:`, e?.message || e);
      await new Promise(r => setTimeout(r, 300 * i));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

/* ----------------------- DAO constants ----------------------- */

// mainnet DAO type script
const DAO_TYPE = {
  code_hash: '0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e',
  hash_type: 'type',
  args: '0x',
};

function isDaoTypeScript(type) {
  return (
    type &&
    type.code_hash === DAO_TYPE.code_hash &&
    type.hash_type === DAO_TYPE.hash_type &&
    (type.args || '0x') === (DAO_TYPE.args || '0x')
  );
}

// prepare-withdraw cell: output_data != 0x000..00
function isPrepareDaoData(dataHex) {
  return !!dataHex && dataHex !== '0x0000000000000000';
}

/* ----------------------- DAO header parsing ----------------------- */

function parseDaoAR(daoHex) {
  const buf = Buffer.from(daoHex.slice(2), 'hex');
  return buf.readBigUInt64LE(8);
}

/* ----------------------- prepare data parsing ----------------------- */

// prepare-withdraw cell: output_data is u64 little-endian = deposit block number
function parsePrepareBlockNumberHex(outputData) {
  if (!outputData || outputData === '0x') {
    throw new Error(`invalid output_data for prepare-withdraw: ${outputData}`);
  }
  const hex = outputData.startsWith('0x') ? outputData.slice(2) : outputData;
  if (hex.length !== 16) {
    throw new Error(
      `prepare output_data must be 8 bytes (16 hex), got len=${hex.length}: ${outputData}`
    );
  }
  const buf = Buffer.from(hex, 'hex');
  const bn = buf.readBigUInt64LE(0);
  return '0x' + bn.toString(16);
}

/* ----------------------- concurrency helper ----------------------- */

async function mapLimit(arr, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= arr.length) return;
      await fn(arr[idx], idx);
    }
  });
  await Promise.all(workers);
}

/* ----------------------- caches ----------------------- */

// get_transaction cache
const txCache = new Map();

async function getTx(txHash) {
  if (txCache.has(txHash)) return txCache.get(txHash);
  const v = await rpc('get_transaction', [txHash], { timeoutMs: 120_000, retries: 5 });
  txCache.set(txHash, v);
  return v;
}

// AR cache by block_number hex
const arCache = new Map();

async function getARByBlockNumberHex(bnHex) {
  if (arCache.has(bnHex)) return arCache.get(bnHex);
  const h = await rpc('get_header_by_number', [bnHex], { timeoutMs: 120_000, retries: 5 });
  const ar = parseDaoAR(h.dao);
  arCache.set(bnHex, ar);
  return ar;
}

/* ----------------------- core: withdraw2 reward ----------------------- */

// core: withdraw2 reward (per-DAO-input reward)
async function computeWithdraw2Reward() {
  const pageLimit        = process.env.WITHDRAW2_TX_LIMIT || '0x3e8';
  const CONCURRENCY      = Number(process.env.WITHDRAW2_TX_CONCURRENCY || '60');
  const LOG_EVERY        = Number(process.env.WITHDRAW2_LOG_EVERY || '20000');
  const PAGE_LOG_EVERY   = Number(process.env.WITHDRAW2_PAGE_LOG_EVERY || '50');

  // page 日志页打印 tx +（最多）若干条 input 明细
  const PRINT_TX         = (process.env.WITHDRAW2_PRINT_TX ?? '1') === '1';
  const PRINT_TX_MAX     = Number(process.env.WITHDRAW2_PRINT_TX_MAX || '3');       // 每个 page 最多打印几笔 tx 的明细
  const PRINT_INPUT_MAX  = Number(process.env.WITHDRAW2_PRINT_INPUT_MAX || '50');   // 每笔 tx 最多打印多少个 DAO inputs（防刷屏）

  // 额外：抽样打印 multi-input tx（prepare_inputs > 1）的明细
  const PRINT_MULTI_TX_MAX = Number(process.env.WITHDRAW2_PRINT_MULTI_TX_MAX || '10');

  // ✅ 新增：抽样打印 “withdraw2 但 outputs 仍包含 DAO cell”的 tx（不再过滤 outputs）
  const PRINT_WITH_DAO_OUTPUTS_MAX = Number(process.env.WITHDRAW2_PRINT_WITH_DAO_OUTPUTS_MAX || '8');

  const blockFrom = process.env.WITHDRAW2_BLOCK_RANGE_FROM || null;
  const blockTo   = process.env.WITHDRAW2_BLOCK_RANGE_TO   || null;

  console.log('--------------------------------');
  console.log('[withdraw2] start scan');
  console.log('[withdraw2] RPC_URL              =', RPC_URL);
  console.log('[withdraw2] page_limit           =', pageLimit);
  console.log('[withdraw2] concurrency          =', CONCURRENCY);
  console.log('[withdraw2] log_every            =', LOG_EVERY);
  console.log('[withdraw2] page_log_every       =', PAGE_LOG_EVERY);
  if (blockFrom && blockTo) console.log('[withdraw2] block_range          =', `[${blockFrom}, ${blockTo})`);
  console.log('[withdraw2] print_tx             =', PRINT_TX, `max_tx_per_page=${PRINT_TX_MAX}`, `max_inputs_per_tx=${PRINT_INPUT_MAX}`);
  console.log('[withdraw2] print_multi_tx_max   =', PRINT_MULTI_TX_MAX);
  console.log('[withdraw2] print_with_dao_outputs_max =', PRINT_WITH_DAO_OUTPUTS_MAX);

  function isDaoType(type) {
    return (
      type &&
      type.code_hash === DAO_TYPE.code_hash &&
      type.hash_type === DAO_TYPE.hash_type &&
      (type.args || '0x') === (DAO_TYPE.args || '0x')
    );
  }

  // prepare-withdraw cell: output_data != 0x000..00
  function isPrepareDaoData(dataHex) {
    return !!dataHex && dataHex !== '0x0000000000000000';
  }

  // withdraw2（以前用于过滤）：outputs 是否仍包含 DAO cell
  function outputsContainDaoCell(tx) {
    for (const o of tx?.outputs || []) {
      if (o?.type && isDaoType(o.type)) return true;
    }
    return false;
  }

  async function mapLimit(arr, limit, fn) {
    let i = 0;
    const workers = Array.from({ length: limit }, async () => {
      while (true) {
        const idx = i++;
        if (idx >= arr.length) return;
        await fn(arr[idx], idx);
      }
    });
    await Promise.all(workers);
  }

  let cursor = null;
  let page = 0;

  let seenObjects = 0;
  let seenInputObjects = 0;

  // ✅ 全局 tx 去重：避免同一 tx 被 objects 重复打到
  const seenTx = new Set();

  let withdraw2Txs = 0;
  let totalReward = 0n;

  // multi-input 抽样：存 txHash（只存唯一 tx）
  const multiSamples = [];

  // ✅ 新增：withdraw2 但 outputs 仍含 DAO 的抽样
  const daoOutputsSamples = [];

  const started = Date.now();

  while (true) {
    page++;
    const shouldLogPage = page % PAGE_LOG_EVERY === 0;

    const searchKey = { script: DAO_TYPE, script_type: 'type' };
    if (blockFrom && blockTo) searchKey.block_range = [blockFrom, blockTo];

    const params = [searchKey, 'desc', pageLimit];
    if (cursor && cursor !== '0x' && cursor !== '0x0') params.push(cursor);

    const t0 = Date.now();
    const res = await rpc('get_transactions', params, { timeoutMs: 120_000, retries: 5 });
    const dt = ((Date.now() - t0) / 1000).toFixed(2);

    const objs = res.objects || [];
    if (objs.length === 0) {
      if (shouldLogPage) console.log(`[withdraw2] page=${page} objs=0 (${dt}s) -> stop`);
      break;
    }

    let cntInput = 0, cntOutput = 0, cntOther = 0;
    const inputTxHashes = [];

    for (const o of objs) {
      seenObjects++;
      const ioType = o.io_type ?? o.ioType;

      if (ioType === 'input') {
        cntInput++;
        seenInputObjects++;
        const h = o.tx_hash ?? o.txHash;
        if (h && !seenTx.has(h)) {
          seenTx.add(h);
          inputTxHashes.push(h);
        }
      } else if (ioType === 'output') {
        cntOutput++;
      } else {
        cntOther++;
      }
    }

    if (shouldLogPage) {
      console.log(
        `[withdraw2] page=${page} objs=${objs.length} dist input=${cntInput} output=${cntOutput} other=${cntOther} (${dt}s)`
      );
    }

    let withdrawInPage = 0;
    let rewardInPage = 0n;

    // page 日志页：最多打印几笔 tx 的明细
    const pageTxDetailLines = [];
    let pageTxPrinted = 0;

    await mapLimit(inputTxHashes, CONCURRENCY, async (txHash) => {
      const wrap = await getTx(txHash);
      const tx = wrap?.transaction;
      if (!tx) return;

      // ✅ 不再过滤 outputsContainDaoCell(tx)，只记录用于抽样
      const hasDaoOutputs = outputsContainDaoCell(tx);

      // 扫 inputs：逐个找 prepare-withdraw DAO cell
      let prepareInputs = 0;
      let txRewardSum = 0n;

      // 收集每个 input 的明细（只用于打印/抽样，不影响统计）
      const perInputDetails = [];

      const inputs = tx.inputs || [];
      for (let inIdx = 0; inIdx < inputs.length; inIdx++) {
        const inp = inputs[inIdx];
        const prev = inp?.previous_output;
        if (!prev?.tx_hash) continue;

        // prevTx = prepare tx
        const prevWrap = await getTx(prev.tx_hash);
        const ptx = prevWrap?.transaction;
        const pStatus = prevWrap?.tx_status;

        if (!ptx?.outputs?.length) continue;

        const outIndex = Number(prev.index);
        const prevOut = ptx.outputs[outIndex];
        const prevData = (ptx.outputs_data || [])[outIndex];

        // 必须是 DAO type
        if (!prevOut?.type || !isDaoType(prevOut.type)) continue;

        // 必须是 prepare-withdraw cell（data 存 deposit block number）
        if (!isPrepareDaoData(prevData)) continue;

        // prepare height j：用 prepare tx 的确认高度（最可靠）
        const prepareBnHex = pStatus?.block_number;
        if (!prepareBnHex) continue;

        const depositBnHex = parsePrepareBlockNumberHex(prevData);

        // AR_i / AR_j
        const AR_i = await getARByBlockNumberHex(depositBnHex);
        const AR_j = await getARByBlockNumberHex(prepareBnHex);

        // ✅ free capacity：必须用正确的 molecule sizing
        //    这里假设你已经引入了 freeCapacity(output, dataHex)
        //    如果你仍然是 cap-occ，也可以替换成：const free = BigInt(prevOut.capacity) - occupiedCapacity(prevOut, prevData);
        const free = freeCapacity(prevOut, prevData);
        if (free <= 0n) continue;

        // reward_i = (free * AR_j) / AR_i - free
        const reward = (free * AR_j) / AR_i - free;
        if (reward <= 0n) continue;

        prepareInputs++;
        txRewardSum += reward;

        if (perInputDetails.length < PRINT_INPUT_MAX) {
          perInputDetails.push({
            input_index: inIdx,
            prev_tx_hash: prev.tx_hash,
            prev_index: prev.index,
            deposit_bn: depositBnHex,
            prepare_bn: prepareBnHex,
            free,
            reward,
          });
        }
      }

      if (prepareInputs === 0) return;

      // ✅ 统计：按 “每个 input cell 的 reward” 累加
      totalReward += txRewardSum;
      rewardInPage += txRewardSum;

      withdraw2Txs++;
      withdrawInPage++;

      // multi-input 抽样（tx 维度）
      if (prepareInputs > 1 && multiSamples.length < PRINT_MULTI_TX_MAX) {
        multiSamples.push({ txHash, prepareInputs, txRewardSum, perInputDetails });
      }

      // ✅ 新增：withdraw2 但 outputs 仍包含 DAO 的 tx 抽样（不影响统计）
      if (hasDaoOutputs && daoOutputsSamples.length < PRINT_WITH_DAO_OUTPUTS_MAX) {
        daoOutputsSamples.push({ txHash, prepareInputs, txRewardSum, perInputDetails });
      }

      // 只在 page 日志页打印 tx + 每个 input 的 reward 明细
      if (PRINT_TX && shouldLogPage && pageTxPrinted < PRINT_TX_MAX) {
        pageTxPrinted++;

        pageTxDetailLines.push(
          `[withdraw2-tx] page=${page} tx: ${txHash} prepare_inputs=${prepareInputs} reward_sum=${formatCKB(txRewardSum)} CKB`
        );

        for (const d of perInputDetails) {
          pageTxDetailLines.push(
            `  [withdraw2-input] tx: ${txHash} input_index=${d.input_index}` +
            ` prev_tx=${d.prev_tx_hash}:${d.prev_index}` +
            ` deposit_bn=${d.deposit_bn} prepare_bn=${d.prepare_bn}` +
            ` free=${formatCKB(d.free)} reward=${formatCKB(d.reward)} CKB`
          );
        }
      }

      if (withdraw2Txs % LOG_EVERY === 0) {
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        console.log(
          `[progress] withdraw2=${withdraw2Txs} total_reward=${formatCKB(totalReward)} CKB elapsed=${elapsed}s`
        );
      }
    });

    if (shouldLogPage) {
      const elapsedAll = ((Date.now() - started) / 1000).toFixed(1);
      console.log(
        `[withdraw2] page=${page} withdraw2=${withdrawInPage} ` +
        `reward_page=${formatCKB(rewardInPage)} CKB total=${formatCKB(totalReward)} CKB elapsed=${elapsedAll}s`
      );
      if (PRINT_TX && pageTxDetailLines.length > 0) {
        console.log(pageTxDetailLines.join('\n'));
      }
    }

    const last = res.last_cursor;
    if (!last || last === '0x' || last === '0x0') break;
    cursor = last;
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  // ✅ 先打印 multi-input samples
  if (multiSamples.length > 0) {
    console.log('--------------------------------');
    console.log('[withdraw2] multi-input samples (per input details):');
    for (const s of multiSamples) {
      console.log(
        `[withdraw2-multi] tx: ${s.txHash} prepare_inputs=${s.prepareInputs} reward_sum=${formatCKB(s.txRewardSum)} CKB`
      );
      for (const d of s.perInputDetails) {
        console.log(
          `  [withdraw2-input] tx: ${s.txHash} input_index=${d.input_index}` +
          ` prev_tx=${d.prev_tx_hash}:${d.prev_index}` +
          ` deposit_bn=${d.deposit_bn} prepare_bn=${d.prepare_bn}` +
          ` free=${formatCKB(d.free)} reward=${formatCKB(d.reward)} CKB`
        );
      }
    }
  }

  // ✅ 新增：打印 outputs 仍含 DAO 的 withdraw2 tx 抽样
  if (daoOutputsSamples.length > 0) {
    console.log('--------------------------------');
    console.log('[withdraw2] samples: withdraw2 txs WITH DAO outputs (not filtered)');
    for (const s of daoOutputsSamples) {
      console.log(
        `[withdraw2-dao-output] tx: ${s.txHash} prepare_inputs=${s.prepareInputs} reward_sum=${formatCKB(s.txRewardSum)} CKB`
      );
      for (const d of s.perInputDetails) {
        console.log(
          `  [withdraw2-input] tx: ${s.txHash} input_index=${d.input_index}` +
          ` prev_tx=${d.prev_tx_hash}:${d.prev_index}` +
          ` deposit_bn=${d.deposit_bn} prepare_bn=${d.prepare_bn}` +
          ` free=${formatCKB(d.free)} reward=${formatCKB(d.reward)} CKB`
        );
      }
    }
  } else {
    console.log('[withdraw2] no withdraw2 tx found that still outputs DAO cells');
  }

  // ✅ 最后再打印 withdraw2 汇总结果
  console.log('--------------------------------');
  console.log('[withdraw2] done');
  console.log('[withdraw2] seen objects         =', seenObjects);
  console.log('[withdraw2] seen input objects   =', seenInputObjects);
  console.log('[withdraw2] unique tx processed  =', seenTx.size);
  console.log('[withdraw2] withdraw2 txs        =', withdraw2Txs);
  console.log('[withdraw2] withdraw2 reward     =', formatCKB(totalReward), 'CKB');
  console.log('[withdraw2] elapsed              =', elapsed, 's');

  return totalReward;
}

/* ----------------------- main/entry ----------------------- */

async function main() {
  console.log('[entry] dao_withdraw2_reward.js start');
  const tip = await rpc('get_indexer_tip', [], { timeoutMs: 30_000, retries: 3 });
  console.log('[entry] indexer_tip =', tip);
  await computeWithdraw2Reward();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
