#![cfg_attr(not(test), no_std)]
//! POISONKEY — credentials that punish their own leak.
//!
//! A document owner publishes a grant: an encrypted secret plus a required bond.
//! Each reader posts that bond and registers an ed25519 public key; the matching
//! secret key is the only key that decrypts the document. That same key can also
//! destroy the reader's bond — anyone who obtains it proves possession to this
//! contract and claims a bounty paid out of the leaker's bond.
//!
//! Access credential and liability are the same key.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Bytes,
    BytesN, Env, String, Vec,
};

/// Holder bond is live and slashable.
pub const STATUS_BONDED: u32 = 0;
/// Holder's key was proven leaked; bond was slashed.
pub const STATUS_BURNED: u32 = 1;
/// Grant expired with no proven leak; bond was returned.
pub const STATUS_RELEASED: u32 = 2;

const BPS_DENOM: i128 = 10_000;

/// One ledger day, in ledgers (5s close time).
const DAY: u32 = 17_280;
const TTL_THRESHOLD: u32 = 30 * DAY;
const TTL_EXTEND_TO: u32 = 90 * DAY;

/// Length of a Stellar strkey account address in UTF-8 bytes.
const ADDR_LEN: usize = 56;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Grant(BytesN<32>),
    Holder(BytesN<32>, BytesN<32>),
    HolderList(BytesN<32>),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GrantData {
    pub owner: Address,
    pub token: Address,
    pub bond_amount: i128,
    pub bounty_bps: u32,
    pub expires_at: u64,
    pub cipher_ref: String,
    pub bonded: u32,
    pub burned: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HolderData {
    pub holder: Address,
    /// 0 = BONDED, 1 = BURNED, 2 = RELEASED
    pub status: u32,
    pub bonded_at: u64,
    pub reporter: Option<Address>,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    GrantExists = 1,
    GrantMissing = 2,
    BadParams = 3,
    KeyExists = 4,
    HolderMissing = 5,
    WrongStatus = 6,
    /// The signature did not verify under the registered public key.
    ///
    /// `env.crypto().ed25519_verify` is a host function that traps on a bad
    /// signature rather than returning, so a failed proof surfaces to callers as
    /// a host trap, not as this code. The variant is kept so the numbering of the
    /// error set is stable and so clients have a name to map that trap onto.
    BadSignature = 7,
    NotExpired = 8,
}

#[contract]
pub struct PoisonKey;

#[contractimpl]
impl PoisonKey {
    /// Register a grant. Moves no value.
    pub fn publish(
        env: Env,
        owner: Address,
        grant_id: BytesN<32>,
        token: Address,
        bond_amount: i128,
        bounty_bps: u32,
        expires_at: u64,
        cipher_ref: String,
    ) -> Result<(), Error> {
        owner.require_auth();

        if bond_amount <= 0 || bounty_bps > BPS_DENOM as u32 {
            return Err(Error::BadParams);
        }

        let gkey = DataKey::Grant(grant_id.clone());
        if env.storage().persistent().has(&gkey) {
            return Err(Error::GrantExists);
        }

        env.storage().persistent().set(
            &gkey,
            &GrantData {
                owner: owner.clone(),
                token,
                bond_amount,
                bounty_bps,
                expires_at,
                cipher_ref,
                bonded: 0,
                burned: 0,
            },
        );

        let lkey = DataKey::HolderList(grant_id.clone());
        env.storage()
            .persistent()
            .set(&lkey, &Vec::<BytesN<32>>::new(&env));

        Self::bump(&env, &gkey);
        Self::bump(&env, &lkey);

        env.events().publish(
            (
                symbol_short!("poisonkey"),
                symbol_short!("published"),
                grant_id,
            ),
            (owner, bond_amount, bounty_bps),
        );
        Ok(())
    }

    /// Post the bond and register the ed25519 public key whose secret half is
    /// both the decryption credential and the slashing key.
    pub fn bond(
        env: Env,
        grant_id: BytesN<32>,
        holder: Address,
        key_pub: BytesN<32>,
    ) -> Result<(), Error> {
        holder.require_auth();

        let gkey = DataKey::Grant(grant_id.clone());
        let mut g: GrantData = env
            .storage()
            .persistent()
            .get(&gkey)
            .ok_or(Error::GrantMissing)?;

        let hkey = DataKey::Holder(grant_id.clone(), key_pub.clone());
        if env.storage().persistent().has(&hkey) {
            return Err(Error::KeyExists);
        }

        token::Client::new(&env, &g.token).transfer(
            &holder,
            &env.current_contract_address(),
            &g.bond_amount,
        );

        env.storage().persistent().set(
            &hkey,
            &HolderData {
                holder: holder.clone(),
                status: STATUS_BONDED,
                bonded_at: env.ledger().timestamp(),
                reporter: None,
            },
        );

        let lkey = DataKey::HolderList(grant_id.clone());
        let mut list: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&lkey)
            .unwrap_or_else(|| Vec::new(&env));
        list.push_back(key_pub.clone());
        env.storage().persistent().set(&lkey, &list);

        g.bonded += 1;
        let bond_amount = g.bond_amount;
        env.storage().persistent().set(&gkey, &g);

        Self::bump(&env, &gkey);
        Self::bump(&env, &hkey);
        Self::bump(&env, &lkey);

        env.events().publish(
            (symbol_short!("poisonkey"), symbol_short!("bonded"), grant_id),
            (holder, key_pub, bond_amount),
        );
        Ok(())
    }

    /// Prove possession of a leaked credential and claim the bounty.
    ///
    /// The claimant signs `grant_id || utf8(claimant address)` — 88 bytes — with
    /// the leaked secret key. Binding the claimant's own address into the message
    /// means a mempool watcher who sees the signature cannot reuse it: the proof
    /// is worthless to anyone but the claimant named inside it.
    ///
    /// Returns the bounty paid.
    pub fn prove_leak(
        env: Env,
        grant_id: BytesN<32>,
        key_pub: BytesN<32>,
        claimant: Address,
        sig: BytesN<64>,
    ) -> Result<i128, Error> {
        claimant.require_auth();

        let gkey = DataKey::Grant(grant_id.clone());
        let mut g: GrantData = env
            .storage()
            .persistent()
            .get(&gkey)
            .ok_or(Error::GrantMissing)?;

        let hkey = DataKey::Holder(grant_id.clone(), key_pub.clone());
        let mut h: HolderData = env
            .storage()
            .persistent()
            .get(&hkey)
            .ok_or(Error::HolderMissing)?;
        if h.status != STATUS_BONDED {
            return Err(Error::WrongStatus);
        }

        // 88-byte proof message: 32-byte grant_id then the claimant's 56-byte
        // strkey address. Must stay byte-identical to the frontend.
        let mut msg = Bytes::from_array(&env, &grant_id.to_array());
        let mut buf = [0u8; ADDR_LEN];
        claimant.to_string().copy_into_slice(&mut buf);
        msg.extend_from_array(&buf);

        // Traps if the signature does not verify under key_pub.
        env.crypto().ed25519_verify(&key_pub, &msg, &sig);

        // Settle atomically. Funds never return to the registered holder on this
        // path, so self-reporting is still a total loss for the leaker.
        let bounty = g.bond_amount * (g.bounty_bps as i128) / BPS_DENOM;
        let remainder = g.bond_amount - bounty;
        let t = token::Client::new(&env, &g.token);
        let me = env.current_contract_address();
        if bounty > 0 {
            t.transfer(&me, &claimant, &bounty);
        }
        if remainder > 0 {
            t.transfer(&me, &g.owner, &remainder);
        }

        let leaker = h.holder.clone();
        h.status = STATUS_BURNED;
        h.reporter = Some(claimant.clone());
        env.storage().persistent().set(&hkey, &h);

        g.burned += 1;
        env.storage().persistent().set(&gkey, &g);

        Self::bump(&env, &gkey);
        Self::bump(&env, &hkey);

        env.events().publish(
            (symbol_short!("poisonkey"), symbol_short!("leak"), grant_id),
            (leaker, claimant, bounty),
        );
        Ok(bounty)
    }

    /// After expiry, a holder whose key was never proven leaked reclaims the bond.
    /// A proof of non-disclosure, settled by the network.
    pub fn release(env: Env, grant_id: BytesN<32>, key_pub: BytesN<32>) -> Result<(), Error> {
        let gkey = DataKey::Grant(grant_id.clone());
        let g: GrantData = env
            .storage()
            .persistent()
            .get(&gkey)
            .ok_or(Error::GrantMissing)?;

        let hkey = DataKey::Holder(grant_id.clone(), key_pub);
        let mut h: HolderData = env
            .storage()
            .persistent()
            .get(&hkey)
            .ok_or(Error::HolderMissing)?;

        h.holder.require_auth();

        if h.status != STATUS_BONDED {
            return Err(Error::WrongStatus);
        }
        if env.ledger().timestamp() < g.expires_at {
            return Err(Error::NotExpired);
        }

        token::Client::new(&env, &g.token).transfer(
            &env.current_contract_address(),
            &h.holder,
            &g.bond_amount,
        );

        let who = h.holder.clone();
        h.status = STATUS_RELEASED;
        env.storage().persistent().set(&hkey, &h);
        Self::bump(&env, &hkey);

        env.events().publish(
            (symbol_short!("poisonkey"), symbol_short!("silent"), grant_id),
            (who, g.bond_amount),
        );
        Ok(())
    }

    pub fn get_grant(env: Env, grant_id: BytesN<32>) -> Result<GrantData, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Grant(grant_id))
            .ok_or(Error::GrantMissing)
    }

    pub fn get_holder(
        env: Env,
        grant_id: BytesN<32>,
        key_pub: BytesN<32>,
    ) -> Result<HolderData, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Holder(grant_id, key_pub))
            .ok_or(Error::HolderMissing)
    }

    /// Every registered key for a grant, paired with its holder record, in the
    /// order the bonds were posted.
    pub fn list_holders(env: Env, grant_id: BytesN<32>) -> Vec<(BytesN<32>, HolderData)> {
        let list: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::HolderList(grant_id.clone()))
            .unwrap_or_else(|| Vec::new(&env));

        let mut out: Vec<(BytesN<32>, HolderData)> = Vec::new(&env);
        for k in list.iter() {
            if let Some(h) = env
                .storage()
                .persistent()
                .get::<DataKey, HolderData>(&DataKey::Holder(grant_id.clone(), k.clone()))
            {
                out.push_back((k, h));
            }
        }
        out
    }

    fn bump(env: &Env, key: &DataKey) {
        env.storage()
            .persistent()
            .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}

mod test;
