import { occupiedCapacity, formatCKB, freeCapacity } from './ckb_capacity.js';

const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8114';
const LIMIT_CELLS = process.env.LIMIT || '0x64';
// 默认目标 lock（格式：code_hash|hash_type|args）
const DEFAULT_LOCK = '0x9b819793a64463aed77c615d6cb226eea5487ccfc0783043a587254cda2b6f26|type|0x04131d4889bb3210c284e968dd9eec5897146252aa00';

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
      if (json.error) throw new Error(JSON.stringify(json.error));
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

function lockKey(lock) {
  if (!lock) return 'null';
  return `${lock.code_hash}|${lock.hash_type}|${lock.args || '0x'}`;
}

const DAO_TYPE = {
  code_hash: '0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e',
  hash_type: 'type',
  args: '0x',
};

function parseDaoAR(daoHex) {
  const buf = Buffer.from(daoHex.slice(2), 'hex');
  return buf.readBigUInt64LE(8);
}

async function getIndexerARandS() {
  const tip = await rpc('get_indexer_tip', []);
  const header = await rpc('get_header', [tip.block_hash]);
  return {
    AR: parseDaoAR(header.dao),
    heightHex: tip.block_number,
    heightDec: BigInt(tip.block_number).toString(),
  };
}

async function* getDaoLiveCells() {
  let cursor = null;
  while (true) {
    const params = [{ script: DAO_TYPE, script_type: 'type' }, 'asc', LIMIT_CELLS];
    if (cursor && cursor !== '0x' && cursor !== '0x0') params.push(cursor);

    const res = await rpc('get_cells', params, { timeoutMs: 120_000 });
    if (!res.objects || res.objects.length === 0) break;

    for (const c of res.objects) yield c;

    const last = res.last_cursor;
    if (!last || last === '0x' || last === '0x0') break;
    cursor = last;
  }
}

function parsePrepareBlockNumberHex(outputData) {
  if (!outputData || outputData === '0x') {
    throw new Error(`invalid output_data for prepare-withdraw: ${outputData}`);
  }
  const hex = outputData.startsWith('0x') ? outputData.slice(2) : outputData;
  if (hex.length !== 16) {
    throw new Error(`prepare output_data must be 8 bytes (16 hex), got len=${hex.length}: ${outputData}`);
  }
  const buf = Buffer.from(hex, 'hex');
  const bn = buf.readBigUInt64LE(0);
  return '0x' + bn.toString(16);
}

async function getARByBlockNumberHex(bnHex, arCache) {
  if (arCache.has(bnHex)) return arCache.get(bnHex);
  const h = await rpc('get_header_by_number', [bnHex], { timeoutMs: 120_000, retries: 5 });
  const ar = parseDaoAR(h.dao);
  arCache.set(bnHex, ar);
  return ar;
}

function usage() {
  console.error('Usage: node src/addr_comp.js [code_hash|hash_type|args]');
  console.error('Example: node src/addr_comp.js 0xd00c84f0ec8fd441c38bc3f87a371f547190f2fcff88e642bc5bf54b9e318323|type|0x000154d314d909c2e3771d9058cfe2559797fb17979a');
}

async function main() {
  const argv = process.argv.slice(2);
  const lockInput = argv[0] || process.env.TARGET_LOCK || DEFAULT_LOCK;

  let targetLock;
  try {
    const [codeHash, hashType, args] = lockInput.split('|');
    if (!codeHash || !hashType || !args) {
      throw new Error('Invalid lock format. Use code_hash|hash_type|args');
    }
    targetLock = { code_hash: codeHash, hash_type: hashType, args };
  } catch (e) {
    console.error('Failed to parse lock:', e.message);
    usage();
    process.exit(1);
  }

  const targetKey = lockKey(targetLock);

  const { AR, heightDec, heightHex } = await getIndexerARandS();

  console.log('RPC_URL        =', RPC_URL);
  console.log('INDEXER_HEIGHT =', heightDec, `(hex=${heightHex})`);
  console.log('AR             =', AR.toString());
  console.log('Target lock    =', targetKey);
  console.log('Code Hash      =', targetLock.code_hash);
  console.log('Hash Type      =', targetLock.hash_type);
  console.log('Args           =', targetLock.args);

  const arCache = new Map();

  let unclaimedDeposit = 0n;
  let unclaimedPrepare = 0n;
  let cntDeposit = 0;
  let cntPrepare = 0;
  let unclaimedDepositCapacity = 0n;

  for await (const c of getDaoLiveCells()) {
    const k = lockKey(c.output.lock);
    if (k !== targetKey) continue;

    const cap = BigInt(c.output.capacity);
    const occ = occupiedCapacity(c.output, c.output_data);
    const free = cap - occ;

    if (c.output_data === '0x0000000000000000') {
      cntDeposit++;
      unclaimedDepositCapacity += cap;
      const AR_i = await getARByBlockNumberHex(c.block_number, arCache);
      const reward = (free * AR) / AR_i - free;
      if (reward > 0n) unclaimedDeposit += reward;
    } else {
      cntPrepare++;
      const depositBnHex = parsePrepareBlockNumberHex(c.output_data);
      const AR_i = await getARByBlockNumberHex(depositBnHex, arCache);
      const AR_j = await getARByBlockNumberHex(c.block_number, arCache);
      const reward = (free * AR_j) / AR_i - free;
      if (reward > 0n) unclaimedPrepare += reward;
    }
  }
  // compute claimed rewards for this lock (scans withdraw2 transactions)
  async function computeClaimedRewardsForLock(targetKey) {
    const txCache = new Map();
    async function getTx(txHash) {
      if (txCache.has(txHash)) return txCache.get(txHash);
      const v = await rpc('get_transaction', [txHash], { timeoutMs: 120_000, retries: 5 });
      txCache.set(txHash, v);
      return v;
    }

    const pageLimit = process.env.WITHDRAW2_TX_LIMIT || '0x3e8';
    const maxPages = Number(process.env.CLAIM_MAX_PAGES || '50'); // 防止无限扫描，默认最多扫描 50 页
    let cursor = null;
    let claimedTotal = 0n;
    let page = 0;

    while (true) {
      page++;
      if (page > maxPages) break;
      // Search by target lock, filter by DAO type script
      // This reduces data volume significantly: only returns txs where targetLock consumes DAO cells
      const searchKey = {
        script: targetLock,
        script_type: 'lock',
        script_search_mode: 'exact',
        filter: {
          script: DAO_TYPE  // Only DAO type script cells (prepare-withdraw data)
        }
      };
      const params = [searchKey, 'desc', pageLimit];
      if (cursor && cursor !== '0x' && cursor !== '0x0') params.push(cursor);

      const res = await rpc('get_transactions', params, { timeoutMs: 120_000, retries: 5 });
      const objs = res.objects || [];
      if (objs.length === 0) break;

      // collect unique input tx hashes
      // Note: with lock filter, io_type==='input' means cells owned by targetLock
      const inputTxHashes = [];
      const seenTx = new Set();
      for (const o of objs) {
        const ioType = o.io_type ?? o.ioType;
        if (ioType === 'input') {
          const h = o.tx_hash ?? o.txHash;
          if (h && !seenTx.has(h)) {
            seenTx.add(h);
            inputTxHashes.push(h);
          }
        }
      }

      // process each input tx sequentially to keep code simple
      for (const txHash of inputTxHashes) {
        const wrap = await getTx(txHash);
        const tx = wrap?.transaction;
        if (!tx) continue;

        const inputs = tx.inputs || [];
        for (const inp of inputs) {
          const prev = inp?.previous_output;
          if (!prev?.tx_hash) continue;

          const prevWrap = await getTx(prev.tx_hash);
          const ptx = prevWrap?.transaction;
          const pStatus = prevWrap?.tx_status;
          if (!ptx?.outputs?.length) continue;

          const outIndex = Number(prev.index);
          const prevOut = ptx.outputs[outIndex];
          const prevData = (ptx.outputs_data || [])[outIndex];

          // must be DAO type and prepare-withdraw data
          if (!prevOut?.type) continue;
          if (prevOut.type.code_hash !== DAO_TYPE.code_hash || prevOut.type.hash_type !== DAO_TYPE.hash_type) continue;
          if (!prevData || prevData === '0x0000000000000000') continue;

          // check lock matches target
          const k = lockKey(prevOut.lock);
          if (k !== targetKey) continue;

          // prepare block number (tx status block)
          const prepareBnHex = pStatus?.block_number;
          if (!prepareBnHex) continue;

          const depositBnHex = parsePrepareBlockNumberHex(prevData);
          const AR_i = await getARByBlockNumberHex(depositBnHex, arCache);
          const AR_j = await getARByBlockNumberHex(prepareBnHex, arCache);

          const free = freeCapacity(prevOut, prevData);
          if (free <= 0n) continue;

          const reward = (free * AR_j) / AR_i - free;
          if (reward > 0n) claimedTotal += reward;
        }
      }

      const last = res.last_cursor;
      if (!last || last === '0x' || last === '0x0') break;
      cursor = last;
    }

    return claimedTotal;
  }

  const claimedRewards = await computeClaimedRewardsForLock(targetKey);

  console.log('--------------------------------');
  console.log('DAO unclaimed rewards deposit =', formatCKB(unclaimedDeposit), 'CKB', `(cells=${cntDeposit})`);
  console.log('DAO unclaimed rewards prepare =', formatCKB(unclaimedPrepare), 'CKB', `(cells=${cntPrepare})`);
  console.log('DAO claimed rewards          =', formatCKB(claimedRewards), 'CKB');

  const compensation = unclaimedDeposit + unclaimedPrepare + claimedRewards;
  console.log('DAO Compensation              =', formatCKB(compensation), 'CKB');
  console.log('--------------------------------');
  console.log('DAO unclaimed deposit capacity =', formatCKB(unclaimedDepositCapacity), 'CKB');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
