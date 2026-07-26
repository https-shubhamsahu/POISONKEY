# ☠️ POISONKEY

### Credentials that punish their own leak.

POISONKEY is an experimental access-control primitive built on **Stellar + Soroban** where users bond value behind access credentials.

The twist:

> **The credential that grants access is also the cryptographic evidence that can slash the holder's bond if that credential leaks.**

Instead of trying to make credentials impossible to copy, POISONKEY makes credential redistribution economically self-destructive.

Built at **Build On Stellar Build Station, Mumbai**.

---

## The Problem

Once someone receives a digital credential, preventing them from sharing it is difficult.

This affects:

- API keys
- premium or licensed access
- embargoed content
- paid datasets
- internal tools
- temporary privileged access
- AI-agent credentials

Traditional systems rely on access controls, DRM, audit logs, watermarking, contracts, or legal enforcement.

POISONKEY explores a different question:

> **What if leaking the credential itself created an immediate financial consequence?**

---

## How POISONKEY Works

A resource owner creates a protected grant.

Before receiving access, a reader locks a bond in a Soroban smart contract and registers a unique Ed25519 public key.

The corresponding secret key becomes their access credential.

```text
OWNER
  │
  │ publishes protected grant
  ▼
POISONKEY
  │
  │ requires bond
  ▼
READER
  │
  │ bonds 50 XLM
  ▼
🔑 receives access credential
```

As long as the reader keeps that credential private, nothing happens.

If the credential leaks, anyone who obtains it can cryptographically prove possession.

```text
LEAKED CREDENTIAL
       │
       ▼
Reporter signs a claim
       │
       ▼
Soroban verifies signature
       │
       ▼
   Valid proof
       │
       ▼
 Reader bond slashed
      ↙     ↘
  bounty    owner
```

The contract handles verification and settlement according to predefined rules.

No manual leak adjudication is required for the credential-possession condition.

---

## The Core Insight

Most security systems try to make credentials harder to leak.

POISONKEY instead changes their economics.

A credential becomes both:

```text
ACCESS CAPABILITY
       +
FINANCIAL LIABILITY
```

The reader has something valuable to protect because leaking the credential can expose their bond to a bounty claim.

In other words:

> **The key that gives you access is the key you don't want anyone else to have. For more than one reason.**

---

## Example

Bob wants access to a protected resource.

He bonds:

**50 XLM**

The contract registers Bob's credential.

If Bob protects it until the grant expires, his bond can be released.

If Bob leaks the credential and Alice discovers it, Alice can prove possession.

With a 50% bounty:

```text
Bob's bond
50 XLM
   │
   ▼
  SLASH
  ↙   ↘
25     25
XLM    XLM
 │      │
 ▼      ▼
Alice  Owner
```

Bob loses the bond.

Alice is rewarded for reporting the exposed credential.

The owner receives the remainder.

---

## Privacy-Preserving Leak Proof

A reporter should not need to publish the leaked secret key on-chain.

Instead, POISONKEY uses a cryptographic challenge.

The reporter signs a message using the leaked Ed25519 credential:

```text
grant_id || claimant_address
              │
              ▼
       sign with leaked key
              │
              ▼
           signature
```

The Soroban contract verifies that signature against the public key registered by the bonded reader.

Conceptually:

```text
public key
    +
claim message
    +
signature
    │
    ▼
Ed25519 verification
    │
    ▼
VALID / INVALID
```

A valid signature proves possession of the corresponding credential without requiring the reporter to submit the secret key itself.

The claim is bound to the claimant's address so the proof cannot simply be copied to redirect the bounty to another account.

---

## Why Stellar?

POISONKEY needs more than a database that records whether a credential leaked.

The enforcement layer controls money.

In a traditional implementation:

```text
Platform holds deposit
        ↓
Platform evaluates claim
        ↓
Platform decides whether to slash
        ↓
Platform pays reporter
```

Both the reader and reporter must trust the platform.

POISONKEY moves those rules into a **Soroban smart contract**.

```text
Reader
   │
   ▼
Bond
   │
   ▼
SOROBAN CONTRACT
   │
   ├── verifies proof
   ├── tracks grant state
   ├── controls bonded value
   └── settles payouts
```

The slashing condition can therefore be inspected before a reader participates.

Stellar also makes small bonds and bounty settlements practical because the mechanism depends on inexpensive transactions.

### Stellar primitives used

- **Soroban smart contracts**
- **Ed25519 signature verification**
- **Stellar assets / XLM**
- **Contract-controlled bonds**
- **Wallet authorization**
- **Atomic settlement**
- **Contract events**
- **Stellar Testnet**

Stellar isn't being used to store the protected content.

It provides the **trust-minimized economic enforcement layer**.

---

## Smart Contract

The MVP revolves around four operations:

```rust
publish(...)
bond(...)
prove_leak(...)
release(...)
```

### `publish`

Creates a protected grant containing information such as:

- owner
- token
- bond amount
- bounty percentage
- expiry
- resource reference

### `bond`

A reader registers an Ed25519 public key and transfers the required bond into the contract.

### `prove_leak`

The critical operation.

A claimant provides a signature proving possession of a bonded credential.

If valid, the contract:

1. marks the credential as burned
2. calculates the bounty
3. transfers the bounty to the claimant
4. transfers the remainder to the owner
5. records the state transition

### `release`

After expiry, an eligible reader whose credential was not burned can reclaim the bond.

---

## Architecture

```text
┌─────────────────────┐
│      Web Client     │
│                     │
│ Credential handling │
│ Wallet interaction  │
└──────────┬──────────┘
           │
           │ transaction
           ▼
┌─────────────────────┐
│       Stellar       │
│                     │
│  Soroban Contract   │
│                     │
│ • Grants            │
│ • Bonds             │
│ • Public keys       │
│ • Proof verification│
│ • Slashing          │
│ • Settlement        │
└──────────┬──────────┘
           │
           ▼
     Stellar Testnet
```

The protected resource itself can remain off-chain.

Stellar handles the state and economic enforcement.

---

## Demo Flow

The prototype demonstrates the full attack path:

```text
1. Owner publishes grant

2. Bob bonds 50 XLM

3. Bob receives/registers credential

4. Credential is exposed

5. Alice obtains the credential

6. Alice signs a claim

7. Soroban verifies possession

8. Bob's bond is slashed

9. Alice receives bounty

10. Contract records BURNED state
```

The important moment:

```text
BOB
50 XLM bond
     ↓

credential leaks

     ↓

ALICE
proves possession
     ↓

SOROBAN
✓ signature valid
     ↓

BOB
0 XLM bonded

ALICE
+25 XLM bounty
```

No administrator presses an "approve punishment" button.

The contract executes the predefined rule.

---

## Threat Model

POISONKEY does **not** make digital information impossible to copy.

It does not prevent:

- screenshots
- photographing a screen
- manually rewriting information
- redistribution of plaintext after legitimate access

POISONKEY specifically explores **economic accountability for credential redistribution**.

That distinction is important.

The useful target is a credential whose possession itself grants something valuable, such as an API key, access token, paid capability, temporary authorization, or protected service access.

---

## Tech Stack

**Blockchain**

- Stellar
- Soroban
- Rust

**Frontend**

- React
- TypeScript
- Stellar wallet integration

**Cryptography**

- Ed25519
- signed possession proofs

**Network**

- Stellar Testnet

---

## Potential Applications

POISONKEY is a primitive rather than a document-sharing application.

The same mechanism could potentially protect:

**API credentials**

Developers or contractors bond against temporary API access.

**AI agent capabilities**

Agents receive bonded credentials for tools, APIs, or paid resources.

**Paid datasets**

Authorized consumers bond against redistribution of access credentials.

**Embargoed access**

Reviewers receive time-limited bonded credentials.

**Enterprise privileged access**

Temporary sensitive capabilities carry economic accountability.

---

## Future Work

The hackathon prototype focuses on proving the core mechanism.

Future iterations could explore:

- configurable bond policies
- multiple assets
- reputation tied to successful bond completion
- rotating credentials
- organization-level grants
- threshold or multi-party access
- encrypted resource delivery
- credential expiry
- automated credential revocation
- analytics around burned credentials
- integrations with API gateways and developer platforms

---

## Built With Stellar

POISONKEY started with a simple question:

> **What if we stopped trying to make credentials impossible to leak and made leaking them irrational instead?**

Stellar provides the programmable financial layer that turns that idea into an enforceable protocol.

**Access becomes bonded.**

**Leaks become provable.**

**Consequences become programmable.**

☠️ **POISONKEY**
