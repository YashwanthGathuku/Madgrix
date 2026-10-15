"""Deterministic completion-claim classification."""

import re
from dataclasses import dataclass


@dataclass
class Claim:
    sentence: str
    phrases: list[str]


_CLAIM_PATTERNS = (
    re.compile(r"\b(?:complete|completed)\b", re.IGNORECASE),
    re.compile(r"\bdone\b", re.IGNORECASE),
    re.compile(r"\bfinished\b", re.IGNORECASE),
    re.compile(r"\bfixed\b", re.IGNORECASE),
    re.compile(r"\bresolved\b", re.IGNORECASE),
    re.compile(r"\bimplemented\b", re.IGNORECASE),
    re.compile(
        r"\b(?:all\s+(?:the\s+)?|the\s+|[a-z_][\w-]*\s+)?"
        r"tests?\s+(?:pass|passes|passed|passing)\b",
        re.IGNORECASE,
    ),
    re.compile(r"\bready\s+to\s+(?:merge|ship|deploy)\b", re.IGNORECASE),
    re.compile(r"\bshould\s+work\b", re.IGNORECASE),
    re.compile(r"\b(?:is|are)\s+(?:now\s+)?working\b", re.IGNORECASE),
    re.compile(r"\b(?:works|worked)\b", re.IGNORECASE),
)

_SUPPRESSION_PATTERN = re.compile(
    r"\b(?:not|never|no|cannot|unable|yet|incomplete)\b"
    r"|\b(?:haven|hasn|isn|aren|don|doesn|didn|won|can)['\u2019]t\b"
    r"|\bstill\s+(?:need|failing)\b"
    r"|\bworking\s+on\b",
    re.IGNORECASE,
)

_REPORTED_RESULT_PATTERN = re.compile(
    r"\b(?:error|output|message|log|report)\s+"
    r"(?:said|says|showed|shows|reported|claimed|indicated)\b",
    re.IGNORECASE,
)

_QUESTION_END_PATTERN = re.compile(r"\?[\"')\]}]*\s*$")
_SENTENCE_CLOSERS = "\"')]}\u201d"


def _split_sentences(text: str) -> list[str]:
    sentences: list[str] = []
    start = 0
    index = 0

    while index < len(text):
        character = text[index]
        if character == "\n":
            sentence = text[start:index].strip()
            if sentence:
                sentences.append(sentence)
            index += 1
            start = index
            continue

        if character in ".!?":
            end = index + 1
            while end < len(text) and text[end] in _SENTENCE_CLOSERS:
                end += 1
            if end == len(text) or text[end].isspace():
                sentence = text[start:end].strip()
                if sentence:
                    sentences.append(sentence)
                index = end
                start = end
                continue
        index += 1

    sentence = text[start:].strip()
    if sentence:
        sentences.append(sentence)
    return sentences


def _matched_phrases(sentence: str) -> list[str]:
    matches: list[tuple[int, int, str]] = []
    for pattern in _CLAIM_PATTERNS:
        for match in pattern.finditer(sentence):
            matches.append((match.start(), match.end(), match.group(0)))

    matches.sort(key=lambda item: (item[0], item[1]))
    phrases: list[str] = []
    seen_spans: set[tuple[int, int]] = set()
    for start, end, phrase in matches:
        if (start, end) not in seen_spans:
            phrases.append(phrase)
            seen_spans.add((start, end))
    return phrases


def find_claims(text: str) -> list[Claim]:
    """Return completion claims from unsuppressed sentences in final text."""
    if not isinstance(text, str) or not text.strip():
        return []

    claims: list[Claim] = []
    for sentence in _split_sentences(text):
        if _QUESTION_END_PATTERN.search(sentence):
            continue
        if _SUPPRESSION_PATTERN.search(sentence):
            continue
        if _REPORTED_RESULT_PATTERN.search(sentence):
            continue

        phrases = _matched_phrases(sentence)
        if phrases:
            claims.append(Claim(sentence=sentence, phrases=phrases))
    return claims
