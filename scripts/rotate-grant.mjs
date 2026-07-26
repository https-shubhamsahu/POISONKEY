// Point the demo at a brand new grant id and regenerate the frontend config.
//
//   node scripts/rotate-grant.mjs
//
// Use this between rehearsals. Once a reader's bond has been burned, that
// credential is spent forever and its row cannot go back to BONDED — a fresh
// grant id gives the page a clean board, which it re-seeds on next load.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, loadState, saveState, bytesToHex } from './lib.mjs';

const state = loadState();
if (!state.contractId) {
  console.error('no contractId in deploy/testnet.json — run scripts/deploy.mjs first');
  process.exit(1);
}

const previous = state.grantIdHex;
const grantIdHex = bytesToHex(new Uint8Array(randomBytes(32)));
saveState({ grantIdHex, previousGrantIdHex: previous });

execFileSync(process.execPath, [join(ROOT, 'scripts', 'write-config.mjs')], { stdio: 'inherit' });

console.log(`\nrotated demo grant`);
console.log(`  was  ${previous}`);
console.log(`  now  ${grantIdHex}`);
console.log('\nReload the page — it will publish the new grant and re-bond BOB and CARA.');
