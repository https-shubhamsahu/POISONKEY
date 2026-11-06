#!/usr/bin/env python3
"""Build the README SVGs in assets/readme/.

    python3 scripts/build_readme_assets.py

Standard library only. Colours are the tokens in web/src/styles.css (the board's
--bg, --panel, --accent and --danger), and the board rows copy the app's .row,
.pill and .bar. BOB and CARA, their addresses and the demo grant id come from
deploy/testnet.json; their key_pub values are the ed25519 keys that
web/src/seed.ts derives from the credential seeds 0x11 and 0x22. ALICE and
MALLORY are drawn as well-formed strkeys so the 88-byte message is shown at its
real length.
"""
import base64
import math
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "readme"

BG, PANEL, PANEL2 = "#08090a", "#0c0e0f", "#101314"
LINE, LINE2, TRACK = "#1b2022", "#262c2e", "#121616"
TEXT, BRIGHT, DIM, DIMMER = "#ccd2cf", "#eef2ef", "#8f9894", "#6f7874"
ACCENT, ACCENT_DEEP, ACCENT_BG = "#b6ff3c", "#3d5a19", "#131a08"
DANGER, DANGER_DEEP, DANGER_BG = "#ff3b3b", "#5a1919", "#1a0808"
SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"

GRANT_HEX = "d570e53b9da08fb6112b9ee94fa4503e5ff71e43da2fbcd961f399df891b6c4c"
BOB = ("BOB", "GCEGQ72V3RLSOQMXBKEX26W5Y3NJRCYDVPDH6PS4P2GIG4WFYN6734DO",
       "d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737")
CARA = ("CARA", "GAS272JXFFQEMLMKGR7IYZOQLM7CIOKS46T6A3OWP2EQDYR534WNDI2G",
        "a09aa5f47a6759802ff955f8dc2d2a14a5c99d23be97f864127ff9383455a4f0")
# BOB's ACCESS CREDENTIAL as the app shows it: base64(seed || public key), seed = 32 x 0x11.
BOB_CREDENTIAL = base64.b64encode(bytes([0x11]) * 32 + bytes.fromhex(BOB[2])).decode()


def crc16_xmodem(data: bytes) -> int:
    crc = 0
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if crc & 0x8000 else crc << 1
            crc &= 0xFFFF
    return crc


def strkey(pub: bytes) -> str:
    payload = bytes([6 << 3]) + pub
    return base64.b32encode(payload + crc16_xmodem(payload).to_bytes(2, "little")).decode()


ALICE = strkey(bytes(range(0xA0, 0xC0)))
MALLORY = strkey(bytes(range(0x40, 0x60)))
assert len(ALICE) == len(MALLORY) == 56


def short(addr: str) -> str:
    return f"{addr[:4]}…{addr[-4:]}"


def t(x, y, s, size=20, fill=TEXT, family=MONO, weight=400, anchor="start", extra=""):
    return (f'<text x="{x}" y="{y}" font-family="{family}" font-size="{size}" font-weight="{weight}" '
            f'fill="{fill}" text-anchor="{anchor}"{extra}>{escape(s)}</text>')


def svg(w, h, title, desc, body, style=""):
    style_block = f"<style>{style}</style>" if style else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" '
            f'role="img" aria-labelledby="title desc">\n<title id="title">{escape(title)}</title>\n'
            f'<desc id="desc">{escape(desc)}</desc>\n{style_block}\n'
            f'<rect x="1" y="1" width="{w - 2}" height="{h - 2}" rx="22" fill="{BG}" stroke="{LINE2}" stroke-width="2"/>\n'
            f'{body}\n</svg>\n')


def pill(x, y, label, kind, cls=""):
    stroke, fill, ink = {"bonded": (ACCENT_DEEP, ACCENT_BG, ACCENT),
                         "burned": (DANGER_DEEP, DANGER_BG, DANGER),
                         "released": (LINE2, PANEL2, DIM)}[kind]
    w = 22 + 13 * len(label)
    c = f' class="{cls}"' if cls else ""
    return (f'<g{c}><rect x="{x}" y="{y}" width="{w}" height="30" rx="3" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>'
            + t(x + w / 2, y + 21, label, 18, ink, anchor="middle", extra=' letter-spacing="2"') + "</g>")


# ----------------------------------------------------------------------------- hero

def hero():
    W, H = 1200, 520
    # One 8 s loop. Base styles are the settled, slashed board, so the reduced-motion
    # still and any renderer that skips animation show the outcome.
    style = f"""
.a{{animation-duration:8s;animation-iteration-count:infinite;animation-timing-function:cubic-bezier(.25,.7,.3,1)}}
.before{{animation-name:before;opacity:0}}
.after{{animation-name:after}}
.chip{{animation-name:chip;opacity:0}}
.field-before{{animation-name:fieldBefore;opacity:0}}
.field-after{{animation-name:fieldAfter}}
.verify{{animation-name:verify}}
.payout{{animation-name:payout}}
.drain{{animation-name:drain;transform-box:fill-box;transform-origin:left center;transform:scaleX(0)}}
@keyframes before{{0%,36%{{opacity:1}}40%,94%{{opacity:0}}100%{{opacity:1}}}}
@keyframes after{{0%,40%{{opacity:0}}44%,88%{{opacity:1}}94%,100%{{opacity:0}}}}
@keyframes chip{{0%,9%{{opacity:0;transform:translate(0,0)}}12%{{opacity:1;transform:translate(0,0)}}18%{{opacity:1;transform:translate(-70px,96px)}}24%{{opacity:1;transform:translate(-150px,204px)}}28%,100%{{opacity:0;transform:translate(-150px,204px)}}}}
@keyframes fieldBefore{{0%,22%{{opacity:1}}26%,93%{{opacity:0}}100%{{opacity:1}}}}
@keyframes fieldAfter{{0%,22%{{opacity:0}}26%,88%{{opacity:1}}94%,100%{{opacity:0}}}}
@keyframes verify{{0%,28%{{opacity:0}}34%,88%{{opacity:1}}94%,100%{{opacity:0}}}}
@keyframes payout{{0%,48%{{opacity:0;transform:translate(0,10px)}}56%,88%{{opacity:1;transform:translate(0,0)}}94%,100%{{opacity:0;transform:translate(0,0)}}}}
@keyframes drain{{0%,34%{{transform:scaleX(1);fill:{ACCENT};opacity:1}}48%,92%{{transform:scaleX(0);fill:{DANGER};opacity:1}}93%{{transform:scaleX(0);fill:{DANGER};opacity:0}}94%{{transform:scaleX(1);fill:{ACCENT};opacity:0}}100%{{transform:scaleX(1);fill:{ACCENT};opacity:1}}}}
@media (prefers-reduced-motion: reduce){{*{{animation:none !important}}}}
"""
    b = []
    # title block, left
    b.append(t(60, 112, "POISONKEY", 58, ACCENT, weight=700, extra=' letter-spacing="6"'))
    b.append(t(60, 172, "Credentials that punish", 34, BRIGHT, SANS, 600))
    b.append(t(60, 214, "their own leak.", 34, BRIGHT, SANS, 600))
    for i, line in enumerate(["BOB bonds 50 XLM and gets an ed25519",
                              "key that opens the document. If that",
                              "key leaks, whoever holds it can sign",
                              "a claim, and the contract pays them",
                              "half of BOB's bond."]):
        b.append(t(60, 270 + i * 31, line, 21, "#aab3af", SANS))
    b.append(t(60, 456, "Soroban contract on Stellar Testnet", 18, DIM))
    b.append(t(60, 482, "9 contract tests · 88-byte leak proof", 18, DIM))

    # board, right
    bx, by, bw, bh = 556, 36, 596, 448
    b.append(f'<rect x="{bx}" y="{by}" width="{bw}" height="{bh}" rx="10" fill="{PANEL}" stroke="{LINE}" stroke-width="1.5"/>')
    b.append(t(580, 68, "BONDED READERS", 18, DIM, extra=' letter-spacing="2"'))
    b.append(t(1128, 68, f"grant {GRANT_HEX[:8]}…", 18, DIMMER, anchor="end"))
    b.append(f'<line x1="{bx}" y1="84" x2="{bx + bw}" y2="84" stroke="{LINE}" stroke-width="1.5"/>')

    def row(y, who, live):
        name, addr, key = who
        out = [f'<rect x="568" y="{y}" width="572" height="98" fill="{PANEL2}"/>']
        if live:
            out.append(f'<rect x="568" y="{y}" width="4" height="98" fill="{ACCENT}"/>')
        else:
            out.append(f'<rect class="a after" x="568" y="{y}" width="4" height="98" fill="{DANGER}"/>')
            out.append(f'<rect class="a before" x="568" y="{y}" width="4" height="98" fill="{ACCENT}"/>')
        out.append(t(588, y + 30, name, 22, TEXT, weight=700, extra=' letter-spacing="1.5"'))
        out.append(t(588 + 16 * len(name) + 18, y + 30, short(addr), 18, DIM))
        if live:
            out.append(pill(1006, y + 10, "BONDED", "bonded"))
        else:
            out.append(pill(1006, y + 10, "BURNED", "burned", "a after"))
            out.append(pill(1006, y + 10, "BONDED", "bonded", "a before"))
        out.append(f'<rect x="588" y="{y + 46}" width="536" height="10" fill="{TRACK}" stroke="{LINE}"/>')
        if live:
            out.append(f'<rect x="588" y="{y + 46}" width="536" height="10" fill="{ACCENT}"/>')
        else:
            out.append(f'<rect class="a drain" x="588" y="{y + 46}" width="536" height="10" fill="{DANGER}"/>')
        out.append(t(588, y + 84, f"key {key[:4]}…{key[-4:]}", 18, DIM))
        if live:
            out.append(t(1124, y + 84, "50 XLM at risk", 18, DIM, anchor="end"))
        else:
            out.append(t(1124, y + 84, "slashed · bounty to ALICE", 18, DANGER, anchor="end", extra=' class="a after"'))
            out.append(t(1124, y + 84, "50 XLM at risk", 18, DIM, anchor="end", extra=' class="a before"'))
        return out

    b += row(94, BOB, live=False)
    b += row(200, CARA, live=True)

    # leak hunter
    b.append(f'<line x1="{bx}" y1="316" x2="{bx + bw}" y2="316" stroke="{LINE}" stroke-width="1.5"/>')
    b.append(t(580, 346, "LEAK HUNTER", 18, DIM, extra=' letter-spacing="2"'))
    b.append(t(1128, 346, "signed by ALICE", 18, DIMMER, anchor="end"))
    b.append(f'<rect x="580" y="362" width="544" height="40" rx="3" fill="{BG}" stroke="{LINE2}" stroke-width="1.5"/>')
    b.append(t(596, 389, "paste a leaked ACCESS CREDENTIAL", 18, DIMMER, extra=' class="a field-before"'))
    b.append(t(596, 389, BOB_CREDENTIAL[:43] + "…", 18, DANGER, extra=' class="a field-after"'))
    b.append(f'<g class="a verify">{t(580, 436, "sig over grant_id || ALICE", 18, DIM)}'
             f'{t(1124, 436, "ed25519_verify ✓", 18, ACCENT, anchor="end")}</g>')
    b.append(f'<g class="a payout">{t(580, 470, "+25 XLM → ALICE", 20, ACCENT, weight=700)}'
             f'{t(1124, 470, "+25 XLM → owner", 20, TEXT, weight=700, anchor="end")}</g>')

    # the leaked copy of BOB's secret, travelling from his row into the hunter field
    b.append(f'<g class="a chip"><rect x="738" y="160" width="232" height="30" rx="15" fill="{DANGER_BG}" '
             f'stroke="{DANGER}" stroke-width="1.5"/>{t(754, 181, "secret " + BOB_CREDENTIAL[:8] + chr(0x2026), 18, DANGER)}</g>')

    desc = ("An animated board from the POISONKEY app. BOB and CARA each have 50 XLM bonded. "
            "A copy of BOB's secret key leaks into the leak hunter field; ALICE signs grant_id || her address with it, "
            "ed25519_verify passes, BOB's bond bar drains to zero and his status flips from BONDED to BURNED, "
            "then 25 XLM goes to ALICE and 25 XLM to the owner. CARA stays bonded.")
    return svg(W, H, "POISONKEY: credentials that punish their own leak", desc, "\n".join(b), style)


# ----------------------------------------------------------------------------- proof message

def proof_message():
    W, H = 1200, 476
    x0, x1 = 64, 1136
    per = (x1 - x0) / 88
    xs = x0 + 32 * per
    b = []
    b.append(t(64, 62, "What ALICE signs with BOB's leaked key: 88 bytes, built the same way in Rust and TypeScript", 20, TEXT, SANS))
    # the strip
    b.append(f'<rect x="{x0}" y="84" width="{xs - x0:.1f}" height="84" fill="{PANEL2}" stroke="{LINE2}" stroke-width="1.5"/>')
    b.append(f'<rect x="{xs:.1f}" y="84" width="{x1 - xs:.1f}" height="84" fill="{ACCENT_BG}" stroke="{ACCENT_DEEP}" stroke-width="1.5"/>')
    b.append(t(x0 + 16, 116, "grant_id, 32 raw bytes", 20, TEXT, weight=700))
    b.append(t(x0 + 16, 150, f"{GRANT_HEX[:8]} {GRANT_HEX[8:16]} … {GRANT_HEX[-8:]}", 18, DIM))
    b.append(t(xs + 16, 116, "claimant address, 56 ASCII bytes", 20, ACCENT, weight=700))
    b.append(t(xs + 16, 150, ALICE, 18, TEXT))
    # byte ruler
    ticks = []
    for i in range(89):
        x = x0 + i * per
        tall = i in (0, 32, 88)
        ticks.append(f'<line x1="{x:.1f}" y1="168" x2="{x:.1f}" y2="{186 if tall else 174}" '
                     f'stroke="{DIM if tall else LINE2}" stroke-width="{2 if tall else 1}"/>')
    b.append("".join(ticks))
    b.append(t(x0, 208, "0", 18, DIM, anchor="start"))
    b.append(t(xs, 208, "32", 18, DIM, anchor="middle"))
    b.append(t(x1, 208, "88", 18, DIM, anchor="end"))

    # signing step
    b.append(f'<rect x="64" y="234" width="1072" height="48" rx="6" fill="{PANEL}" stroke="{LINE}" stroke-width="1.5"/>')
    b.append(t(84, 265, "ed25519 sign with BOB's leaked secret", 20, TEXT))
    b.append(t(552, 265, "→", 20, DIM))
    b.append(t(590, 265, "sig, 64 bytes", 20, DANGER, weight=700))
    b.append(t(1116, 265, "the secret never goes on chain", 20, DIM, SANS, anchor="end"))

    # two outcomes
    def lane(x, ok, lines):
        stroke = ACCENT_DEEP if ok else DANGER_DEEP
        ink = ACCENT if ok else DANGER
        out = [f'<rect x="{x}" y="302" width="524" height="146" rx="8" fill="{PANEL}" stroke="{stroke}" stroke-width="1.5"/>',
               f'<rect x="{x}" y="302" width="4" height="146" fill="{ink}"/>']
        out.append(t(x + 24, 340, lines[0], 20, ink, weight=700))
        for i, line in enumerate(lines[1:]):
            out.append(t(x + 24, 374 + i * 30, line, 20, TEXT if i < 2 else ink, SANS))
        return out

    b += lane(64, True, ["prove_leak(claimant = ALICE)",
                         "Contract rebuilds grant_id || ALICE.",
                         "Bytes match what the key signed.",
                         "Verified: 25 XLM to ALICE, 25 to owner."])
    b += lane(612, False, ["prove_leak(claimant = MALLORY)",
                           "Same sig, copied from the mempool.",
                           "Bytes 32..88 now spell MALLORY.",
                           "Verify traps: nothing moves."])
    desc = ("The 88-byte proof message. Bytes 0 to 32 hold the raw grant_id, bytes 32 to 88 hold the claimant's "
            "56-character Stellar address. ALICE signs it with BOB's leaked secret and calls prove_leak: the contract "
            "rebuilds the same bytes and the signature verifies, paying 25 XLM to ALICE and 25 XLM to the owner. "
            "MALLORY copies the same signature and names herself as claimant: bytes 32 to 88 change, verification traps "
            "and nothing moves.")
    return svg(W, H, "The 88-byte leak proof binds the claimant", desc, "\n".join(b))


# ----------------------------------------------------------------------------- lifecycle

def lifecycle():
    W, H = 1200, 470
    b = []

    def box(x, y, w, h, stroke=LINE2, fill=PANEL):
        return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>'

    def arrow(x1, y1, x2, y2, color=DIM, curve=None):
        if curve:
            d = f"M{x1} {y1} C{curve[0]} {curve[1]} {curve[2]} {curve[3]} {x2} {y2}"
        else:
            d = f"M{x1} {y1} L{x2} {y2}"
        return (f'<path d="{d}" fill="none" stroke="{color}" stroke-width="2"/>'
                + arrowhead(x2, y2, color, curve))

    def arrowhead(x, y, color, curve):
        dx, dy = (x - curve[2], y - curve[3]) if curve else (1, 0)
        a = math.atan2(dy, dx)
        p1 = (x - 12 * math.cos(a) + 6 * math.sin(a), y - 12 * math.sin(a) - 6 * math.cos(a))
        p2 = (x - 12 * math.cos(a) - 6 * math.sin(a), y - 12 * math.sin(a) + 6 * math.cos(a))
        return f'<path d="M{x} {y} L{p1[0]:.1f} {p1[1]:.1f} L{p2[0]:.1f} {p2[1]:.1f} Z" fill="{color}"/>'

    # publish
    b.append(box(48, 150, 236, 150))
    b.append(t(68, 186, "publish", 22, BRIGHT, weight=700))
    b.append(t(68, 216, "owner signs", 18, DIM, SANS))
    b.append(t(68, 248, "demo: 50 XLM bond", 20, TEXT, SANS))
    b.append(t(68, 278, "50% bounty, 7 days", 20, TEXT, SANS))
    b.append(arrow(284, 225, 318, 225))

    # bond
    b.append(box(320, 150, 250, 150))
    b.append(t(340, 186, "bond", 22, BRIGHT, weight=700))
    b.append(t(340, 216, "reader signs", 18, DIM, SANS))
    b.append(t(340, 248, "50 XLM into contract", 20, TEXT, SANS))
    b.append(t(340, 278, "key_pub registered", 20, TEXT, SANS))
    b.append(arrow(570, 225, 604, 225))

    # BONDED state
    b.append(box(606, 178, 176, 94, ACCENT_DEEP, ACCENT_BG))
    b.append(t(694, 220, "BONDED", 24, ACCENT, weight=700, anchor="middle", extra=' letter-spacing="2"'))
    b.append(t(694, 252, "status 0", 18, DIM, anchor="middle"))

    # branches
    b.append(arrow(782, 206, 878, 112, DANGER, curve=(830, 206, 836, 112)))
    b.append(arrow(782, 244, 878, 338, DIM, curve=(830, 244, 836, 338)))

    # BURNED
    b.append(box(880, 36, 272, 160, DANGER_DEEP))
    b.append(f'<rect x="880" y="36" width="4" height="160" fill="{DANGER}"/>')
    b.append(t(904, 72, "prove_leak", 22, BRIGHT, weight=700))
    b.append(t(904, 100, "anyone with the secret", 18, DIM, SANS))
    b.append(pill(904, 114, "BURNED · 1", "burned"))
    b.append(t(904, 174, "25 XLM claimant, 25 owner", 18, TEXT, SANS))

    # RELEASED
    b.append(box(880, 254, 272, 160))
    b.append(f'<rect x="880" y="254" width="4" height="160" fill="{DIM}"/>')
    b.append(t(904, 290, "release", 22, BRIGHT, weight=700))
    b.append(t(904, 318, "reader, after expires_at", 18, DIM, SANS))
    b.append(pill(904, 332, "RELEASED · 2", "released"))
    b.append(t(904, 392, "full 50 XLM back to reader", 18, TEXT, SANS))

    b.append(t(48, 436, "BURNED and RELEASED are final: a second prove_leak or release on that key fails with WrongStatus.", 20, DIM, SANS))
    desc = ("Lifecycle of one POISONKEY credential. The owner calls publish with a 50 XLM bond, a 50 percent bounty "
            "and a 7 day expiry. A reader calls bond, moving 50 XLM into the contract and registering an ed25519 "
            "public key, which puts the key in BONDED, status 0. From there prove_leak by anyone holding the secret "
            "moves it to BURNED, status 1, paying 25 XLM to the claimant and 25 XLM to the owner, or release by the "
            "reader after expires_at moves it to RELEASED, status 2, returning the full 50 XLM. Both end states are final.")
    return svg(W, H, "POISONKEY credential lifecycle", desc, "\n".join(b))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, build in (("hero.svg", hero), ("proof-message.svg", proof_message), ("lifecycle.svg", lifecycle)):
        (OUT / name).write_text(build(), encoding="utf-8")
        print("wrote", (OUT / name).relative_to(ROOT))


if __name__ == "__main__":
    main()
