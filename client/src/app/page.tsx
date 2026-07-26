'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Buffer } from 'buffer';
import * as SDK from '@stellar/stellar-sdk';
import nacl from 'tweetnacl';
import {
  isConnected,
  requestAccess,
  getAddress,
  getNetwork,
  signTransaction,
} from '@stellar/freighter-api';

/* ------------------------------------------------------------------ CONFIG */

const CONTRACT_ID = 'CBJLXD2M62KCUU7LVXL5UM6RTWX4UF462NCTCLIIDNVOHZ7YLMBQA2FG';
const RPC_URL = 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const GRANT_ID_HEX = 'a1'.repeat(32);

const DOC_TITLE = 'Q3 Board Deck — CONFIDENTIAL';
const DOC_BODY = `BOARD PACKET / Q3 — RESTRICTED DISTRIBUTION

Runway .................. 19 months
Net revenue retention ... 141%
Pending: Series B term sheet, $42M pre
Do not forward. Do not screenshot.
Recipients of this document are individually bonded on Stellar.`;

/* ------------------------------------------------------------------- SETUP */

const RpcServer: any =
  (SDK as any).rpc?.Server ?? (SDK as any).SorobanRpc?.Server;
const server: any = new RpcServer(RPC_URL);

const ACCENT = '#B6FF3C';
const DANGER = '#FF3B3B';

const hexToBytes = (h: string) =>
  Uint8Array.from(h.match(/.{2}/g)!.map((x) => parseInt(x, 16)));
const GRANT_ID = hexToBytes(GRANT_ID_HEX);

const b64enc = (u: Uint8Array) => Buffer.from(u).toString('base64');
const b64dec = (s: string) => new Uint8Array(Buffer.from(s.trim(), 'base64'));
const bytesVal = (u: Uint8Array) => SDK.xdr.ScVal.scvBytes(Buffer.from(u));
const addrVal = (a: string) => new SDK.Address(a).toScVal();
const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const xlm = (stroops: bigint | number) => Number(stroops) / 1e7;
const expertTx = (h: string) =>
  `https://stellar.expert/explorer/testnet/tx/${h}`;

/* ---------------------------------------------------------------- RPC CALLS */

async function simulate(source: string, method: string, args: any[]) {
  const acct = await server.getAccount(source);
  const c = new SDK.Contract(CONTRACT_ID);
  const tx = new SDK.TransactionBuilder(acct, {
    fee: '1000000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(c.call(method, ...args))
    .setTimeout(60)
    .build();
  const sim: any = await server.simulateTransaction(tx);
  if (sim.error) throw new Error(String(sim.error));
  if (!sim.result?.retval) return null;
  return SDK.scValToNative(sim.result.retval);
}

async function invoke(source: string, method: string, args: any[]) {
  const acct = await server.getAccount(source);
  const c = new SDK.Contract(CONTRACT_ID);
  let tx: any = new SDK.TransactionBuilder(acct, {
    fee: '10000000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(c.call(method, ...args))
    .setTimeout(180)
    .build();

  tx = await server.prepareTransaction(tx);

  const signed: any = await signTransaction(tx.toXDR(), {
    networkPassphrase: NETWORK_PASSPHRASE,
    address: source,
  });
  const signedXdr = typeof signed === 'string' ? signed : signed.signedTxXdr;

  const sent: any = await server.sendTransaction(
    SDK.TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE)
  );
  if (sent.status === 'ERROR') {
    throw new Error(JSON.stringify(sent.errorResult ?? sent));
  }

  let got: any = await server.getTransaction(sent.hash);
  for (let i = 0; i < 40 && got.status === 'NOT_FOUND'; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    got = await server.getTransaction(sent.hash);
  }
  if (got.status !== 'SUCCESS') {
    throw new Error(`transaction ${got.status}`);
  }
  return {
    hash: sent.hash,
    value: got.returnValue ? SDK.scValToNative(got.returnValue) : null,
  };
}

function humanError(e: any): string {
  const s = String(e?.message ?? e);
  if (s.includes('#6')) return 'This credential is already spent.';
  if (s.includes('#5')) return 'That key does not belong to this grant.';
  if (s.includes('#4')) return 'This key is already bonded.';
  if (s.includes('#2')) return 'Grant not found — check the contract ID.';
  if (/ed25519|signature|Crypto/i.test(s))
    return 'That key does not belong to this grant.';
  if (/insufficient|underfunded|balance/i.test(s))
    return 'Not enough XLM — fund this account with Friendbot.';
  if (/account not found/i.test(s))
    return 'Account not found on testnet — fund it with Friendbot.';
  return s.slice(0, 180);
}

/* ------------------------------------------------------------------- TYPES */

type Grant = {
  owner: string;
  token: string;
  bond_amount: bigint;
  bounty_bps: number;
  expires_at: bigint;
  cipher_ref: string;
  bonded: number;
  burned: number;
};

type Holder = {
  holder: string;
  status: number;
  bonded_at: bigint;
  reporter: string | null;
};

type Row = { key: Uint8Array; data: Holder };
type LogLine = { kind: string; text: string; hash?: string };

/* --------------------------------------------------------------- COMPONENT */

export default function Page() {
  const [addr, setAddr] = useState<string>('');
  const [netOk, setNetOk] = useState(true);
  const [seq, setSeq] = useState<number>(0);
  const [grant, setGrant] = useState<Grant | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [log, setLog] = useState<LogLine[]>([]);

  const [cred, setCred] = useState<string>('');
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState<string>('');
  const [err, setErr] = useState<string>('');

  const [paste, setPaste] = useState('');
  const [burning, setBurning] = useState<string>('');
  const pollRef = useRef<any>(null);

  const addLog = (l: LogLine) => setLog((p) => [l, ...p].slice(0, 8));

  /* ---------------- wallet ---------------- */

  const connect = useCallback(async () => {
    setErr('');
    try {
      const c = await isConnected();
      if (!(c as any).isConnected && !c) throw new Error('Freighter not found');
      await requestAccess();
      const a: any = await getAddress();
      const address = a.address ?? a;
      setAddr(address);
      const n: any = await getNetwork();
      const passphrase = n.networkPassphrase ?? n;
      setNetOk(String(passphrase).includes('Test SDF Network'));
    } catch (e) {
      setErr(humanError(e));
    }
  }, []);

  /* ---------------- reads ---------------- */

  const refresh = useCallback(async () => {
    if (!addr) return;
    try {
      const l = await server.getLatestLedger();
      setSeq(l.sequence);
    } catch {}
    try {
      const g = await simulate(addr, 'get_grant', [bytesVal(GRANT_ID)]);
      if (g) setGrant(g as Grant);
      const hs = await simulate(addr, 'list_holders', [bytesVal(GRANT_ID)]);
      if (Array.isArray(hs)) {
        setRows(
          hs.map((t: any) => ({
            key: new Uint8Array(t[0]),
            data: t[1] as Holder,
          }))
        );
      }
    } catch (e) {
      setErr(humanError(e));
    }
  }, [addr]);

  useEffect(() => {
    if (!addr) return;
    refresh();
    pollRef.current = setInterval(refresh, 5000);
    return () => clearInterval(pollRef.current);
  }, [addr, refresh]);

  /* ---------------- bond & unlock ---------------- */

  async function bondAndUnlock() {
    if (!addr || !grant) return;
    setErr('');
    setBusy('Generating credential…');
    try {
      const kp = nacl.sign.keyPair();
      setBusy('Signing bond transaction…');
      const res = await invoke(addr, 'bond', [
        bytesVal(GRANT_ID),
        addrVal(addr),
        bytesVal(kp.publicKey),
      ]);
      setCred(b64enc(kp.secretKey));
      setRevealed(true);
      addLog({
        kind: 'bonded',
        text: `bonded  ${shortAddr(addr)}  ${xlm(grant.bond_amount)} XLM`,
        hash: res.hash,
      });
      await refresh();
    } catch (e) {
      setErr(humanError(e));
    } finally {
      setBusy('');
    }
  }

  /* ---------------- claim bounty ---------------- */

  const bounty = grant
    ? (Number(grant.bond_amount) * grant.bounty_bps) / 10000 / 1e7
    : 0;

  async function claim() {
    if (!addr) return;
    setErr('');
    setBusy('Signing the leaked key…');
    try {
      const sk = b64dec(paste);
      if (sk.length !== 64) throw new Error('Credential must be 64 bytes.');
      const kp = nacl.sign.keyPair.fromSecretKey(sk);
      const sig = nacl.sign.detached(GRANT_ID, sk);

      setBusy('Submitting proof…');
      const res = await invoke(addr, 'prove_leak', [
        bytesVal(GRANT_ID),
        bytesVal(kp.publicKey),
        addrVal(addr),
        bytesVal(sig),
      ]);

      setBurning(b64enc(kp.publicKey));
      addLog({
        kind: 'leak',
        text: `LEAK PROVEN  bounty ${bounty} XLM → ${shortAddr(addr)}`,
        hash: res.hash,
      });
      setPaste('');
      setTimeout(() => {
        setBurning('');
        refresh();
      }, 900);
    } catch (e) {
      setErr(humanError(e));
    } finally {
      setBusy('');
    }
  }

  /* ---------------- render ---------------- */

  const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' };

  return (
    <main
      style={{
        ...mono,
        minHeight: '100vh',
        background: '#08090A',
        color: '#D6D6D6',
        padding: '20px 24px',
        fontSize: 13,
      }}
    >
      {/* header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          borderBottom: '1px solid #1E2124',
          paddingBottom: 12,
          marginBottom: 18,
        }}
      >
        <span style={{ color: ACCENT, fontWeight: 700, letterSpacing: 2 }}>
          POISONKEY
        </span>
        <span style={{ color: '#5A6068' }}>
          credentials that punish their own leak
        </span>
        <span style={{ marginLeft: 'auto', color: '#5A6068' }}>
          ledger #{seq || '—'}
        </span>
        {addr ? (
          <span style={{ color: netOk ? ACCENT : DANGER }}>
            {netOk ? shortAddr(addr) : 'SWITCH TO TESTNET'}
          </span>
        ) : (
          <button onClick={connect} style={btn(ACCENT)}>
            CONNECT FREIGHTER
          </button>
        )}
      </div>

      {err && (
        <div style={{ color: DANGER, marginBottom: 14 }}>! {err}</div>
      )}
      {busy && (
        <div style={{ color: ACCENT, marginBottom: 14 }}>· {busy}</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
        {/* ---------------- column 1 ---------------- */}
        <section style={panel}>
          <h2 style={h2}>① THE SECRET</h2>
          <div style={{ color: '#EDEDED', marginBottom: 10 }}>
            {grant?.cipher_ref || DOC_TITLE}
          </div>

          <pre
            style={{
              whiteSpace: 'pre-wrap',
              lineHeight: 1.5,
              margin: 0,
              padding: 12,
              background: '#0D0F11',
              border: '1px solid #1E2124',
              minHeight: 168,
              color: revealed ? '#EDEDED' : '#2A2E33',
              filter: revealed ? 'none' : 'blur(3.5px)',
              userSelect: revealed ? 'text' : 'none',
              transition: 'filter .4s',
            }}
          >
            {revealed
              ? DOC_BODY
              : DOC_BODY.replace(/[A-Za-z0-9]/g, () =>
                  '0123456789abcdef'[Math.floor(Math.random() * 16)]
                )}
          </pre>

          <div style={{ marginTop: 12, color: '#7A828C' }}>
            bond&nbsp;
            <b style={{ color: '#EDEDED' }}>
              {grant ? xlm(grant.bond_amount) : '—'} XLM
            </b>
            &nbsp;·&nbsp;bounty&nbsp;
            <b style={{ color: '#EDEDED' }}>
              {grant ? grant.bounty_bps / 100 : '—'}%
            </b>
          </div>

          {!revealed ? (
            <button
              onClick={bondAndUnlock}
              disabled={!addr || !grant || !!busy}
              style={{ ...btn(ACCENT), marginTop: 12, width: '100%' }}
            >
              BOND &amp; UNLOCK
            </button>
          ) : (
            <div style={{ marginTop: 12 }}>
              <div style={{ color: DANGER, marginBottom: 6 }}>
                ACCESS CREDENTIAL
              </div>
              <textarea
                readOnly
                value={cred}
                onFocus={(e) => e.currentTarget.select()}
                style={{ ...input, height: 62 }}
              />
              <div style={{ color: '#7A828C', marginTop: 6, lineHeight: 1.5 }}>
                This key opens the document.
                <br />
                It can also take your bond.
              </div>
            </div>
          )}
        </section>

        {/* ---------------- column 2 ---------------- */}
        <section style={panel}>
          <h2 style={h2}>② BONDED READERS</h2>
          {rows.length === 0 && (
            <div style={{ color: '#3A4048' }}>
              {addr ? 'no readers bonded yet' : 'connect a wallet to read chain state'}
            </div>
          )}
          {rows.map((r, i) => {
            const k = b64enc(r.key);
            const burned = r.data.status === 1 || burning === k;
            const released = r.data.status === 2;
            const pct = burned ? 0 : 100;
            return (
              <div key={i} style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#EDEDED' }}>
                    {shortAddr(r.data.holder)}
                  </span>
                  <span
                    style={{
                      color: burned ? DANGER : released ? '#5A6068' : ACCENT,
                      fontSize: 11,
                      letterSpacing: 1,
                    }}
                  >
                    {burned ? 'BURNED' : released ? 'RELEASED' : 'BONDED'}
                  </span>
                </div>
                <div
                  style={{
                    height: 8,
                    background: '#14171A',
                    marginTop: 6,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${pct}%`,
                      background: burned ? DANGER : ACCENT,
                      transition: 'width .8s cubic-bezier(.4,0,.2,1)',
                    }}
                  />
                </div>
                <div style={{ color: '#5A6068', fontSize: 11, marginTop: 4 }}>
                  {grant ? xlm(grant.bond_amount) : '—'} XLM
                  {r.data.reporter
                    ? `  ·  claimed by ${shortAddr(r.data.reporter)}`
                    : ''}
                </div>
              </div>
            );
          })}
        </section>

        {/* ---------------- column 3 ---------------- */}
        <section style={{ ...panel, borderColor: '#2A1416' }}>
          <h2 style={{ ...h2, color: DANGER }}>③ LEAK HUNTER</h2>
          <div style={{ color: '#7A828C', marginBottom: 10, lineHeight: 1.5 }}>
            Anyone can use this. Paste a leaked ACCESS CREDENTIAL and claim the
            bounty from the leaker&apos;s bond.
          </div>
          <textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder="paste leaked credential…"
            style={{ ...input, height: 96 }}
          />
          <div style={{ color: '#7A828C', margin: '10px 0' }}>
            you receive{' '}
            <b style={{ color: ACCENT }}>{bounty || '—'} XLM</b>
          </div>
          <button
            onClick={claim}
            disabled={!addr || !paste || !!busy}
            style={{ ...btn(DANGER), width: '100%' }}
          >
            CLAIM BOUNTY
          </button>
        </section>
      </div>

      {/* ledger strip */}
      <div
        style={{
          marginTop: 18,
          borderTop: '1px solid #1E2124',
          paddingTop: 10,
          minHeight: 60,
        }}
      >
        {log.length === 0 && (
          <span style={{ color: '#3A4048' }}>ledger events will appear here</span>
        )}
        {log.map((l, i) => (
          <div key={i} style={{ marginBottom: 4 }}>
            <span style={{ color: l.kind === 'leak' ? DANGER : ACCENT }}>●</span>{' '}
            <span style={{ color: '#B8BEC6' }}>{l.text}</span>{' '}
            {l.hash && (
              <a
                href={expertTx(l.hash)}
                target="_blank"
                rel="noreferrer"
                style={{ color: '#5A6068' }}
              >
                [tx ↗]
              </a>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}

/* -------------------------------------------------------------- STYLE BITS */

const panel: React.CSSProperties = {
  border: '1px solid #1E2124',
  background: '#0A0C0D',
  padding: 16,
  minHeight: 380,
};

const h2: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: 2,
  color: '#7A828C',
  margin: '0 0 14px',
  fontWeight: 600,
};

const input: React.CSSProperties = {
  width: '100%',
  background: '#0D0F11',
  border: '1px solid #1E2124',
  color: '#B6FF3C',
  padding: 8,
  fontFamily: 'ui-monospace, Menlo, monospace',
  fontSize: 11,
  resize: 'none',
  outline: 'none',
  wordBreak: 'break-all',
};

function btn(color: string): React.CSSProperties {
  return {
    background: 'transparent',
    border: `1px solid ${color}`,
    color,
    padding: '9px 14px',
    letterSpacing: 1.5,
    fontSize: 11,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'ui-monospace, Menlo, monospace',
  };
}