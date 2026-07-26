// Demo seed. On first load, if the demo grant is not on chain, publish it and
// pre-bond BOB and CARA so the board is populated before anyone arrives.
//
// Signed by the throwaway testnet keypairs in deployment.ts, not by the visitor's
// wallet — the visitor may not be the owner, and the board should already be
// there when they open the page. Idempotent: every step checks chain state first.
import * as SDK from '@stellar/stellar-sdk';
import nacl from 'tweetnacl';
import { DEPLOYMENT } from './deployment';
import {
  GRANT_ID,
  addrVal,
  bytesVal,
  i128Val,
  server,
  strVal,
  u32Val,
  u64Val,
  invoke,
  explain,
} from './chain';
import { DOC_TITLE_FALLBACK } from './doc';

export const BOND_STROOPS = 500_000_000n; // 50 XLM
export const BOUNTY_BPS = 5_000; // 50%
const SEVEN_DAYS = 7n * 24n * 60n * 60n;

/** Deterministic credential for a demo reader, so re-seeding is reproducible. */
export function demoCredential(seedByte: number) {
  return nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seedByte));
}

function isMissing(err: unknown, code: number): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.includes(`Error(Contract, #${code})`);
}

async function callRaw(method: string, args: SDK.xdr.ScVal[], source: string) {
  const account = await server.getAccount(source);
  const tx = new SDK.TransactionBuilder(account, {
    fee: '1000000',
    networkPassphrase: DEPLOYMENT.networkPassphrase,
  })
    .addOperation(new SDK.Contract(DEPLOYMENT.contractId).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (SDK.rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return sim;
}

async function grantExists(): Promise<boolean> {
  try {
    await callRaw('get_grant', [bytesVal(GRANT_ID)], DEPLOYMENT.demo.owner.public);
    return true;
  } catch (e) {
    if (isMissing(e, 2)) return false;
    throw e;
  }
}

async function holderExists(keyPub: Uint8Array): Promise<boolean> {
  try {
    await callRaw(
      'get_holder',
      [bytesVal(GRANT_ID), bytesVal(keyPub)],
      DEPLOYMENT.demo.owner.public,
    );
    return true;
  } catch (e) {
    if (isMissing(e, 5) || isMissing(e, 2)) return false;
    throw e;
  }
}

export type SeedProgress = (message: string) => void;

/**
 * Bring the demo grant and its two pre-bonded readers into existence.
 * Returns the list of things it actually had to do.
 */
export async function ensureDemoBoard(report: SeedProgress): Promise<string[]> {
  const done: string[] = [];
  const owner = SDK.Keypair.fromSecret(DEPLOYMENT.demo.owner.secret);

  if (!(await grantExists())) {
    report('publishing the demo grant');
    const expiresAt = BigInt(Math.floor(Date.now() / 1000)) + SEVEN_DAYS;
    try {
      await invoke(
        { kind: 'local', keypair: owner },
        'publish',
        [
          addrVal(owner.publicKey()),
          bytesVal(GRANT_ID),
          addrVal(DEPLOYMENT.xlmSac),
          i128Val(BOND_STROOPS),
          u32Val(BOUNTY_BPS),
          u64Val(expiresAt),
          strVal(DOC_TITLE_FALLBACK),
        ],
      );
      done.push('published grant');
    } catch (e) {
      // A concurrent tab may have won the race; that is still success.
      if (!isMissing(e, 1)) throw new Error(`seed publish: ${explain(e)}`);
    }
  }

  for (const reader of [DEPLOYMENT.demo.bob, DEPLOYMENT.demo.cara] as const) {
    const cred = demoCredential(reader.credentialSeed);
    if (await holderExists(cred.publicKey)) continue;
    report(`bonding ${reader.label}`);
    try {
      await invoke({ kind: 'local', keypair: SDK.Keypair.fromSecret(reader.secret) }, 'bond', [
        bytesVal(GRANT_ID),
        addrVal(reader.public),
        bytesVal(cred.publicKey),
      ]);
      done.push(`bonded ${reader.label}`);
    } catch (e) {
      if (!isMissing(e, 4)) throw new Error(`seed bond ${reader.label}: ${explain(e)}`);
    }
  }

  return done;
}

/** Label a holder address for the board. */
export function labelFor(address: string, connected?: string): string {
  if (connected && address === connected) return 'YOU';
  if (address === DEPLOYMENT.demo.bob.public) return DEPLOYMENT.demo.bob.label;
  if (address === DEPLOYMENT.demo.cara.public) return DEPLOYMENT.demo.cara.label;
  if (address === DEPLOYMENT.demo.owner.public) return 'OWNER';
  return short(address);
}

export function short(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}
