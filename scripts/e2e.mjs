// Full happy path against the deployed contract on Stellar Testnet, on a
// throwaway grant so the demo board is left untouched:
//
//   publish -> bond -> prove_leak (88-byte proof) -> assert payouts
//   plus the two failure branches: bad signature, and replay by a front-runner.
//
//   node scripts/e2e.mjs
import { randomBytes } from 'node:crypto';
import {
  SDK,
  nacl,
  server,
  XLM_SAC,
  BOND_STROOPS,
  BOUNTY_BPS,
  STROOP,
  loadState,
  fundIfNeeded,
  invoke,
  read,
  bytesVal,
  addrVal,
  i128Val,
  u32Val,
  u64Val,
  strVal,
  bytesToHex,
  proofMessage,
  signProof,
} from './lib.mjs';

const xlm = (stroops) => `${Number(stroops) / 1e7} XLM`;

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n          got ${actual}\n          want ${expected}`}`);
}
function checkTrue(label, cond, detail = '') {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  ${detail}`}`);
}

// Simulation needs a real G-account as the transaction source; the subject of the
// balance read is just an argument, so contract addresses work fine here.
let simSource;
const balance = (who) => read(XLM_SAC, 'balance', [addrVal(who)], simSource);

async function main() {
  const state = loadState();
  if (!state.contractId) throw new Error('no contractId in deploy/testnet.json — run scripts/deploy.mjs');
  const CONTRACT = state.contractId;
  const owner = SDK.Keypair.fromSecret(state.deployer.secret);
  const leaker = SDK.Keypair.fromSecret(state.bob.secret);
  simSource = owner.publicKey();

  console.log(`contract ${CONTRACT}\n`);

  // A fresh grant and a fresh hunter, so this run is independent of the demo board.
  const grantId = new Uint8Array(randomBytes(32));
  const grantHex = bytesToHex(grantId);
  const hunter = SDK.Keypair.random();
  const frontrunner = SDK.Keypair.random();

  console.log('accounts');
  await fundIfNeeded(hunter.publicKey(), 'HUNTER');
  await fundIfNeeded(frontrunner.publicKey(), 'FRONTRUN');

  // ---- publish ------------------------------------------------------------
  const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
  console.log(`\npublish  grant ${grantHex.slice(0, 16)}…`);
  await invoke(owner, CONTRACT, 'publish', [
    addrVal(owner.publicKey()),
    bytesVal(grantId),
    addrVal(XLM_SAC),
    i128Val(BOND_STROOPS.toString()),
    u32Val(BOUNTY_BPS),
    u64Val(expiresAt.toString()),
    strVal('E2E — CONFIDENTIAL'),
  ]);

  const grant = await read(CONTRACT, 'get_grant', [bytesVal(grantId)], owner.publicKey());
  check('bond_amount stored', grant.bond_amount, BOND_STROOPS);
  check('bounty_bps stored', grant.bounty_bps, BOUNTY_BPS);

  // ---- bond ---------------------------------------------------------------
  // The credential: the ed25519 keypair that both decrypts the doc and can
  // slash this bond.
  const credential = nacl.sign.keyPair();
  const contractBefore = await balance(CONTRACT);

  console.log('\nbond');
  await invoke(leaker, CONTRACT, 'bond', [
    bytesVal(grantId),
    addrVal(leaker.publicKey()),
    bytesVal(credential.publicKey),
  ]);

  const contractAfterBond = await balance(CONTRACT);
  check('contract received the bond', contractAfterBond - contractBefore, BOND_STROOPS);
  const holder = await read(
    CONTRACT,
    'get_holder',
    [bytesVal(grantId), bytesVal(credential.publicKey)],
    owner.publicKey(),
  );
  check('holder is the bonder', holder.holder, leaker.publicKey());
  check('status BONDED', holder.status, 0);

  // ---- the 88-byte proof --------------------------------------------------
  const msg = proofMessage(grantId, hunter.publicKey());
  const sig = signProof(grantId, hunter.publicKey(), credential.secretKey);
  console.log('\nproof message');
  console.log(`  length     ${msg.length} bytes`);
  console.log(`  msg        ${msg.toString('hex')}`);
  console.log(`  publicKey  ${bytesToHex(credential.publicKey)}`);
  console.log(`  signature  ${bytesToHex(sig)}`);
  check('message is 88 bytes', msg.length, 88);

  // ---- failure branch: signature from the wrong key ------------------------
  console.log('\nreject: signature from a key that is not the credential');
  const wrongKey = nacl.sign.keyPair();
  await invoke(hunter, CONTRACT, 'prove_leak', [
    bytesVal(grantId),
    bytesVal(credential.publicKey),
    addrVal(hunter.publicKey()),
    bytesVal(signProof(grantId, hunter.publicKey(), wrongKey.secretKey)),
  ]).then(
    () => checkTrue('bad signature rejected', false, 'the call succeeded'),
    (e) => checkTrue('bad signature rejected', true, e.message.slice(0, 60)),
  );

  // ---- failure branch: replay by a front-runner ---------------------------
  console.log('\nreject: hunter’s signature replayed by a front-runner');
  await invoke(frontrunner, CONTRACT, 'prove_leak', [
    bytesVal(grantId),
    bytesVal(credential.publicKey),
    addrVal(frontrunner.publicKey()),
    bytesVal(sig),
  ]).then(
    () => checkTrue('replay rejected', false, 'the front-runner claimed it'),
    (e) => checkTrue('replay rejected', true, e.message.slice(0, 60)),
  );

  // ---- the claim ----------------------------------------------------------
  const ownerBefore = await balance(owner.publicKey());
  const hunterBefore = await balance(hunter.publicKey());
  const leakerBefore = await balance(leaker.publicKey());

  console.log('\nprove_leak');
  const claimed = await invoke(hunter, CONTRACT, 'prove_leak', [
    bytesVal(grantId),
    bytesVal(credential.publicKey),
    addrVal(hunter.publicKey()),
    bytesVal(sig),
  ]);
  const bountyPaid = SDK.scValToNative(claimed.returnValue);
  const expectedBounty = (BOND_STROOPS * BigInt(BOUNTY_BPS)) / 10_000n;

  const ownerAfter = await balance(owner.publicKey());
  const hunterAfter = await balance(hunter.publicKey());
  const leakerAfter = await balance(leaker.publicKey());
  const contractAfter = await balance(CONTRACT);

  console.log('\nsettlement');
  check('returned bounty', bountyPaid, expectedBounty);
  check('owner received the remainder', ownerAfter - ownerBefore, BOND_STROOPS - expectedBounty);
  check('contract released the whole bond', contractAfterBond - contractAfter, BOND_STROOPS);
  checkTrue(
    `hunter gained the bounty net of fees (${xlm(hunterAfter - hunterBefore)})`,
    hunterAfter - hunterBefore > expectedBounty - STROOP,
    `delta ${hunterAfter - hunterBefore}`,
  );
  check('leaker recovered nothing', leakerAfter - leakerBefore, 0n);

  const burned = await read(
    CONTRACT,
    'get_holder',
    [bytesVal(grantId), bytesVal(credential.publicKey)],
    owner.publicKey(),
  );
  check('status BURNED', burned.status, 1);
  check('reporter recorded', burned.reporter, hunter.publicKey());
  const finalGrant = await read(CONTRACT, 'get_grant', [bytesVal(grantId)], owner.publicKey());
  check('burned counter', finalGrant.burned, 1);

  // ---- already spent ------------------------------------------------------
  console.log('\nreject: credential already spent');
  await invoke(frontrunner, CONTRACT, 'prove_leak', [
    bytesVal(grantId),
    bytesVal(credential.publicKey),
    addrVal(frontrunner.publicKey()),
    bytesVal(signProof(grantId, frontrunner.publicKey(), credential.secretKey)),
  ]).then(
    () => checkTrue('spent credential rejected', false, 'it paid out twice'),
    (e) => checkTrue('spent credential rejected', true, e.message.slice(0, 60)),
  );

  console.log(
    `\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}` +
      `\nclaim tx  https://stellar.expert/explorer/testnet/tx/${claimed.hash}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\ne2e failed: ${e.message}`);
  process.exit(1);
});
