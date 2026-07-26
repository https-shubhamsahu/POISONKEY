// Everything that touches Stellar. Soroban RPC reads by simulation, writes signed
// either by Freighter (the visitor) or by a local demo keypair (the seed).
import * as SDK from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';
import { DEPLOYMENT } from './deployment';

export const server = new SDK.rpc.Server(DEPLOYMENT.rpcUrl);
export const CONTRACT_ID = DEPLOYMENT.contractId;
export const NETWORK_PASSPHRASE = DEPLOYMENT.networkPassphrase;

export const GRANT_ID = hexToBytes(DEPLOYMENT.grantIdHex);

// ---------------------------------------------------------------- conversions

export function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}

export function bytesToHex(u8: Uint8Array): string {
  return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function toBase64(u8: Uint8Array): string {
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const raw = atob(b64.trim());
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export const bytesVal = (u8: Uint8Array) => SDK.xdr.ScVal.scvBytes(Buffer.from(u8));
export const addrVal = (g: string) => new SDK.Address(g).toScVal();
export const i128Val = (v: bigint) => SDK.nativeToScVal(v.toString(), { type: 'i128' });
export const u32Val = (v: number) => SDK.nativeToScVal(v, { type: 'u32' });
export const u64Val = (v: bigint) => SDK.nativeToScVal(v.toString(), { type: 'u64' });
export const strVal = (s: string) => SDK.nativeToScVal(s, { type: 'string' });

/** Stroops -> a short XLM string. */
export function xlm(stroops: bigint, dp = 7): string {
  const neg = stroops < 0n;
  const abs = neg ? -stroops : stroops;
  const whole = abs / 10_000_000n;
  const frac = (abs % 10_000_000n).toString().padStart(7, '0').slice(0, dp).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

// ---------------------------------------------------------------- chain types

export type GrantData = {
  owner: string;
  token: string;
  bond_amount: bigint;
  bounty_bps: number;
  expires_at: bigint;
  cipher_ref: string;
  bonded: number;
  burned: number;
};

export type HolderData = {
  holder: string;
  status: number;
  bonded_at: bigint;
  reporter: string | null;
};

export const STATUS = { BONDED: 0, BURNED: 1, RELEASED: 2 } as const;

export type HolderRow = { keyPub: Uint8Array; keyHex: string; data: HolderData };

// ---------------------------------------------------------------- error text

// Codes 1..8 are this contract's #[contracterror]. Anything higher came from the
// Stellar Asset Contract underneath — in practice #10, "balance is not within the
// allowed range", i.e. the payer cannot cover the transfer.
const CONTRACT_ERRORS: Record<number, string> = {
  1: 'That grant is already published.',
  2: 'That grant does not exist on this network.',
  3: 'Those grant parameters are invalid.',
  4: 'That credential is already registered on this grant.',
  5: 'That key does not belong to this grant.',
  6: 'This credential is already spent.',
  7: 'That key does not belong to this grant.',
  8: 'This bond has not reached its expiry yet.',
};

/** Turn an RPC/host error into one plain sentence. */
export function explain(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  if (/Account not found|account not found/.test(raw)) return 'Fund this account with Friendbot.';
  // env.crypto().ed25519_verify traps rather than returning an error code.
  if (/Error\(Crypto/.test(raw) || /ED25519 verification/i.test(raw)) {
    return 'That key does not belong to this grant.';
  }
  const code = raw.match(/Error\(Contract, #(\d+)\)/);
  if (code) {
    const n = Number(code[1]);
    return CONTRACT_ERRORS[n] ?? 'Fund this account with Friendbot.';
  }
  if (/not within the allowed range|insufficient/i.test(raw)) {
    return 'Fund this account with Friendbot.';
  }
  if (/declined|denied|rejected by user|User declined/i.test(raw)) {
    return 'Signing was cancelled in the wallet.';
  }
  return raw.split('\n')[0].slice(0, 200);
}

// ---------------------------------------------------------------- reads

/**
 * Simulation needs some existing account as the transaction source. The demo
 * owner is always funded, and read-only calls never touch it.
 */
const READ_SOURCE = DEPLOYMENT.demo.owner.public;

async function simulate(method: string, args: SDK.xdr.ScVal[]): Promise<SDK.xdr.ScVal> {
  const account = await server.getAccount(READ_SOURCE);
  const tx = new SDK.TransactionBuilder(account, {
    fee: '1000000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new SDK.Contract(CONTRACT_ID).call(method, ...args))
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SDK.rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  if (!sim.result) throw new Error(`${method}: simulation returned no result`);
  return sim.result.retval;
}

export async function getGrant(grantId: Uint8Array): Promise<GrantData> {
  return SDK.scValToNative(await simulate('get_grant', [bytesVal(grantId)])) as GrantData;
}

export async function listHolders(grantId: Uint8Array): Promise<HolderRow[]> {
  const raw = SDK.scValToNative(await simulate('list_holders', [bytesVal(grantId)])) as Array<
    [Uint8Array, HolderData]
  >;
  return raw.map(([keyPub, data]) => ({
    keyPub: new Uint8Array(keyPub),
    keyHex: bytesToHex(new Uint8Array(keyPub)),
    data,
  }));
}

export async function latestLedger(): Promise<number> {
  return (await server.getLatestLedger()).sequence;
}

// ---------------------------------------------------------------- writes

export type Signer =
  | { kind: 'freighter'; address: string }
  | { kind: 'local'; keypair: SDK.Keypair };

export type Stage = 'simulating' | 'signing' | 'submitting' | 'confirming';

export function signerAddress(s: Signer): string {
  return s.kind === 'freighter' ? s.address : s.keypair.publicKey();
}

export type TxResult = { hash: string; returnValue: SDK.xdr.ScVal | undefined };

/**
 * Build, simulate, sign and submit a contract invocation, reporting each stage.
 * Simulation happens inside prepareTransaction, which also fills in the
 * authorization entries and the Soroban resource fee.
 */
export async function invoke(
  signer: Signer,
  method: string,
  args: SDK.xdr.ScVal[],
  onStage?: (s: Stage) => void,
): Promise<TxResult> {
  const source = signerAddress(signer);

  onStage?.('simulating');
  const account = await server.getAccount(source);
  const built = new SDK.TransactionBuilder(account, {
    fee: '2000000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new SDK.Contract(CONTRACT_ID).call(method, ...args))
    .setTimeout(180)
    .build();

  const prepared = await server.prepareTransaction(built);

  onStage?.('signing');
  let signed: SDK.Transaction;
  if (signer.kind === 'local') {
    prepared.sign(signer.keypair);
    signed = prepared;
  } else {
    const { signTransaction } = await import('@stellar/freighter-api');
    const res = await signTransaction(prepared.toXDR(), {
      networkPassphrase: NETWORK_PASSPHRASE,
      address: signer.address,
    });
    if (res.error) throw new Error(String((res.error as { message?: string }).message ?? res.error));
    if (!res.signedTxXdr) throw new Error('Signing was cancelled in the wallet.');
    signed = SDK.TransactionBuilder.fromXDR(res.signedTxXdr, NETWORK_PASSPHRASE) as SDK.Transaction;
  }

  onStage?.('submitting');
  const sent = await server.sendTransaction(signed);
  if (sent.status === 'ERROR') {
    throw new Error(`Submission rejected: ${JSON.stringify(sent.errorResult)}`);
  }

  onStage?.('confirming');
  for (let i = 0; i < 60; i++) {
    const got = await server.getTransaction(sent.hash);
    if (got.status === SDK.rpc.Api.GetTransactionStatus.SUCCESS) {
      return { hash: sent.hash, returnValue: got.returnValue };
    }
    if (got.status === SDK.rpc.Api.GetTransactionStatus.FAILED) {
      // The diagnostic events carry the real reason; surface them for explain().
      throw new Error(
        `Error(Contract, #?) ${JSON.stringify(got.resultXdr ?? '')} ${
          (got as { diagnosticEventsXdr?: unknown }).diagnosticEventsXdr ?? ''
        }`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('The transaction was not confirmed within 60 seconds.');
}

/**
 * A failed invocation is normally caught during prepareTransaction (simulation),
 * where the host error text is intact. This wrapper keeps that text.
 */
export async function invokeExplained(
  signer: Signer,
  method: string,
  args: SDK.xdr.ScVal[],
  onStage?: (s: Stage) => void,
): Promise<TxResult> {
  try {
    return await invoke(signer, method, args, onStage);
  } catch (e) {
    throw new Error(explain(e));
  }
}

// ---------------------------------------------------------------- events

export type LedgerEvent = {
  kind: string;
  ledger: number;
  txHash: string;
  data: unknown;
};

/** Recent POISONKEY events, oldest first — the forensic ledger. */
export async function recentEvents(latest: number): Promise<LedgerEvent[]> {
  // Testnet keeps a limited event window; stay inside it.
  const startLedger = Math.max(1, latest - 16_000);
  const res = await server.getEvents({
    startLedger,
    filters: [{ type: 'contract', contractIds: [CONTRACT_ID] }],
    limit: 100,
  });
  return res.events.map((e) => ({
    kind: String(SDK.scValToNative(e.topic[1])),
    ledger: e.ledger,
    txHash: e.txHash,
    data: SDK.scValToNative(e.value),
  }));
}

export const explorerTx = (hash: string) => `${DEPLOYMENT.explorer}/tx/${hash}`;
export const explorerContract = () => `${DEPLOYMENT.explorer}/contract/${CONTRACT_ID}`;
export const explorerAccount = (g: string) => `${DEPLOYMENT.explorer}/account/${g}`;
