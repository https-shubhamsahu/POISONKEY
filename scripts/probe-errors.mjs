// Capture the exact error text the RPC returns for each failure branch, so the
// frontend's error mapping is based on real strings rather than guesses.
//
//   node scripts/probe-errors.mjs
import { randomBytes } from 'node:crypto';
import {
  SDK,
  nacl,
  XLM_SAC,
  BOND_STROOPS,
  BOUNTY_BPS,
  loadState,
  fundIfNeeded,
  invoke,
  bytesVal,
  addrVal,
  i128Val,
  u32Val,
  u64Val,
  strVal,
  signProof,
} from './lib.mjs';

async function expectFail(label, p) {
  try {
    await p;
    console.log(`\n### ${label}\n  !! unexpectedly succeeded`);
  } catch (e) {
    console.log(`\n### ${label}\n${e.message}`);
  }
}

async function main() {
  const state = loadState();
  const CONTRACT = state.contractId;
  const owner = SDK.Keypair.fromSecret(state.deployer.secret);
  const bob = SDK.Keypair.fromSecret(state.bob.secret);
  const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;

  const grantId = new Uint8Array(randomBytes(32));
  await invoke(owner, CONTRACT, 'publish', [
    addrVal(owner.publicKey()),
    bytesVal(grantId),
    addrVal(XLM_SAC),
    i128Val(BOND_STROOPS.toString()),
    u32Val(BOUNTY_BPS),
    u64Val(expiresAt.toString()),
    strVal('probe'),
  ]);

  const cred = nacl.sign.keyPair();
  await invoke(bob, CONTRACT, 'bond', [
    bytesVal(grantId),
    addrVal(bob.publicKey()),
    bytesVal(cred.publicKey),
  ]);

  const hunter = SDK.Keypair.random();
  await fundIfNeeded(hunter.publicKey(), 'HUNTER');

  // 1. signature from the wrong key -> host trap in ed25519_verify
  const wrong = nacl.sign.keyPair();
  await expectFail(
    'BAD SIGNATURE (ed25519_verify trap)',
    invoke(hunter, CONTRACT, 'prove_leak', [
      bytesVal(grantId),
      bytesVal(cred.publicKey),
      addrVal(hunter.publicKey()),
      bytesVal(signProof(grantId, hunter.publicKey(), wrong.secretKey)),
    ]),
  );

  // 2. a key never bonded to this grant -> Error::HolderMissing (#5)
  const stranger = nacl.sign.keyPair();
  await expectFail(
    'HOLDER MISSING (#5)',
    invoke(hunter, CONTRACT, 'prove_leak', [
      bytesVal(grantId),
      bytesVal(stranger.publicKey),
      addrVal(hunter.publicKey()),
      bytesVal(signProof(grantId, hunter.publicKey(), stranger.secretKey)),
    ]),
  );

  // 3. already spent -> Error::WrongStatus (#6)
  await invoke(hunter, CONTRACT, 'prove_leak', [
    bytesVal(grantId),
    bytesVal(cred.publicKey),
    addrVal(hunter.publicKey()),
    bytesVal(signProof(grantId, hunter.publicKey(), cred.secretKey)),
  ]);
  const second = SDK.Keypair.random();
  await fundIfNeeded(second.publicKey(), 'SECOND');
  await expectFail(
    'WRONG STATUS / already spent (#6)',
    invoke(second, CONTRACT, 'prove_leak', [
      bytesVal(grantId),
      bytesVal(cred.publicKey),
      addrVal(second.publicKey()),
      bytesVal(signProof(grantId, second.publicKey(), cred.secretKey)),
    ]),
  );

  // 4. duplicate credential -> Error::KeyExists (#4)
  const dupGrant = new Uint8Array(randomBytes(32));
  await invoke(owner, CONTRACT, 'publish', [
    addrVal(owner.publicKey()),
    bytesVal(dupGrant),
    addrVal(XLM_SAC),
    i128Val(BOND_STROOPS.toString()),
    u32Val(BOUNTY_BPS),
    u64Val(expiresAt.toString()),
    strVal('probe-dup'),
  ]);
  const dupCred = nacl.sign.keyPair();
  await invoke(bob, CONTRACT, 'bond', [
    bytesVal(dupGrant),
    addrVal(bob.publicKey()),
    bytesVal(dupCred.publicKey),
  ]);
  await expectFail(
    'KEY EXISTS (#4)',
    invoke(bob, CONTRACT, 'bond', [
      bytesVal(dupGrant),
      addrVal(bob.publicKey()),
      bytesVal(dupCred.publicKey),
    ]),
  );

  // 5. grant missing -> Error::GrantMissing (#2)
  await expectFail(
    'GRANT MISSING (#2)',
    invoke(bob, CONTRACT, 'bond', [
      bytesVal(new Uint8Array(randomBytes(32))),
      addrVal(bob.publicKey()),
      bytesVal(nacl.sign.keyPair().publicKey),
    ]),
  );

  // 6. not expired -> Error::NotExpired (#8)
  await expectFail(
    'NOT EXPIRED (#8)',
    invoke(bob, CONTRACT, 'release', [bytesVal(dupGrant), bytesVal(dupCred.publicKey)]),
  );

  // 7. insufficient balance: a grant whose bond exceeds the holder's XLM
  const richGrant = new Uint8Array(randomBytes(32));
  await invoke(owner, CONTRACT, 'publish', [
    addrVal(owner.publicKey()),
    bytesVal(richGrant),
    addrVal(XLM_SAC),
    i128Val((999_999n * 10_000_000n).toString()),
    u32Val(BOUNTY_BPS),
    u64Val(expiresAt.toString()),
    strVal('probe-rich'),
  ]);
  await expectFail(
    'INSUFFICIENT BALANCE (SAC)',
    invoke(bob, CONTRACT, 'bond', [
      bytesVal(richGrant),
      addrVal(bob.publicKey()),
      bytesVal(nacl.sign.keyPair().publicKey),
    ]),
  );

  // 8. an account that does not exist on the network at all
  const ghost = SDK.Keypair.random();
  await expectFail(
    'ACCOUNT NOT FUNDED',
    invoke(ghost, CONTRACT, 'bond', [
      bytesVal(dupGrant),
      addrVal(ghost.publicKey()),
      bytesVal(nacl.sign.keyPair().publicKey),
    ]),
  );
}

main().catch((e) => {
  console.error(`probe failed: ${e.message}`);
  process.exit(1);
});
