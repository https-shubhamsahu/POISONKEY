#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token,
    Address, Bytes, BytesN, Env, String, Vec,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Grant(BytesN<32>),
    Holder(BytesN<32>, BytesN<32>),
    HolderList(BytesN<32>),
}

#[contracttype]
#[derive(Clone)]
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
#[derive(Clone)]
pub struct HolderData {
    pub holder: Address,
    pub status: u32, // 0 BONDED, 1 BURNED, 2 RELEASED
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
    NotExpired = 8,
}

const DAY: u32 = 17280;

#[contract]
pub struct PoisonKey;

#[contractimpl]
impl PoisonKey {
    pub fn publish(
        env: Env,
        owner: Address,
        grant_id: BytesN<32>,
        token_addr: Address,
        bond_amount: i128,
        bounty_bps: u32,
        expires_at: u64,
        cipher_ref: String,
    ) -> Result<(), Error> {
        owner.require_auth();
        if bond_amount <= 0 || bounty_bps > 10_000 {
            return Err(Error::BadParams);
        }
        let gkey = DataKey::Grant(grant_id.clone());
        if env.storage().persistent().has(&gkey) {
            return Err(Error::GrantExists);
        }
        let g = GrantData {
            owner: owner.clone(),
            token: token_addr,
            bond_amount,
            bounty_bps,
            expires_at,
            cipher_ref,
            bonded: 0,
            burned: 0,
        };
        env.storage().persistent().set(&gkey, &g);
        let lkey = DataKey::HolderList(grant_id.clone());
        let list: Vec<BytesN<32>> = Vec::new(&env);
        env.storage().persistent().set(&lkey, &list);
        env.storage().persistent().extend_ttl(&gkey, 30 * DAY, 60 * DAY);
        env.storage().persistent().extend_ttl(&lkey, 30 * DAY, 60 * DAY);
        env.events().publish(
            (symbol_short!("poisonkey"), symbol_short!("published"), grant_id),
            (owner, bond_amount, bounty_bps),
        );
        Ok(())
    }

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

        let h = HolderData {
            holder: holder.clone(),
            status: 0,
            bonded_at: env.ledger().timestamp(),
            reporter: None,
        };
        env.storage().persistent().set(&hkey, &h);

        let lkey = DataKey::HolderList(grant_id.clone());
        let mut list: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&lkey)
            .unwrap_or(Vec::new(&env));
        list.push_back(key_pub.clone());
        env.storage().persistent().set(&lkey, &list);

        g.bonded += 1;
        env.storage().persistent().set(&gkey, &g);

        env.storage().persistent().extend_ttl(&hkey, 30 * DAY, 60 * DAY);
        env.storage().persistent().extend_ttl(&lkey, 30 * DAY, 60 * DAY);
        env.storage().persistent().extend_ttl(&gkey, 30 * DAY, 60 * DAY);

        env.events().publish(
            (symbol_short!("poisonkey"), symbol_short!("bonded"), grant_id),
            (holder, key_pub, g.bond_amount),
        );
        Ok(())
    }

    /// Prove possession of a leaked credential and claim the bounty.
    /// The message signed by the leaked key is the raw 32-byte grant_id.
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
        if h.status != 0 {
            return Err(Error::WrongStatus);
        }

        // panics if the signature is not valid under key_pub
        let msg = Bytes::from_array(&env, &grant_id.to_array());
        env.crypto().ed25519_verify(&key_pub, &msg, &sig);

        let bounty = g.bond_amount * (g.bounty_bps as i128) / 10_000;
        let rest = g.bond_amount - bounty;
        let t = token::Client::new(&env, &g.token);
        let me = env.current_contract_address();
        if bounty > 0 {
            t.transfer(&me, &claimant, &bounty);
        }
        if rest > 0 {
            t.transfer(&me, &g.owner, &rest);
        }

        let leaker = h.holder.clone();
        h.status = 1;
        h.reporter = Some(claimant.clone());
        env.storage().persistent().set(&hkey, &h);

        g.burned += 1;
        env.storage().persistent().set(&gkey, &g);

        env.events().publish(
            (symbol_short!("poisonkey"), symbol_short!("leak"), grant_id),
            (leaker, claimant, bounty),
        );
        Ok(bounty)
    }

    pub fn release(
        env: Env,
        grant_id: BytesN<32>,
        key_pub: BytesN<32>,
    ) -> Result<(), Error> {
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
        if h.status != 0 {
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
        h.status = 2;
        env.storage().persistent().set(&hkey, &h);
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

    pub fn list_holders(env: Env, grant_id: BytesN<32>) -> Vec<(BytesN<32>, HolderData)> {
        let list: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::HolderList(grant_id.clone()))
            .unwrap_or(Vec::new(&env));
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
}