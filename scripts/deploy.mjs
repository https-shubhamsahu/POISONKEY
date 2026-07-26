// Deploy POISONKEY to Stellar Testnet and provision the demo accounts.
//
//   node scripts/deploy.mjs
//
// Idempotent: re-running reuses the keypairs in deploy/testnet.json and only
// uploads/creates a contract if one is not recorded yet. Pass --redeploy to
// force a fresh contract instance.
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  SDK,
  server,
  NETWORK_PASSPHRASE,
  WASM_PATH,
  STATE_PATH,
  XLM_SAC,
  GRANT_ID_HEX,
  loadState,
  saveState,
  fundIfNeeded,
  submit,
} from './lib.mjs';

const REDEPLOY = process.argv.includes('--redeploy');

function keypairFor(state, name) {
  if (state[name]?.secret) return SDK.Keypair.fromSecret(state[name].secret);
  return SDK.Keypair.random();
}

async function main() {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  let state = loadState();

  // ---- accounts -----------------------------------------------------------
  // Throwaway testnet identities. DEPLOYER is also the grant owner.
  const roles = ['deployer', 'bob', 'cara'];
  const keys = {};
  for (const role of roles) {
    const kp = keypairFor(state, role);
    keys[role] = kp;
    state = saveState({ [role]: { public: kp.publicKey(), secret: kp.secret() } });
  }

  console.log('accounts');
  for (const role of roles) await fundIfNeeded(keys[role].publicKey(), role.toUpperCase());

  // ---- upload + instantiate ----------------------------------------------
  if (state.contractId && !REDEPLOY) {
    console.log(`\ncontract already deployed: ${state.contractId}`);
    console.log('(pass --redeploy to create a new instance)');
  } else {
    const wasm = readFileSync(WASM_PATH);
    console.log(`\nwasm ${WASM_PATH} (${wasm.length} bytes)`);

    const deployer = keys.deployer;

    console.log('upload');
    const uploadAccount = await server.getAccount(deployer.publicKey());
    const uploadTx = await server.prepareTransaction(
      new SDK.TransactionBuilder(uploadAccount, {
        fee: '10000000',
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(SDK.Operation.uploadContractWasm({ wasm }))
        .setTimeout(180)
        .build(),
    );
    uploadTx.sign(deployer);
    const uploaded = await submit(uploadTx, 'uploadWasm');
    const wasmHash = uploaded.returnValue.bytes();
    console.log(`  wasm hash     ${wasmHash.toString('hex')}`);

    console.log('instantiate');
    const createAccount = await server.getAccount(deployer.publicKey());
    const createTx = await server.prepareTransaction(
      new SDK.TransactionBuilder(createAccount, {
        fee: '10000000',
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          SDK.Operation.createCustomContract({
            address: new SDK.Address(deployer.publicKey()),
            wasmHash,
            salt: SDK.hash(Buffer.from(`poisonkey:${Date.now()}`)),
          }),
        )
        .setTimeout(180)
        .build(),
    );
    createTx.sign(deployer);
    const created = await submit(createTx, 'createContract');
    const contractId = SDK.Address.fromScVal(created.returnValue).toString();

    state = saveState({
      contractId,
      wasmHash: wasmHash.toString('hex'),
      xlmSac: XLM_SAC,
      grantIdHex: GRANT_ID_HEX,
      network: 'testnet',
      networkPassphrase: NETWORK_PASSPHRASE,
    });
    console.log(`  contract id   ${contractId}`);
  }

  state = saveState({ xlmSac: XLM_SAC, grantIdHex: GRANT_ID_HEX });

  console.log('\n--- POISONKEY testnet deployment ---');
  console.log(`contract id      ${state.contractId}`);
  console.log(`grant id (hex)   ${state.grantIdHex}`);
  console.log(`XLM SAC          ${state.xlmSac}`);
  console.log(`owner  (deployer)${' '}${state.deployer.public}`);
  console.log(`BOB              ${state.bob.public}`);
  console.log(`CARA             ${state.cara.public}`);
  console.log(`state written to ${STATE_PATH}`);
  console.log(`\nexplorer         https://stellar.expert/explorer/testnet/contract/${state.contractId}`);
}

main().catch((e) => {
  console.error(`\ndeploy failed: ${e.message}`);
  process.exit(1);
});
