import { useCallback, useEffect, useRef, useState } from 'react';
import nacl from 'tweetnacl';
import { DEPLOYMENT } from './deployment';
import {
  GRANT_ID,
  STATUS,
  addrVal,
  bytesVal,
  explorerContract,
  explorerTx,
  fromBase64,
  getGrant,
  invokeExplained,
  latestLedger,
  listHolders,
  recentEvents,
  signerAddress,
  toBase64,
  xlm,
} from './chain';
import type {
  GrantData,
  HolderRow,
  LedgerEvent,
  Signer,
} from './chain';
import { DOC_BODY, DOC_CIPHER } from './doc';
import { ensureDemoBoard, labelFor, short } from './seed';
import { connect, refreshWallet } from './wallet';
import type { WalletState } from './wallet';
import * as SDK from '@stellar/stellar-sdk';

export default function App() {
  const [wallet, setWallet] = useState<WalletState>({ status: 'disconnected' });
  const [grant, setGrant] = useState<GrantData | null>(null);
  const [rows, setRows] = useState<HolderRow[]>([]);
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [seq, setSeq] = useState<number>(0);

  const [seeding, setSeeding] = useState(false);
  const [seedMsg, setSeedMsg] = useState('');

  const [unlockedCred, setUnlockedCred] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [pasteCred, setPasteCred] = useState('');

  const [busy, setBusy] = useState<string>('');
  const [err, setErr] = useState<string>('');

  const pollRef = useRef<number | null>(null);

  /* ----------------------------------------------------------- state updates */

  const refreshState = useCallback(async () => {
    try {
      const lg = await latestLedger();
      setSeq(lg);

      const g = await getGrant(GRANT_ID);
      setGrant(g);

      const hs = await listHolders(GRANT_ID);
      setRows(hs);

      const evs = await recentEvents(lg);
      setEvents(evs);
    } catch (e) {
      // Quietly ignore transient poll errors if we already have data
    }
  }, []);

  /* ----------------------------------------------------------------- seed & init */

  useEffect(() => {
    let unmounted = false;

    async function init() {
      setSeeding(true);
      try {
        await ensureDemoBoard((msg) => {
          if (!unmounted) setSeedMsg(msg);
        });
      } catch (e) {
        console.error('Demo board seed failed:', e);
      } finally {
        if (!unmounted) {
          setSeeding(false);
          await refreshState();
        }
      }
    }

    init();

    pollRef.current = window.setInterval(async () => {
      await refreshState();
      setWallet((w) => {
        refreshWallet(w).then((nw) => {
          if (nw && JSON.stringify(nw) !== JSON.stringify(w)) {
            setWallet(nw);
          }
        });
        return w;
      });
    }, 4000);

    return () => {
      unmounted = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refreshState]);

  /* ------------------------------------------------------------- wallet handlers */

  async function handleConnect() {
    setErr('');
    setWallet({ status: 'connecting' });
    const res = await connect();
    setWallet(res);
    if (res.status === 'error') {
      setErr(res.message);
    }
  }

  /* ----------------------------------------------------------- contract actions */

  function getSigner(): Signer {
    if (wallet.status === 'connected') {
      return { kind: 'freighter', address: wallet.address };
    }
    // Fallback demo signer for visitors testing without Freighter
    const demoOwnerKey = SDK.Keypair.fromSecret(DEPLOYMENT.demo.owner.secret);
    return { kind: 'local', keypair: demoOwnerKey };
  }

  async function handleBond() {
    setErr('');
    setBusy('Generating credential…');
    try {
      const signer = getSigner();
      const kp = nacl.sign.keyPair();

      setBusy('Submitting bond transaction…');
      await invokeExplained(
        signer,
        'bond',
        [bytesVal(GRANT_ID), addrVal(signerAddress(signer)), bytesVal(kp.publicKey)],
        (stage) => setBusy(`Bonding: ${stage}…`),
      );

      const secretB64 = toBase64(kp.secretKey);
      setUnlockedCred(secretB64);
      setRevealed(true);
      await refreshState();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  async function handleClaim() {
    setErr('');
    if (!pasteCred.trim()) {
      setErr('Please paste a leaked credential first.');
      return;
    }

    setBusy('Verifying leaked key signature…');
    try {
      const sk = fromBase64(pasteCred.trim());
      if (sk.length !== 64) {
        throw new Error('Credential must be 64 bytes (base64 encoded).');
      }

      const kp = nacl.sign.keyPair.fromSecretKey(sk);
      const sig = nacl.sign.detached(GRANT_ID, sk);
      const signer = getSigner();

      setBusy('Submitting leak proof…');
      await invokeExplained(
        signer,
        'prove_leak',
        [bytesVal(GRANT_ID), bytesVal(kp.publicKey), addrVal(signerAddress(signer)), bytesVal(sig)],
        (stage) => setBusy(`Claiming: ${stage}…`),
      );

      setPasteCred('');
      await refreshState();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  /* ------------------------------------------------------------- rendering math */

  const bondAmount = grant ? xlm(grant.bond_amount) : '—';
  const bountyBps = grant ? grant.bounty_bps / 100 : 0;
  const bountyAmount = grant
    ? xlm((grant.bond_amount * BigInt(grant.bounty_bps)) / 10000n)
    : '—';

  return (
    <div className="app">
      {/* ------------------------------------------------------------- header */}
      <header className="top">
        <span className="brand">POISONKEY</span>
        <span className="tagline">credentials that punish their own leak</span>

        <div className="top-right">
          {seeding && (
            <span className="kv">
              <i className="dot on" />
              <span className="live">{seedMsg || 'seeding demo board…'}</span>
            </span>
          )}

          <span className="kv">
            ledger{' '}
            <b>
              {seq ? (
                <a href={explorerContract()} target="_blank" rel="noreferrer">
                  #{seq}
                </a>
              ) : (
                '—'
              )}
            </b>
          </span>

          {wallet.status === 'connected' ? (
            <button className="ghost tiny" title={wallet.address}>
              <i className="dot on" />
              {short(wallet.address)}
            </button>
          ) : wallet.status === 'wrong-network' ? (
            <button className="ghost tiny bad" onClick={handleConnect}>
              <i className="dot bad" />
              SWITCH TO TESTNET
            </button>
          ) : (
            <button
              className="tiny"
              onClick={handleConnect}
              disabled={wallet.status === 'connecting'}
            >
              {wallet.status === 'connecting' ? 'CONNECTING…' : 'CONNECT FREIGHTER'}
            </button>
          )}
        </div>
      </header>

      {err && <div className="banner bad">! {err}</div>}
      {busy && <div className="banner">· {busy}</div>}

      {/* ------------------------------------------------------------- columns */}
      <main className="cols">
        {/* ---------------- column 1 ---------------- */}
        <section className="col">
          <h2>
            <span className="num">①</span>THE SECRET
          </h2>

          <div className="doc-title">{grant?.cipher_ref || 'Q3 Board Deck — CONFIDENTIAL'}</div>

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
          </div>

          {!revealed ? (
            <button onClick={handleBond} disabled={!!busy}>
              BOND &amp; UNLOCK
            </button>
          ) : (
            <div className="cred">
              <div className="label">ACCESS CREDENTIAL</div>
              <code>{unlockedCred}</code>
              <div className="warn">
                Keep this key private. If leaked, anyone can claim your {bondAmount} XLM bond!
              </div>
              <div className="cred-actions">
                <button
                  className="ghost tiny"
                  onClick={() => navigator.clipboard.writeText(unlockedCred || '')}
                >
                  COPY KEY
                </button>
              </div>
            </div>
          )}
        </section>

        {/* ---------------- column 2 ---------------- */}
        <section className="col">
          <h2>
            <span className="num">②</span>BONDED READERS
          </h2>

          {rows.length === 0 ? (
            <div className="hint">No readers bonded yet.</div>
          ) : (
            <div className="rows">
              {rows.map((r, i) => {
                const isMine =
                  wallet.status === 'connected' && r.data.holder === wallet.address;
                const isBurned = r.data.status === STATUS.BURNED;
                const isReleased = r.data.status === STATUS.RELEASED;

                return (
                  <div
                    key={i}
                    className={`row ${isBurned ? 'burned' : 'bonded'} ${
                      isMine ? 'mine' : ''
                    }`}
                  >
                    <div className="row-top">
                      <span className="row-name">
                        {labelFor(r.data.holder, wallet.status === 'connected' ? wallet.address : undefined)}
                      </span>
                      <span
                        className={`pill ${
                          isBurned ? 'burned' : isReleased ? 'released' : 'bonded'
                        }`}
                      >
                        {isBurned ? 'BURNED' : isReleased ? 'RELEASED' : 'BONDED'}
                      </span>
                    </div>

                    <div className="row-addr">{short(r.data.holder)}</div>

                    <div className="bar">
                      <i className={isBurned ? 'drained' : isReleased ? 'returned' : ''} />
                    </div>

                    <div className="row-foot">
                      <span>{bondAmount} XLM</span>
                      {r.data.reporter && (
                        <span>
                          · claimed by {labelFor(r.data.reporter)}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ---------------- column 3 ---------------- */}
        <section className="col">
          <h2>
            <span className="num">③</span>LEAK HUNTER
          </h2>

          <div className="note">
            Paste a leaked ACCESS CREDENTIAL to prove the leak on-chain and claim the bounty.
          </div>

          <textarea
            placeholder="paste leaked credential (base64)…"
            value={pasteCred}
            onChange={(e) => setPasteCred(e.target.value)}
          />

          <div className="bounty">
            <div className="amount">{bountyAmount} XLM</div>
            <div className="sub">bounty reward for proving leak</div>
          </div>

          <button onClick={handleClaim} disabled={!pasteCred.trim() || !!busy}>
            CLAIM BOUNTY
          </button>
        </section>
      </main>

      {/* ------------------------------------------------------------- footer */}
      <footer className="strip">
        <div className="strip-head">LEDGER EVENTS</div>
        {events.length === 0 ? (
          <div className="hint">No events recorded on ledger.</div>
        ) : (
          events.slice(0, 8).map((ev, i) => (
            <div key={i} className="strip-line">
              <span className="seq">#{ev.ledger}</span>
              <span className={`tag ${ev.kind}`}>● {ev.kind.toUpperCase()}</span>
              <span className="body">{JSON.stringify(ev.data)}</span>
              <a
                className="link"
                href={explorerTx(ev.txHash)}
                target="_blank"
                rel="noreferrer"
              >
                tx ↗
              </a>
            </div>
          ))
        )}
      </footer>
    </div>
  );
}
