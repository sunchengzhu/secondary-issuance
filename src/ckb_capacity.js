// src/ckb_capacity.js
// Unified occupied/free capacity calculator for CKB cells
// This version matches explorer "occupied CKBtyes" (e.g. DAO cell occupied = 102)

export const SHANNONS_PER_CKB = 100_000_000n;

/* ----------------------- formatting ----------------------- */

export function formatCKB(shannons) {
  const v = shannons < 0n ? -shannons : shannons;
  const sign = shannons < 0n ? '-' : '';
  const whole = v / SHANNONS_PER_CKB;
  const frac = v % SHANNONS_PER_CKB;
  return `${sign}${whole.toString()}.${frac.toString().padStart(8, '0')}`;
}

/* ----------------------- hex helpers ----------------------- */

export function hexBytesLen(hex) {
  if (!hex || hex === '0x') return 0;
  const s = hex.startsWith('0x') ? hex.slice(2) : hex;
  return Math.floor(s.length / 2);
}

/* ----------------------- occupied capacity ----------------------- */
/**
 * IMPORTANT:
 * CKB occupied capacity bytes (as explorer shows) is NOT Molecule "total_size".
 *
 * occupied_bytes = 8 (capacity field)
 *               + script_bytes(lock)
 *               + (type ? script_bytes(type) : 0)
 *               + data_len
 *
 * script_bytes = 32(code_hash) + 1(hash_type) + args_len
 */
export function scriptBytesForOccupied(script) {
  if (!script) return 0;
  const argsLen = hexBytesLen(script.args || '0x');
  return 32 + 1 + argsLen;
}

export function occupiedBytes(output, outputDataHex) {
  const dataLen = hexBytesLen(outputDataHex);
  const lockBytes = scriptBytesForOccupied(output.lock);
  const typeBytes = output.type ? scriptBytesForOccupied(output.type) : 0;

  // 8 bytes for capacity field
  return 8 + lockBytes + typeBytes + dataLen;
}

export function occupiedCapacity(output, outputDataHex) {
  return BigInt(occupiedBytes(output, outputDataHex)) * SHANNONS_PER_CKB;
}

export function freeCapacity(output, outputDataHex) {
  const cap = BigInt(output.capacity);
  return cap - occupiedCapacity(output, outputDataHex);
}
