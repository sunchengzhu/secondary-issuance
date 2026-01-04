// src/dao_withdraw_phase2_reward.js
// Node >= 18 (global fetch + AbortController)

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

/* ----------------------- formatting ----------------------- */

function formatCKB(shannons) {
  const v = shannons < 0n ? -shannons : shannons;
  const sign = shannons < 0n ? '-' : '';
  const whole = v / 100_000_000n;
  const frac = v % 100_000_000n;
  return `${sign}${whole.toString()}.${frac.toString().padStart(8, '0')}`;
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

/* ----------------------- core: withdraw2 reward ----------------------- */

async function computeWithdrawPhase2Reward() {
  const pageLimit      = process.env.WITHDRAW2_TX_LIMIT || '0x3e8';
  const CONCURRENCY    = Number(process.env.WITHDRAW2_TX_CONCURRENCY || '60');
  const LOG_EVERY      = Number(process.env.WITHDRAW2_LOG_EVERY || '20000');
  const PAGE_LOG_EVERY = Number(process.env.WITHDRAW2_PAGE_LOG_EVERY || '50');

  // 默认开启：只在 page 日志页打印（最多 PRINT_TX_MAX 条）
  const PRINT_TX = (process.env.WITHDRAW2_PRINT_TX ?? '1') === '1';
  const PRINT_TX_MAX = Number(process.env.WITHDRAW2_PRINT_TX_MAX || '5');

  const blockFrom = process.env.WITHDRAW2_BLOCK_RANGE_FROM || null;
  const blockTo   = process.env.WITHDRAW2_BLOCK_RANGE_TO   || null;

  console.log('--------------------------------');
  console.log('[withdraw2] start scan');
  console.log('[withdraw2] RPC_URL           =', RPC_URL);
  console.log('[withdraw2] page_limit        =', pageLimit);
  console.log('[withdraw2] concurrency       =', CONCURRENCY);
  console.log('[withdraw2] log_every         =', LOG_EVERY);
  console.log('[withdraw2] page_log_every    =', PAGE_LOG_EVERY);
  if (blockFrom && blockTo) console.log('[withdraw2] block_range       =', `[${blockFrom}, ${blockTo})`);

  // tx cache
  const txCache = new Map();
  async function getTx(txHash) {
    if (txCache.has(txHash)) return txCache.get(txHash);
    const v = await rpc('get_transaction', [txHash], { timeoutMs: 120_000, retries: 5 });
    txCache.set(txHash, v);
    return v;
  }

  // 过滤条件：二阶段 withdraw 的 outputs 不应再含 DAO cell
  function outputsContainDaoCell(tx) {
    for (const o of tx?.outputs || []) {
      if (o?.type && isDaoTypeScript(o.type)) return true;
    }
    return false;
  }

  let cursor = null;
  let page = 0;

  let seenObjects = 0;
  let seenInputObjects = 0;

  let withdraw2Txs = 0;
  let totalReward = 0n;

  const started = Date.now();

  while (true) {
    page++;
    const shouldLogPage = page % PAGE_LOG_EVERY === 0;

    const searchKey = {
      script: DAO_TYPE,
      script_type: 'type',
      // 不使用 group_by_transaction
    };
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
        if (h) inputTxHashes.push(h);
      } else if (ioType === 'output') {
        cntOutput++;
      } else {
        cntOther++;
      }
    }

    if (shouldLogPage) {
      console.log(
        `[withdraw2] page=${page} objs=${objs.length} ` +
        `dist input=${cntInput} output=${cntOutput} other=${cntOther} (${dt}s)`
      );
    }

    let withdrawInPage = 0;
    let rewardInPage = 0n;

    // page 日志页才收集 txLines（不然就不浪费内存/字符串拼接）
    let txLines = null;
    let txPrinted = 0;
    if (PRINT_TX && shouldLogPage) txLines = [];

    await mapLimit(inputTxHashes, CONCURRENCY, async (txHash) => {
      const wrap = await getTx(txHash);
      const tx = wrap?.transaction;
      if (!tx) return;

      if (outputsContainDaoCell(tx)) return;
      if ((tx.inputs?.length || 0) !== 1) return;
      if ((tx.outputs?.length || 0) !== 1) return;

      const prev = tx.inputs[0]?.previous_output;
      if (!prev?.tx_hash) return;

      const prevWrap = await getTx(prev.tx_hash);
      const ptx = prevWrap?.transaction;
      if (!ptx?.outputs?.length) return;

      const idx = Number(prev.index);
      const prevOut = ptx.outputs[idx];
      const prevData = (ptx.outputs_data || [])[idx];

      // prevOut 必须是 DAO cell
      if (!prevOut?.type || !isDaoTypeScript(prevOut.type)) return;

      // prevOut 必须是 prepare-withdraw（data != 0x000..00）
      if (!prevData || prevData === '0x0000000000000000') return;

      const outCap = BigInt(tx.outputs[0].capacity);
      const inCap  = BigInt(prevOut.capacity);
      const delta  = outCap - inCap;

      if (delta > 0n) {
        totalReward += delta;
        rewardInPage += delta;

        if (txLines && txPrinted < PRINT_TX_MAX) {
          txPrinted++;
          txLines.push(
            `[withdraw2-tx] page=${page} tx=${txHash} reward=${formatCKB(delta)} CKB`
          );
        }
      }

      withdraw2Txs++;
      withdrawInPage++;

      if (withdraw2Txs % LOG_EVERY === 0) {
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        console.log(
          `[progress] withdraw2=${withdraw2Txs} ` +
          `total_reward=${formatCKB(totalReward)} CKB elapsed=${elapsed}s`
        );
      }
    });

    if (shouldLogPage) {
      const elapsedAll = ((Date.now() - started) / 1000).toFixed(1);
      console.log(
        `[withdraw2] page=${page} withdraw2=${withdrawInPage} ` +
        `reward_page=${formatCKB(rewardInPage)} CKB ` +
        `total=${formatCKB(totalReward)} CKB elapsed=${elapsedAll}s`
      );

      if (txLines && txLines.length > 0) {
        console.log(txLines.join('\n'));
      }
    }

    const last = res.last_cursor;
    if (!last || last === '0x' || last === '0x0') break;
    cursor = last;
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log('--------------------------------');
  console.log('[withdraw2] done');
  console.log('[withdraw2] seen objects         =', seenObjects);
  console.log('[withdraw2] seen input objects   =', seenInputObjects);
  console.log('[withdraw2] withdraw2 txs        =', withdraw2Txs);
  console.log('[withdraw2] withdraw2 reward     =', formatCKB(totalReward), 'CKB');
  console.log('[withdraw2] elapsed              =', elapsed, 's');

  return totalReward;
}

/* ----------------------- main/entry ----------------------- */

async function main() {
  console.log('[entry] dao_withdraw_phase2_reward.js start');
  const tip = await rpc('get_indexer_tip', [], { timeoutMs: 30_000, retries: 3 });
  console.log('[entry] indexer_tip =', tip);

  await computeWithdrawPhase2Reward();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
