import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import nacl from 'tweetnacl';
import { DEPLOYMENT } from './deployment';
import {
  GRANT_ID,
  STATUS,
  addrVal,
  bytesToHex,
  bytesVal,
  explain,
  explorerAccount,
  explorerContract,
  explorerTx,
  fromBase64,
  getGrant,
  invoke,
  latestLedger,
  listHolders,
  recentEvents,
  toBase64,
  xlm,
} from './chain';
import type { GrantData, HolderRow, LedgerEvent, Signer, Stage } from './chain';

/** Every write on this page is signed by the visitor's wallet, never by a demo key. */
type FreighterSigner = Extract<Signer, { kind: 'freighter' }>;

/** A pasted credential, once decoded. */
type Pasted =
  | { ok: false; error: string }
  | { ok: true; keyPair: nacl.SignKeyPair; keyHex: string };
import { DOC_BODY, DOC_CIPHER, DOC_TITLE_FALLBACK } from './doc';
import { ensureDemoBoard, labelFor, short } from './seed';
import { FREIGHTER_URL, connect, refreshWallet } from './wallet';
import type { WalletState } from './wallet';

const POLL_MS = 5000;
const DRAIN_MS = 800;
const GRANT_HEX = bytesToHex(GRANT_ID);

/* ------------------------------------------------------------- action states */

type Action =
  | { phase: 'idle' }
  | { phase: Stage }
  | { phase: 'confirmed'; hash: string }
  | { phase: 'error'; message: string };

const IDLE: Action = { phase: 'idle' };
const STAGES: Stage[] = ['simulating', 'signing', 'submitting', 'confirming'];
const isBusy = (a: Action) => STAGES.includes(a.phase as Stage);

const STAGE_TEXT: Record<Stage, string> = {
  simulating: 'simulating against the current ledger',
  signing: 'waiting for the wallet signature',
  submitting: 'submitting to the network',
  confirming: 'waiting for confirmation',
};

function ActionStatus({ action, done }: { action: Action; done: string }) {
  if (action.phase === 'idle') return null;
  if (action.phase === 'error') return <div className="err">{action.message}</div>;
  if (action.phase === 'confirmed') {
    return (
      <div className="status">
        <b>{done}</b>{' '}
        <a href={explorerTx(action.hash)} target="_blank" rel="noreferrer">
          {action.hash.slice(0, 16)}…
        </a>
      </div>
    );
  }
  return (
    <div className="status">
      <span className="spin">{STAGE_TEXT[action.phase]}</span>
    </div>
  );
}

/* --------------------------------------------------------------- ledger strip */

type StripLine = { id: string; kind: string; seq: number; body: string; hash: string };

const TAGS: Record<string, string> = {
  published: 'GRANT OPENED',
  bonded: 'BOND POSTED',
  leak: 'BOND BURNED',
  silent: 'BOND RELEASED',
};

function eventLine(e: LedgerEvent, connected?: string): StripLine | null {
  const d = e.data as unknown[];
  const base = { id: `${e.txHash}:${e.kind}`, kind: e.kind, seq: e.ledger, hash: e.txHash };
  switch (e.kind) {
    case 'published': {
      const [owner, bond, bps] = d as [string, bigint, number];
      return {
        ...base,
        body: `${labelFor(owner, connected)} opened grant ${e.grantHex.slice(0, 8)}… · bond ${xlm(bond)} XLM · bounty ${bps / 100}%`,
      };
    }
    case 'bonded': {
      const [holder, keyPub, bond] = d as [string, Uint8Array, bigint];
      const hex = bytesToHex(new Uint8Array(keyPub));
      return {
        ...base,
        body: `${labelFor(holder, connected)} posted ${xlm(bond)} XLM against key ${hex.slice(0, 12)}…`,
      };
    }
    case 'leak': {
      const [leaker, claimant, bounty] = d as [string, string, bigint];
      return {
        ...base,
        body: `${labelFor(leaker, connected)} bond slashed · ${xlm(bounty)} XLM paid to ${labelFor(claimant, connected)}`,
      };
    }
    case 'silent': {
      const [holder, bond] = d as [string, bigint];
      return {
        ...base,
        body: `${labelFor(holder, connected)} never leaked · ${xlm(bond)} XLM returned`,
      };
    }
    default:
      return null;
  }
}

/* -------------------------------------------------------------------- helpers */

function countdown(ms: number): string {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const credKey = (address: string) =>
  `poisonkey:cred:${DEPLOYMENT.contractId}:${GRANT_HEX}:${address}`;

/* ====================================================================== page */

export default function App() {
  const [wallet, setWallet] = useState<WalletState>({ status: 'disconnected' });
  const [grant, setGrant] = useState<GrantData | null>(null);
  const [rows, setRows] = useState<HolderRow[]>([]);
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [seq, setSeq] = useState<number>(0);
  const [chainError, setChainError] = useState('');
  const [seedMsg, setSeedMsg] = useState('checking the demo grant');

  const [credential, setCredential] = useState<nacl.SignKeyPair | null>(null);
  const [copied, setCopied] = useState(false);
  const [bondAction, setBondAction] = useState<Action>(IDLE);

  const [pasteCred, setPasteCred] = useState('');
  const [claimAction, setClaimAction] = useState<Action>(IDLE);

  const [releaseActions, setReleaseActions] = useState<Record<string, Action>>({});
  const [localLines, setLocalLines] = useState<StripLine[]>([]);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const [draining, setDraining] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());

  const prevStatus = useRef<Record<string, number>>({});
  const started = useRef(false);
  const stripEnd = useRef<HTMLDivElement | null>(null);

  const connected = wallet.status === 'connected' ? wallet.address : undefined;
  const signer: FreighterSigner | null = connected
    ? { kind: 'freighter', address: connected }
    : null;

  /* ------------------------------------------------------------------ reads */

  const refreshState = useCallback(async () => {
    try {
      const lg = await latestLedger();
      setSeq(lg);
      const [g, hs] = await Promise.all([getGrant(GRANT_ID), listHolders(GRANT_ID)]);
      setGrant(g);
      setRows(hs);
      setChainError('');
      try {
        const fresh = await recentEvents(lg, GRANT_ID);
        // Accumulate rather than replace: the scan window slides forward, so
        // anything that falls out of it stays on the strip.
        setEvents((prev) => {
          const byHash = new Map(prev.map((e) => [`${e.txHash}:${e.kind}`, e]));
          for (const e of fresh) byHash.set(`${e.txHash}:${e.kind}`, e);
          return [...byHash.values()].sort((a, b) => a.ledger - b.ledger);
        });
      } catch {
        // The event window is best-effort; the strip still shows this session's
        // confirmed transactions.
      }
    } catch (e) {
      setChainError(explain(e));
    }
  }, []);

  /* Seed the demo board once, then poll.
     The `started` ref is the only guard needed — deliberately no abort flag, because
     StrictMode's throwaway first mount would otherwise discard every update this
     one-shot makes and leave the banner stuck on its initial message. */
  useEffect(() => {
    if (started.current) return;
    started.current = true;

    (async () => {
      try {
        const did = await ensureDemoBoard(setSeedMsg);
        if (did.length) {
          setSeedMsg(`demo board ready — ${did.join(', ')}`);
          setTimeout(() => setSeedMsg(''), 6000);
        } else {
          setSeedMsg('');
        }
      } catch (e) {
        setSeedMsg(`demo seed failed: ${explain(e)}`);
      }
      await refreshState();
    })();
  }, [refreshState]);

  useEffect(() => {
    const t = setInterval(refreshState, POLL_MS);
    return () => clearInterval(t);
  }, [refreshState]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  /* Notice the extension switching account or network behind our back. */
  useEffect(() => {
    const t = setInterval(async () => {
      const next = await refreshWallet(wallet);
      if (next && JSON.stringify(next) !== JSON.stringify(wallet)) setWallet(next);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [wallet]);

  /* Drain animation: hold the pill on BONDED for the length of the drain, so the
     bar empties first and the status flips after. */
  useEffect(() => {
    const flipped: string[] = [];
    for (const r of rows) {
      if (prevStatus.current[r.keyHex] === STATUS.BONDED && r.data.status === STATUS.BURNED) {
        flipped.push(r.keyHex);
      }
      prevStatus.current[r.keyHex] = r.data.status;
    }
    if (!flipped.length) return;
    setDraining((s) => new Set([...s, ...flipped]));
    const t = setTimeout(() => {
      setDraining((s) => {
        const next = new Set(s);
        for (const k of flipped) next.delete(k);
        return next;
      });
    }, DRAIN_MS + 80);
    return () => clearTimeout(t);
  }, [rows]);

  /* Keep the reveal across a reload. Testnet demo credential, deliberately local. */
  useEffect(() => {
    if (!connected) {
      setCredential(null);
      return;
    }
    const stored = localStorage.getItem(credKey(connected));
    if (!stored) {
      setCredential(null);
      return;
    }
    try {
      setCredential(nacl.sign.keyPair.fromSecretKey(fromBase64(stored)));
    } catch {
      localStorage.removeItem(credKey(connected));
      setCredential(null);
    }
  }, [connected]);

  /* ------------------------------------------------------------------ strip */

  const strip = useMemo(() => {
    const byId = new Map<string, StripLine>();
    for (const e of events) {
      const line = eventLine(e, connected);
      if (line) byId.set(line.id, line);
    }
    for (const l of localLines) byId.set(l.id, l);
    return [...byId.values()].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  }, [events, localLines, connected]);

  useEffect(() => {
    stripEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [strip.length]);

  const pushLine = useCallback(
    (kind: string, body: string, hash: string) => {
      const id = `${hash}:${kind}`;
      setLocalLines((ls) => [...ls, { id, kind, seq: seq + 1, body, hash }]);
      setFreshIds((s) => new Set([...s, id]));
      setTimeout(
        () =>
          setFreshIds((s) => {
            const next = new Set(s);
            next.delete(id);
            return next;
          }),
        1400,
      );
    },
    [seq],
  );

  /* ---------------------------------------------------------------- derived */

  const bondAmount = grant ? xlm(grant.bond_amount) : '—';
  const bountyBps = grant ? grant.bounty_bps / 100 : 0;
  const bountyStroops = grant ? (grant.bond_amount * BigInt(grant.bounty_bps)) / 10_000n : 0n;
  const myRow = rows.find((r) => connected && r.data.holder === connected);
  const revealed = Boolean(credential && myRow);
  const untilExpiry = grant ? Number(grant.expires_at) * 1000 - now : 0;

  /** Decode the pasted credential and say, before they click, what it is. */
  const pasted = useMemo<Pasted | null>(() => {
    const raw = pasteCred.trim();
    if (!raw) return null;
    let secret: Uint8Array;
    try {
      secret = fromBase64(raw);
    } catch {
      return { ok: false, error: 'That is not valid base64.' };
    }
    if (secret.length !== 64) {
      return {
        ok: false,
        error: `An ACCESS CREDENTIAL is a 64-byte base64 string; this decodes to ${secret.length}.`,
      };
    }
    const keyPair = nacl.sign.keyPair.fromSecretKey(secret);
    return { ok: true, keyPair, keyHex: bytesToHex(keyPair.publicKey) };
  }, [pasteCred]);

  const pastedRow = pasted?.ok ? rows.find((r) => r.keyHex === pasted.keyHex) : undefined;

  /* ---------------------------------------------------------------- actions */

  async function handleConnect() {
    setWallet({ status: 'connecting' });
    setWallet(await connect());
  }

  async function handleBond() {
    if (!signer || !grant) return;
    setBondAction({ phase: 'simulating' });
    // A fresh keypair: the only key that opens this document, and the only key
    // that can take this bond.
    const kp = nacl.sign.keyPair();
    try {
      const { hash } = await invoke(
        signer,
        'bond',
        [bytesVal(GRANT_ID), addrVal(signer.address), bytesVal(kp.publicKey)],
        (stage) => setBondAction({ phase: stage }),
      );
      localStorage.setItem(credKey(signer.address), toBase64(kp.secretKey));
      setCredential(kp);
      setBondAction({ phase: 'confirmed', hash });
      pushLine(
        'bonded',
        `YOU posted ${xlm(grant.bond_amount)} XLM against key ${bytesToHex(kp.publicKey).slice(0, 12)}…`,
        hash,
      );
      await refreshState();
    } catch (e) {
      setBondAction({ phase: 'error', message: explain(e) });
    }
  }

  async function handleClaim() {
    if (!signer || !pasted?.ok) return;
    setClaimAction({ phase: 'simulating' });
    try {
      // The 88-byte proof: grant_id (32) || the claimant's own strkey address (56).
      // Byte-identical to the Rust side. Signing their own address is what makes
      // the proof useless to a front-runner who sees it in the mempool.
      const msg = new Uint8Array(88);
      msg.set(GRANT_ID, 0);
      msg.set(new TextEncoder().encode(signer.address), 32);
      const sig = nacl.sign.detached(msg, pasted.keyPair.secretKey);

      const { hash } = await invoke(
        signer,
        'prove_leak',
        [
          bytesVal(GRANT_ID),
          bytesVal(pasted.keyPair.publicKey),
          addrVal(signer.address),
          bytesVal(sig),
        ],
        (stage) => setClaimAction({ phase: stage }),
      );
      setClaimAction({ phase: 'confirmed', hash });
      pushLine(
        'leak',
        `${pastedRow ? labelFor(pastedRow.data.holder, connected) : 'holder'} bond slashed · ${xlm(bountyStroops)} XLM paid to YOU`,
        hash,
      );
      setPasteCred('');
      await refreshState();
    } catch (e) {
      setClaimAction({ phase: 'error', message: explain(e) });
    }
  }

  async function handleRelease(row: HolderRow) {
    if (!signer || !grant) return;
    const set = (a: Action) => setReleaseActions((m) => ({ ...m, [row.keyHex]: a }));
    set({ phase: 'simulating' });
    try {
      const { hash } = await invoke(
        signer,
        'release',
        [bytesVal(GRANT_ID), bytesVal(row.keyPub)],
        (stage) => set({ phase: stage }),
      );
      set({ phase: 'confirmed', hash });
      pushLine('silent', `YOU never leaked · ${xlm(grant.bond_amount)} XLM returned`, hash);
      await refreshState();
    } catch (e) {
      set({ phase: 'error', message: explain(e) });
    }
  }

  async function copyCredential() {
    if (!credential) return;
    await navigator.clipboard.writeText(toBase64(credential.secretKey));
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  /* ----------------------------------------------------------------- render */

  return (
    <div className="app">
      <header className="top">
        <span className="brand">POISONKEY</span>
        <span className="tagline">credentials that punish their own leak</span>

        <div className="top-right">
          <span className="kv">
            grant <b>{GRANT_HEX.slice(0, 8)}…</b>
          </span>
          <span className="kv">
            contract{' '}
            <a href={explorerContract()} target="_blank" rel="noreferrer">
              {short(DEPLOYMENT.contractId)}
            </a>
          </span>
          <span className="kv">
            ledger <b className="live">#{seq || '—'}</b>
          </span>

          {wallet.status === 'connected' ? (
            <span className="kv" title={wallet.address}>
              <i className="dot on" />
              <a href={explorerAccount(wallet.address)} target="_blank" rel="noreferrer">
                {short(wallet.address)}
              </a>
            </span>
          ) : wallet.status === 'connecting' ? (
            <span className="kv">
              <i className="dot" />
              <span className="spin">connecting</span>
            </span>
          ) : wallet.status === 'wrong-network' ? (
            <button className="ghost tiny" onClick={handleConnect}>
              <i className="dot bad" /> SWITCH TO TESTNET
            </button>
          ) : (
            <button className="tiny" onClick={handleConnect}>
              CONNECT FREIGHTER
            </button>
          )}
        </div>
      </header>

      {wallet.status === 'missing' && (
        <div className="banner">
          Freighter was not detected. Install it from{' '}
          <a href={FREIGHTER_URL} target="_blank" rel="noreferrer">
            freighter.app
          </a>{' '}
          and select Testnet. The board below is live either way.
        </div>
      )}
      {wallet.status === 'wrong-network' && (
        <div className="banner bad">
          Freighter is on {wallet.network}. This contract only exists on Testnet — switch the
          network in the extension, then reconnect.
        </div>
      )}
      {wallet.status === 'error' && <div className="banner bad">! {wallet.message}</div>}
      {chainError && <div className="banner bad">! Soroban RPC — {chainError}</div>}
      {seedMsg && <div className="banner">· {seedMsg}</div>}

      <main className="cols">
        {/* ------------------------------------------------ ① THE SECRET */}
        <section className="col">
          <h2>
            <span className="num">①</span>THE SECRET
          </h2>

          <div className="doc-title">{grant?.cipher_ref || DOC_TITLE_FALLBACK}</div>

          <div className={`docbox ${revealed ? 'open' : 'locked'}`}>
            <pre>{revealed ? DOC_BODY : DOC_CIPHER}</pre>
            {!revealed && <div className="locked-stamp">ENCRYPTED</div>}
          </div>

          <div className="meta">
            <span>
              bond <b>{bondAmount} XLM</b>
            </span>
            <span>
              bounty <b>{bountyBps}%</b>
            </span>
            <span>
              readers <b>{grant?.bonded ?? '—'}</b>
            </span>
            <span>
              burned <b>{grant?.burned ?? '—'}</b>
            </span>
          </div>

          {!revealed && (
            <>
              <button onClick={handleBond} disabled={!signer || !grant || isBusy(bondAction)}>
                BOND &amp; UNLOCK
              </button>
              <div className="hint">
                {!signer
                  ? 'Connect a Testnet wallet to post a bond.'
                  : `Posts ${bondAmount} XLM and registers a freshly generated ed25519 public key. You are shown the secret half once.`}
              </div>
            </>
          )}

          <ActionStatus action={bondAction} done="bond posted" />

          {revealed && credential && (
            <div className="cred">
              <div className="label">ACCESS CREDENTIAL</div>
              <code>{toBase64(credential.secretKey)}</code>
              <div className="warn">
                This key opens the document. It can also take your {bondAmount} XLM.
              </div>
              <div className="cred-actions">
                <button className="ghost tiny" onClick={copyCredential}>
                  {copied ? 'COPIED' : 'COPY'}
                </button>
                <span className="hint">
                  public key {bytesToHex(credential.publicKey).slice(0, 16)}…
                </span>
              </div>
            </div>
          )}
        </section>

        {/* -------------------------------------------- ② BONDED READERS */}
        <section className="col">
          <h2>
            <span className="num">②</span>BONDED READERS
          </h2>

          {rows.length === 0 ? (
            <div className="hint">
              {chainError ? 'chain unreachable' : 'no readers bonded yet'}
            </div>
          ) : (
            <div className="rows">
              {rows.map((r) => {
                const s = r.data.status;
                const shown = draining.has(r.keyHex) ? STATUS.BONDED : s;
                const mine = Boolean(connected && r.data.holder === connected);
                const ra = releaseActions[r.keyHex] ?? IDLE;

                return (
                  <div
                    key={r.keyHex}
                    className={`row ${s === STATUS.BURNED ? 'burned' : s === STATUS.BONDED ? 'bonded' : ''} ${mine ? 'mine' : ''}`}
                  >
                    <div className="row-top">
                      <span className="row-name">{labelFor(r.data.holder, connected)}</span>
                      <a
                        className="row-addr"
                        href={explorerAccount(r.data.holder)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {short(r.data.holder)}
                      </a>
                      <span
                        className={`pill ${shown === STATUS.BURNED ? 'burned' : shown === STATUS.RELEASED ? 'released' : 'bonded'}`}
                      >
                        {shown === STATUS.BURNED
                          ? 'BURNED'
                          : shown === STATUS.RELEASED
                            ? 'RELEASED'
                            : 'BONDED'}
                      </span>
                    </div>

                    <div className="bar">
                      <i
                        className={
                          s === STATUS.BURNED ? 'drained' : s === STATUS.RELEASED ? 'returned' : ''
                        }
                      />
                    </div>

                    <div className="row-key">key {r.keyHex}</div>

                    <div className="row-foot">
                      <span>
                        {s === STATUS.BONDED && `${bondAmount} XLM at risk`}
                        {s === STATUS.BURNED &&
                          `slashed · bounty to ${r.data.reporter ? labelFor(r.data.reporter, connected) : 'reporter'}`}
                        {s === STATUS.RELEASED && 'bond returned, never leaked'}
                      </span>
                      {mine &&
                        s === STATUS.BONDED &&
                        (untilExpiry <= 0 ? (
                          <button
                            className="ghost tiny"
                            onClick={() => handleRelease(r)}
                            disabled={isBusy(ra)}
                          >
                            RELEASE BOND
                          </button>
                        ) : (
                          <span className="hint">releasable in {countdown(untilExpiry)}</span>
                        ))}
                    </div>

                    {ra.phase !== 'idle' && (
                      <div className="row-foot">
                        <ActionStatus action={ra} done="bond released" />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ---------------------------------------------- ③ LEAK HUNTER */}
        <section className="col">
          <h2>
            <span className="num">③</span>LEAK HUNTER
          </h2>

          <div className="note">
            Paste a leaked ACCESS CREDENTIAL to prove the leak on chain and take the bounty. You do
            not need to own the document or hold a bond.
          </div>

          <textarea
            spellCheck={false}
            placeholder="paste leaked credential (base64)…"
            value={pasteCred}
            onChange={(e) => setPasteCred(e.target.value)}
          />

          {pasted && !pasted.ok && <div className="err">{pasted.error}</div>}
          {pasted?.ok && (
            <div
              className={`note ${pastedRow?.data.status === STATUS.BONDED ? 'good' : 'bad'}`}
            >
              {!pastedRow && 'That key does not belong to this grant.'}
              {pastedRow?.data.status === STATUS.BONDED &&
                `This is ${labelFor(pastedRow.data.holder, connected)}’s credential. Claiming burns their bond and pays you ${xlm(bountyStroops)} XLM.`}
              {pastedRow?.data.status === STATUS.BURNED && 'This credential is already spent.'}
              {pastedRow?.data.status === STATUS.RELEASED &&
                'That bond was already released at expiry.'}
            </div>
          )}

          <div className="bounty">
            <div className="amount">{xlm(bountyStroops)} XLM</div>
            <div className="sub">
              paid to you from the leaker’s bond, the moment you prove possession
            </div>
          </div>

          <button
            onClick={handleClaim}
            disabled={!signer || !pasted?.ok || isBusy(claimAction)}
          >
            CLAIM BOUNTY
          </button>

          <div className="hint">
            {!signer
              ? 'Connect any Testnet wallet to claim.'
              : `Signs grant_id ‖ ${short(signer.address)} — 88 bytes — with the pasted key. Your own address is inside the signature, so nobody can front-run this claim.`}
          </div>

          <ActionStatus action={claimAction} done="bounty claimed" />
        </section>
      </main>

      <footer className="strip">
        <div className="strip-head">FORENSIC LEDGER — CONTRACT EVENTS, STELLAR TESTNET</div>
        {strip.length === 0 ? (
          <div className="hint">no events for this grant in the retained window</div>
        ) : (
          strip.map((line) => (
            <div key={line.id} className={`strip-line ${freshIds.has(line.id) ? 'fresh' : ''}`}>
              <span className="seq">#{line.seq}</span>
              <span className={`tag ${line.kind}`}>
                ● {TAGS[line.kind] ?? line.kind.toUpperCase()}
              </span>
              <span className="body">{line.body}</span>
              <span className="link">
                <a href={explorerTx(line.hash)} target="_blank" rel="noreferrer">
                  tx ↗
                </a>
              </span>
            </div>
          ))
        )}
        <div ref={stripEnd} />
      </footer>
    </div>
  );
}
