// The protected document. In a real deployment the plaintext lives nowhere but
// the holder's machine, decrypted locally with the credential; the grant's
// cipher_ref points at the ciphertext blob. Here the ciphertext is rendered from
// the plaintext so the reveal is visibly the same document.

export const DOC_TITLE_FALLBACK = 'Q3 Board Deck — CONFIDENTIAL';

export const DOC_BODY = `CLASSIFICATION: BOARD-ONLY / DO NOT REDISTRIBUTE
DOC-REF: BD-Q3-114 / REV 4 / 6 PAGES

1. REVENUE
   Q3 net revenue 41.8M, +12.4% QoQ, 3.1M under plan.
   Enterprise ARR 128.4M. Net retention 104%, down from 117%.
   Two of the top ten accounts did not renew at list.

2. RUNWAY
   Cash 96.2M. Burn 8.9M/mo, trending to 10.4M in Q4.
   Runway 9.2 months at current plan. Board action required
   before the November cycle.

3. HEADCOUNT
   Reduction of 140 roles staged for 14 November, weighted to
   GTM and post-sales. Not disclosed to affected staff.
   Severance provision 11.2M booked to Q4.

4. CORPORATE
   Inbound, non-binding, all-cash indication at 1.42B from a
   strategic acquirer. Diligence gated on the Q3 close and on
   resolution of the open matter in section 5.

5. LEGAL
   Two claims outstanding. Counsel estimates aggregate exposure
   of 4.0M to 6.5M, unreserved.

DISTRIBUTION IS BONDED. EACH READER OF THIS DOCUMENT HAS POSTED
COLLATERAL AGAINST THE KEY THAT DECRYPTED IT.`;

const CIPHER_ALPHABET = 'ABCDEF0123456789+/=';

/**
 * A stable stand-in for the ciphertext: same shape and length as the plaintext,
 * no information from it. Deterministic, so it never flickers between renders.
 */
export const DOC_CIPHER = (() => {
  let acc = 0x9e37;
  return DOC_BODY.split('')
    .map((ch) => {
      if (ch === '\n') return ch;
      acc = (acc * 31 + 17) & 0xffff;
      return CIPHER_ALPHABET[acc % CIPHER_ALPHABET.length];
    })
    .join('');
})();
