const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8114';
const LIMIT_CELLS = process.env.LIMIT || '0x64'; // get_cells page size

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

/* ----------------------- DAO constants ----------------------- */

const DAO_TYPE = {
  code_hash: '0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e',
  hash_type: 'type',
  args: '0x',
};


/* ----------------------- DAO header parsing ----------------------- */

function parseDaoAR(daoHex) {
  const buf = Buffer.from(daoHex.slice(2), 'hex');
  return buf.readBigUInt64LE(8);
}

function parseDaoS(daoHex) {
  const buf = Buffer.from(daoHex.slice(2), 'hex');
  return buf.readBigUInt64LE(16);
}

/* ----------------------- Indexer tip ----------------------- */

async function getIndexerARandS() {
  const tip = await rpc('get_indexer_tip', []);
  const header = await rpc('get_header', [tip.block_hash]);
  return {
    AR: parseDaoAR(header.dao),
    S: parseDaoS(header.dao),
    heightHex: tip.block_number,
    heightDec: BigInt(tip.block_number).toString(),
    hash: tip.block_hash,
  };
}

/* ----------------------- Formatting ----------------------- */

function formatCKB(shannons) {
  const v = shannons < 0n ? -shannons : shannons;
  const sign = shannons < 0n ? '-' : '';
  const whole = v / 100_000_000n;
  const frac = v % 100_000_000n;
  return `${sign}${whole.toString()}.${frac.toString().padStart(8, '0')}`;
}

/* ----------------------- Occupied capacity ----------------------- */

const SHANNONS_PER_BYTE = 100_000_000n;

function hexBytesLen(hex) {
  if (!hex || hex === '0x') return 0;
  return (hex.length - 2) / 2;
}

function scriptSizeBytes(script) {
  const argsLen = hexBytesLen(script?.args || '0x');
  // rough-but-correct molecule sizing
  return 4 + 12 + 32 + 1 + 4 + argsLen;
}

function cellSizeBytes(output, dataHex) {
  const lockSize = scriptSizeBytes(output.lock);
  const typeSize = output.type ? (1 + scriptSizeBytes(output.type)) : 1;
  const dataSize = 4 + hexBytesLen(dataHex);
  return 4 + 8 + lockSize + typeSize + dataSize + 8;
}

function occupiedCapacity(output, dataHex) {
  return BigInt(cellSizeBytes(output, dataHex)) * SHANNONS_PER_BYTE;
}

/* ----------------------- get_cells (DAO live) ----------------------- */

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

// deposit cell: output_data == 0x0000000000000000
function isDepositCell(outputData) {
  return outputData === '0x0000000000000000';
}

// prepare-withdraw cell: output_data is u64 little-endian = prepare block number
function parsePrepareBlockNumberHex(outputData) {
  // outputData should be 8 bytes (16 hex chars) + 0x
  if (!outputData || outputData === '0x') {
    throw new Error(`invalid output_data for prepare-withdraw: ${outputData}`);
  }
  const hex = outputData.startsWith('0x') ? outputData.slice(2) : outputData;
  if (hex.length !== 16) {
    throw new Error(`prepare output_data must be 8 bytes (16 hex), got len=${hex.length}: ${outputData}`);
  }
  const buf = Buffer.from(hex, 'hex');
  const bn = buf.readBigUInt64LE(0); // BigInt
  return '0x' + bn.toString(16);
}

async function getARByBlockNumberHex(bnHex, arCache) {
  if (arCache.has(bnHex)) return arCache.get(bnHex);
  const h = await rpc('get_header_by_number', [bnHex], { timeoutMs: 120_000, retries: 5 });
  const ar = parseDaoAR(h.dao);
  arCache.set(bnHex, ar);
  return ar;
}

/* ----------------------- main ----------------------- */

async function main() {
  const { AR, S, heightDec, heightHex, hash } = await getIndexerARandS();

  console.log('RPC_URL        =', RPC_URL);
  console.log('INDEXER_HEIGHT =', heightDec, `(hex=${heightHex})`);
  console.log('INDEXER_HASH   =', hash);
  console.log('AR             =', AR.toString());
  console.log('S              =', S.toString());

  const arCache = new Map();

  let daoDeposit = 0n;
  let unclaimedDeposit = 0n;
  let unclaimedPrepare = 0n;
  let cntDeposit = 0;
  let cntPrepare = 0;

  for await (const c of getDaoLiveCells()) {
    const cap = BigInt(c.output.capacity);
    const occ = occupiedCapacity(c.output, c.output_data);
    const free = cap - occ;

    daoDeposit += cap;
    if (free <= 0n) continue;

    if (c.output_data === '0x0000000000000000') {
      // ---- deposit cell ----
      cntDeposit++;

      // deposit height i = c.block_number
      const AR_i = await getARByBlockNumberHex(c.block_number, arCache);

      // tip height k = indexer tip
      const reward = (free * AR) / AR_i - free; // AR is tip AR_k
      if (reward > 0n) unclaimedDeposit += reward;

    } else {
      // ---- prepare-withdraw cell ----
      cntPrepare++;

      // deposit height i is stored in output_data
      const depositBnHex = parsePrepareBlockNumberHex(c.output_data);
      const AR_i = await getARByBlockNumberHex(depositBnHex, arCache);

      // prepare height j = c.block_number (this cell created at prepare tx)
      const AR_j = await getARByBlockNumberHex(c.block_number, arCache);

      const reward = (free * AR_j) / AR_i - free;
      if (reward > 0n) unclaimedPrepare += reward;
    }
  }

  const unclaimedTotal = unclaimedDeposit + unclaimedPrepare;

  console.log('--------------------------------');
  console.log('DAO unclaimed rewards deposit =', formatCKB(unclaimedDeposit), 'CKB', `(cells=${cntDeposit})`);
  console.log('DAO unclaimed rewards prepare =', formatCKB(unclaimedPrepare), 'CKB', `(cells=${cntPrepare})`);
  console.log('DAO unclaimed rewards total   =', formatCKB(unclaimedTotal), 'CKB');

  if (unclaimedTotal <= S) {
    const burn = S - unclaimedTotal;
    console.log('Treasury burn                 =', formatCKB(burn), 'CKB');
  } else {
    console.error('❌ Sanity check failed: UnclaimedDAO > S');
  }
}

/* ----------------------- entry ----------------------- */

main().catch(e => {
  console.error(e);
  process.exit(1);
});
