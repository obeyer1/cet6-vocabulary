#!/usr/bin/env python3
"""Parse the raw CET-6 word list into data/words.json.

Raw format per line:
    word [phonetic] pos. Chinese meanings
Some lines lack the phonetic bracket; some have extra parenthetical notes.
"""
import json
import re
import unicodedata
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
RAW = BASE / "data" / "CET6_edited_raw.txt"
OUT = BASE / "data" / "words.json"

PHON = re.compile(r"\[([^\]]*)\]")
IPA_CHAR = re.compile(r"[\u02c8\u02cc\u0259\u00e6\u0251\u0254\u026a\u028a\u025c\u02d0\u0252\u03b8\u00f0\u014b\u0283\u0292\u028c\u025b\u026a]")


def normalize_phonetic(p: str) -> str:
    # Fix common mojibake / variant IPA characters.
    p = p.replace("\u04d9", "\u0259")  # ә (Cyrillic schwa) -> ə
    p = p.replace("\uff1a", ":")        # fullwidth colon
    p = p.replace("\uff08", "(").replace("\uff09", ")")
    # Collapse whitespace
    p = " ".join(p.split())
    return p


def parse_line(line: str):
    line = line.strip()
    if not line:
        return None
    m = PHON.search(line)
    if m:
        word = line[: m.start()].strip().split()[0] if line[: m.start()].strip() else ""
        phonetic = m.group(1).strip()
        meaning = line[m.end():].strip()
    else:
        # No bracket: the word is the first token; the phonetic is the first
        # token containing IPA characters (it may sit before or after a '/').
        word, phonetic, meaning = line.split(None, 1)[0], "", ""
        rest = line.split(None, 1)[1] if " " in line else ""
        for j, tok in enumerate(rest.split()):
            if IPA_CHAR.search(tok):
                phonetic = tok.lstrip("/").strip()
                meaning = " ".join(rest.split()[j + 1:]).lstrip("/").strip()
                break
        else:
            meaning = rest
    # Drop stray leading brackets like "]" if any
    meaning = meaning.strip()
    if not word:
        return None
    return {"word": word, "phonetic": normalize_phonetic(phonetic), "meaning": meaning}


def main():
    words, seen = [], set()
    skipped = []
    for i, line in enumerate(RAW.read_text(encoding="utf-8").splitlines(), 1):
        e = parse_line(line)
        if e is None:
            skipped.append((i, "empty"))
            continue
        key = e["word"].lower()
        if key in seen:
            skipped.append((i, f"dup:{key}"))
            continue
        seen.add(key)
        words.append(e)

    # Sanity checks
    no_meaning = [w for w in words if not w["meaning"]]
    no_phon = [w for w in words if not w["phonetic"]]
    print(f"parsed words: {len(words)}")
    print(f"skipped lines: {len(skipped)} ({len([s for s in skipped if s[1]=='empty'])} empty, {len([s for s in skipped if 'dup' in s[1]])} dup)")
    print(f"entries without meaning: {len(no_meaning)}")
    print(f"entries without phonetic: {len(no_phon)}")

    OUT.write_text(json.dumps(words, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
