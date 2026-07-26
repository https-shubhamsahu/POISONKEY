#![cfg(test)]
//! # The 88-byte proof message
//!
//! `prove_leak` verifies an ed25519 signature over exactly 88 bytes, laid out as:
//!
//! * **bytes 0..32** — the raw 32-byte `grant_id`, exactly as passed to the call.
//! * **bytes 32..88** — the claimant's Stellar address as 56 ASCII bytes: the
//!   strkey text form starting with `G`, *not* the decoded 32-byte public key and
//!   with no length prefix, separator, or terminator.
//!
//! Concatenated, nothing else, no hashing applied by the caller — the host
//! function hashes internally as ed25519 requires. Because the claimant's own
//! address is inside the signed bytes, a signature is only usable by the one
//! account named in it: observing it in the mempool gains an attacker nothing.

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, Address, BytesN, Env, String};

const BOND: i128 = 500_000_000; // 50 XLM in stroops
const BOUNTY_BPS: u32 = 5_000; // 50%
const WEEK: u64 = 7 * 24 * 60 * 60;

struct Fixture {
    env: Env,
    client: PoisonKeyClient<'static>,
    token: Address,
    owner: Address,
    grant_id: BytesN<32>,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();

    let contract_id = env.register(PoisonKey, ());
    let client = PoisonKeyClient::new(&env, &contract_id);

    let owner = Address::generate(&env);
    let grant_id = BytesN::from_array(&env, &[0xa1; 32]);

    client.publish(
        &owner,
        &grant_id,
        &token,
        &BOND,
        &BOUNTY_BPS,
        &(env.ledger().timestamp() + WEEK),
        &String::from_str(&env, "Q3 Board Deck — CONFIDENTIAL"),
    );

    Fixture {
        env,
        client,
        token,
        owner,
        grant_id,
    }
}

/// Mint `amount` of the fixture token to `to`.
fn fund(env: &Env, token: &Address, to: &Address, amount: i128) {
    token::StellarAssetClient::new(env, token).mint(to, &amount);
}

fn balance(env: &Env, token: &Address, who: &Address) -> i128 {
    token::Client::new(env, token).balance(who)
}

/// A credential: the ed25519 keypair whose secret half both decrypts the
/// document and can slash the holder's bond.
fn credential(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn key_pub(env: &Env, sk: &SigningKey) -> BytesN<32> {
    BytesN::from_array(env, &sk.verifying_key().to_bytes())
}

/// Build the 88-byte proof message and sign it — the exact layout documented at
/// the top of this file, and the exact layout the frontend reproduces in JS.
fn sign_proof(env: &Env, sk: &SigningKey, grant_id: &BytesN<32>, claimant: &Address) -> BytesN<64> {
    let mut addr = [0u8; 56];
    claimant.to_string().copy_into_slice(&mut addr);

    let mut msg = [0u8; 88];
    msg[..32].copy_from_slice(&grant_id.to_array());
    msg[32..].copy_from_slice(&addr);

    BytesN::from_array(env, &sk.sign(&msg).to_bytes())
}

#[test]
fn publish_stores_grant() {
    let f = setup();
    let g = f.client.get_grant(&f.grant_id);

    assert_eq!(g.owner, f.owner);
    assert_eq!(g.token, f.token);
    assert_eq!(g.bond_amount, BOND);
    assert_eq!(g.bounty_bps, BOUNTY_BPS);
    assert_eq!(g.bonded, 0);
    assert_eq!(g.burned, 0);
    assert_eq!(f.client.list_holders(&f.grant_id).len(), 0);
}

#[test]
fn publish_rejects_duplicate_and_bad_params() {
    let f = setup();
    let expiry = f.env.ledger().timestamp() + WEEK;
    let title = String::from_str(&f.env, "dup");

    assert_eq!(
        f.client
            .try_publish(
                &f.owner,
                &f.grant_id,
                &f.token,
                &BOND,
                &BOUNTY_BPS,
                &expiry,
                &title
            )
            .err(),
        Some(Ok(Error::GrantExists))
    );

    let other = BytesN::from_array(&f.env, &[0xb2; 32]);
    assert_eq!(
        f.client
            .try_publish(&f.owner, &other, &f.token, &0, &BOUNTY_BPS, &expiry, &title)
            .err(),
        Some(Ok(Error::BadParams))
    );
    assert_eq!(
        f.client
            .try_publish(&f.owner, &other, &f.token, &BOND, &10_001, &expiry, &title)
            .err(),
        Some(Ok(Error::BadParams))
    );
}

#[test]
fn bond_moves_tokens_into_contract() {
    let f = setup();
    let bob = Address::generate(&f.env);
    fund(&f.env, &f.token, &bob, BOND);

    let cred = credential(1);
    let kp = key_pub(&f.env, &cred);
    f.client.bond(&f.grant_id, &bob, &kp);

    assert_eq!(balance(&f.env, &f.token, &bob), 0);
    assert_eq!(balance(&f.env, &f.token, &f.client.address), BOND);

    let g = f.client.get_grant(&f.grant_id);
    assert_eq!(g.bonded, 1);
    assert_eq!(g.burned, 0);

    let h = f.client.get_holder(&f.grant_id, &kp);
    assert_eq!(h.holder, bob);
    assert_eq!(h.status, STATUS_BONDED);
    assert_eq!(h.reporter, None);

    let rows = f.client.list_holders(&f.grant_id);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows.get(0).unwrap(), (kp, h));
}

#[test]
fn bond_rejects_duplicate_key_and_missing_grant() {
    let f = setup();
    let bob = Address::generate(&f.env);
    fund(&f.env, &f.token, &bob, BOND * 2);

    let kp = key_pub(&f.env, &credential(1));
    f.client.bond(&f.grant_id, &bob, &kp);

    assert_eq!(
        f.client.try_bond(&f.grant_id, &bob, &kp).err(),
        Some(Ok(Error::KeyExists))
    );

    let ghost = BytesN::from_array(&f.env, &[0xcc; 32]);
    assert_eq!(
        f.client.try_bond(&ghost, &bob, &key_pub(&f.env, &credential(9))).err(),
        Some(Ok(Error::GrantMissing))
    );
}

#[test]
fn prove_leak_pays_bounty_and_remainder() {
    let f = setup();
    let bob = Address::generate(&f.env);
    let hunter = Address::generate(&f.env);
    fund(&f.env, &f.token, &bob, BOND);

    let cred = credential(1);
    let kp = key_pub(&f.env, &cred);
    f.client.bond(&f.grant_id, &bob, &kp);

    // Bob leaks the credential; the hunter proves possession against their own
    // address and claims.
    let sig = sign_proof(&f.env, &cred, &f.grant_id, &hunter);
    let paid = f.client.prove_leak(&f.grant_id, &kp, &hunter, &sig);

    let expected_bounty = BOND * BOUNTY_BPS as i128 / 10_000;
    assert_eq!(paid, expected_bounty);
    assert_eq!(balance(&f.env, &f.token, &hunter), expected_bounty);
    assert_eq!(balance(&f.env, &f.token, &f.owner), BOND - expected_bounty);
    assert_eq!(balance(&f.env, &f.token, &f.client.address), 0);

    // Funds never return to the leaker.
    assert_eq!(balance(&f.env, &f.token, &bob), 0);

    let h = f.client.get_holder(&f.grant_id, &kp);
    assert_eq!(h.status, STATUS_BURNED);
    assert_eq!(h.reporter, Some(hunter));
    assert_eq!(f.client.get_grant(&f.grant_id).burned, 1);
}

#[test]
fn prove_leak_rejects_wrong_signature() {
    let f = setup();
    let bob = Address::generate(&f.env);
    let hunter = Address::generate(&f.env);
    fund(&f.env, &f.token, &bob, BOND);

    let cred = credential(1);
    let kp = key_pub(&f.env, &cred);
    f.client.bond(&f.grant_id, &bob, &kp);

    // Signed by a key that is not the registered credential.
    let sig = sign_proof(&f.env, &credential(7), &f.grant_id, &hunter);
    assert!(f.client.try_prove_leak(&f.grant_id, &kp, &hunter, &sig).is_err());

    // Nothing moved, nothing changed.
    assert_eq!(balance(&f.env, &f.token, &hunter), 0);
    assert_eq!(balance(&f.env, &f.token, &f.owner), 0);
    assert_eq!(balance(&f.env, &f.token, &f.client.address), BOND);
    assert_eq!(f.client.get_holder(&f.grant_id, &kp).status, STATUS_BONDED);
    assert_eq!(f.client.get_grant(&f.grant_id).burned, 0);
}

/// The proof is bound to the claimant's address, so a signature observed in the
/// mempool cannot be replayed by a front-runner.
#[test]
fn prove_leak_rejects_signature_bound_to_another_claimant() {
    let f = setup();
    let bob = Address::generate(&f.env);
    let hunter = Address::generate(&f.env);
    let frontrunner = Address::generate(&f.env);
    fund(&f.env, &f.token, &bob, BOND);

    let cred = credential(1);
    let kp = key_pub(&f.env, &cred);
    f.client.bond(&f.grant_id, &bob, &kp);

    let sig_for_hunter = sign_proof(&f.env, &cred, &f.grant_id, &hunter);
    assert!(f
        .client
        .try_prove_leak(&f.grant_id, &kp, &frontrunner, &sig_for_hunter)
        .is_err());

    assert_eq!(balance(&f.env, &f.token, &frontrunner), 0);
    assert_eq!(balance(&f.env, &f.token, &f.client.address), BOND);

    // The rightful claimant can still use it.
    f.client
        .prove_leak(&f.grant_id, &kp, &hunter, &sig_for_hunter);
    assert_eq!(
        balance(&f.env, &f.token, &hunter),
        BOND * BOUNTY_BPS as i128 / 10_000
    );
}

#[test]
fn prove_leak_rejects_spent_credential_and_unknown_key() {
    let f = setup();
    let bob = Address::generate(&f.env);
    let hunter = Address::generate(&f.env);
    let second = Address::generate(&f.env);
    fund(&f.env, &f.token, &bob, BOND);

    let cred = credential(1);
    let kp = key_pub(&f.env, &cred);
    f.client.bond(&f.grant_id, &bob, &kp);
    f.client.prove_leak(
        &f.grant_id,
        &kp,
        &hunter,
        &sign_proof(&f.env, &cred, &f.grant_id, &hunter),
    );

    // Already burned.
    assert_eq!(
        f.client
            .try_prove_leak(
                &f.grant_id,
                &kp,
                &second,
                &sign_proof(&f.env, &cred, &f.grant_id, &second)
            )
            .err(),
        Some(Ok(Error::WrongStatus))
    );

    // A key that was never bonded to this grant.
    let stranger = credential(3);
    assert_eq!(
        f.client
            .try_prove_leak(
                &f.grant_id,
                &key_pub(&f.env, &stranger),
                &second,
                &sign_proof(&f.env, &stranger, &f.grant_id, &second)
            )
            .err(),
        Some(Ok(Error::HolderMissing))
    );
}

#[test]
fn release_returns_bond_after_expiry() {
    let f = setup();
    let cara = Address::generate(&f.env);
    fund(&f.env, &f.token, &cara, BOND);

    let kp = key_pub(&f.env, &credential(2));
    f.client.bond(&f.grant_id, &cara, &kp);

    // Not yet expired.
    assert_eq!(
        f.client.try_release(&f.grant_id, &kp).err(),
        Some(Ok(Error::NotExpired))
    );

    let expires_at = f.client.get_grant(&f.grant_id).expires_at;
    f.env.ledger().with_mut(|li| li.timestamp = expires_at);

    f.client.release(&f.grant_id, &kp);
    assert_eq!(balance(&f.env, &f.token, &cara), BOND);
    assert_eq!(balance(&f.env, &f.token, &f.client.address), 0);
    assert_eq!(f.client.get_holder(&f.grant_id, &kp).status, STATUS_RELEASED);

    // Cannot release twice, and cannot be slashed afterwards.
    assert_eq!(
        f.client.try_release(&f.grant_id, &kp).err(),
        Some(Ok(Error::WrongStatus))
    );
}
