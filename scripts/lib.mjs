// Shared helpers for the POISONKEY deploy / seed / verify scripts.
// Testnet only.
import * as SDK from '@stellar/stellar-sdk';
import nacl from 'tweetnacl';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const RPC_URL = 'https://soroban-testnet.stellar.org';
export const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
export const FRIENDBOT = 'https://friendbot.stellar.org';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
export const STATE_PATH = join(ROOT, 'deploy', 'testnet.json');
export const WASM_PATH = join(ROOT, 'target', 'wasm32v1-none', 'release', 'poisonkey.wasm');

export const server = new SDK.rpc.Server(RPC_URL);

export const XLM_SAC = new SDK.Asset('XLM').contractId(NETWORK_PASSPHRASE);

/** The demo grant id, 32 bytes of 0xa1. */
export const GRANT_ID_HEX = 'a1'.repeat(32);

export const STROOP = 10_000_000n;
export const BOND_STROOPS = 50n * STROOP; // 50 XLM
export const BOUNTY_BPS = 5000; // 50%

export const hexToBytes = (hex) =>
  Uint8Array.from(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));
export const bytesToHex = (u8) =>
  [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');

export const bytesVal = (u8) => SDK.xdr.ScVal.scvBytes(Buffer.from(u8));
export const addrVal = (g) => new SDK.Address(g).toScVal();
export const i128Val = (v) => SDK.nativeToScVal(v, { type: 'i128' });
export const u32Val = (v) => SDK.nativeToScVal(v, { type: 'u32' });
export const u64Val = (v) => SDK.nativeToScVal(v, { type: 'u64' });
export const strVal = (s) => SDK.nativeToScVal(s, { type: 'string' });

export function loadState() {
  if (!existsSync(STATE_PATH)) return {};
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
}

export function saveState(patch) {
  const next = { ...loadState(), ...patch };
  writeFileSync(STATE_PATH, JSON.stringify(next, null, 2) + '\n');
  return next;
}

/**
 * The 88-byte proof message: grant_id (32) || utf8 claimant strkey (56).
 * Byte-identical to the Rust side in contracts/poisonkey/src/lib.rs.
 */
export function proofMessage(grantId, claimant) {
  const msg = Buffer.concat([Buffer.from(grantId), Buffer.from(claimant, 'utf8')]);
  if (msg.length !== 88) throw new Error(`proof message is ${msg.length} bytes, expected 88`);
  return msg;
}

export function signProof(grantId, claimant, credentialSecret) {
  return nacl.sign.detached(proofMessage(grantId, claimant), credentialSecret);
}

/** Deterministic credential keypair, so the demo seed is reproducible. */
export function credentialFromSeed(seedByte) {
  return nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seedByte));
}

export async function fundIfNeeded(pubkey, label) {
  try {
    const acct = await server.getAccount(pubkey);
    process.stdout.write(`  ${label.padEnd(8)} ${pubkey} already funded (seq ${acct.sequenceNumber()})\n`);
    return false;
  } catch {
    const res = await fetch(`${FRIENDBOT}?addr=${pubkey}`);
    if (!res.ok && res.status !== 400) {
      throw new Error(`friendbot failed for ${label}: ${res.status} ${await res.text()}`);
    }
    // Friendbot is async on the horizon side; poll until the account exists.
    for (let i = 0; i < 30; i++) {
      try {
        await server.getAccount(pubkey);
        process.stdout.write(`  ${label.padEnd(8)} ${pubkey} funded\n`);
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw new Error(`friendbot funded ${label} but the account never appeared on RPC`);
  }
}

/** Build, simulate, sign and submit a contract invocation. Returns { hash, returnValue }. */
export async function invoke(keypair, contractId, method, args, { label = method } = {}) {
  const account = await server.getAccount(keypair.publicKey());
  const contract = new SDK.Contract(contractId);
  const built = new SDK.TransactionBuilder(account, {
    fee: '2000000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(120)
    .build();

  const prepared = await server.prepareTransaction(built);
  prepared.sign(keypair);
  return submit(prepared, label);
}

export async function submit(tx, label) {
  const sent = await server.sendTransaction(tx);
  if (sent.status === 'ERROR') {
    throw new Error(`${label}: submit rejected — ${JSON.stringify(sent.errorResult)}`);
  }
  const hash = sent.hash;
  for (let i = 0; i < 60; i++) {
    const got = await server.getTransaction(hash);
    if (got.status === 'SUCCESS') {
      process.stdout.write(`  ${label.padEnd(14)} ok   ${hash}\n`);
      return { hash, returnValue: got.returnValue };
    }
    if (got.status === 'FAILED') {
      throw new Error(
        `${label}: failed — ${hash}\n${JSON.stringify(got.resultXdr ?? got, null, 2)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label}: not confirmed within 60s — ${hash}`);
}

/** Read-only contract call via simulation. */
export async function read(contractId, method, args, sourcePubkey) {
  const account = await server.getAccount(sourcePubkey);
  const contract = new SDK.Contract(contractId);
  const tx = new SDK.TransactionBuilder(account, {
    fee: '1000000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (SDK.rpc.Api.isSimulationError(sim)) throw new Error(`${method}: ${sim.error}`);
  return SDK.scValToNative(sim.result.retval);
}

export async function xlmBalance(pubkey) {
  const acct = await server.getAccount(pubkey);
  // The RPC account entry does not carry balances; read the SAC instead.
  return await read(XLM_SAC, 'balance', [addrVal(pubkey)], acct.accountId());
}

export { SDK, nacl };
