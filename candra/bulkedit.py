"""Bulk Editor (edit masal): operasi teks deterministik untuk judul/deskripsi.
Semua operasi murni (tanpa regex dari pengguna -> tidak ada risiko ReDoS) dan selalu bisa di-preview sebelum diterapkan."""
from __future__ import annotations

import re

FIELDS = ("title", "description", "both")
TYPES = ("find_replace", "prefix", "suffix", "case", "collapse_spaces", "remove_emoji", "truncate", "remove_text")
CASE_MODES = ("title", "upper", "lower", "sentence")
MAX_OPS = 10
MAX_TEXT = 500

_EMOJI = re.compile("[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U00002B00-\U00002BFF️‍⃣]+")


class BulkEditError(ValueError):
    pass


def validate_ops(ops) -> list[dict]:
    if not isinstance(ops, list) or not ops:
        raise BulkEditError("pilih minimal satu operasi")
    if len(ops) > MAX_OPS:
        raise BulkEditError(f"maksimal {MAX_OPS} operasi sekali jalan")
    out = []
    for i, op in enumerate(ops, 1):
        if not isinstance(op, dict):
            raise BulkEditError(f"operasi #{i} tidak valid")
        t, f = op.get("type"), op.get("field", "both")
        if t not in TYPES:
            raise BulkEditError(f"operasi #{i}: type harus salah satu dari {TYPES}")
        if f not in FIELDS:
            raise BulkEditError(f"operasi #{i}: field harus salah satu dari {FIELDS}")
        clean = {"type": t, "field": f}
        for k in ("find", "replace", "text"):
            v = op.get(k, "")
            if not isinstance(v, str) or len(v) > MAX_TEXT:
                raise BulkEditError(f"operasi #{i}: {k} harus teks <= {MAX_TEXT} karakter")
            clean[k] = v
        if t in ("find_replace", "remove_text") and not clean["find"]:
            raise BulkEditError(f"operasi #{i}: teks yang dicari wajib diisi")
        if t in ("prefix", "suffix") and not clean["text"].strip():
            raise BulkEditError(f"operasi #{i}: teks tambahan wajib diisi")
        if t == "case":
            if op.get("mode") not in CASE_MODES:
                raise BulkEditError(f"operasi #{i}: mode harus salah satu dari {CASE_MODES}")
            clean["mode"] = op["mode"]
        if t == "truncate":
            try:
                n = int(op.get("max_len"))
            except (TypeError, ValueError):
                raise BulkEditError(f"operasi #{i}: max_len harus angka")
            if not 10 <= n <= 20000:
                raise BulkEditError(f"operasi #{i}: max_len harus 10..20000")
            clean["max_len"] = n
        clean["case_sensitive"] = bool(op.get("case_sensitive", False))
        clean["whole_word"] = bool(op.get("whole_word", False))
        out.append(clean)
    return out


def _pattern(find: str, case_sensitive: bool, whole_word: bool):
    core = re.escape(find)
    if whole_word:
        core = rf"(?<!\w){core}(?!\w)"
    return re.compile(core, 0 if case_sensitive else re.IGNORECASE)


def _title_case(s: str) -> str:
    return re.sub(r"\S+", lambda m: m.group(0)[:1].upper() + m.group(0)[1:].lower(), s)


def _sentence_case(s: str) -> str:
    return re.sub(r"(^|[.!?]\s+|\n)(\S)", lambda m: m.group(1) + m.group(2).upper(), s.lower())


def _truncate(s: str, n: int) -> str:
    if len(s) <= n:
        return s
    cut = s[:n]
    sp = cut.rfind(" ")
    return (cut[:sp] if sp >= n * 0.6 else cut).rstrip(" -,|.")


def apply_op(text: str, op: dict) -> str:
    t = op["type"]
    if t == "find_replace":
        return _pattern(op["find"], op["case_sensitive"], op["whole_word"]).sub(lambda m: op["replace"], text)
    if t == "remove_text":
        return re.sub(r"[ \t]{2,}", " ", _pattern(op["find"], op["case_sensitive"], op["whole_word"]).sub("", text)).strip()
    if t == "prefix":
        return f"{op['text'].strip()} {text}".strip()
    if t == "suffix":
        return f"{text} {op['text'].strip()}".strip()
    if t == "case":
        return {"title": _title_case, "upper": str.upper, "lower": str.lower, "sentence": _sentence_case}[op["mode"]](text)
    if t == "collapse_spaces":
        return re.sub(r" *\n *", "\n", re.sub(r"[ \t]+", " ", text)).strip()
    if t == "remove_emoji":
        return re.sub(r"[ \t]{2,}", " ", _EMOJI.sub("", text)).strip()
    if t == "truncate":
        return _truncate(text, op["max_len"])
    raise BulkEditError(f"operasi tidak dikenal: {t}")


def apply_ops(title: str, description: str, ops: list[dict]) -> tuple[str, str]:
    for op in ops:
        if op["field"] in ("title", "both"):
            title = apply_op(title, op)
        if op["field"] in ("description", "both"):
            description = apply_op(description, op)
    return title, description


def summarize(ops: list[dict]) -> str:
    return ",".join(f"{o['type']}:{o['field']}" for o in ops)[:120]
