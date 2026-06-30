#!/usr/bin/env python3
"""
pdf_quiz_to_json.py

Convert a quiz-style PDF into a JSON file using the structure shown in Format.json.

Supported question types:
- single_choice: question with one correct option
- multiple_choice: question with multiple correct options (detected from wording or answer key)
- matching: matching questions with two labelled lists, such as:
    A. N1 Sleep        1. Description...
    B. N2 Sleep        2. Description...
  or:
    i. Skin            a. Superficial inguinal lymph nodes
    ii. Cervix         b. Internal iliac lymph nodes

Typical PDF layout expected:
- A "Questions" section
- An "Answers" section
- Questions numbered 1., 2., 3. ...
- Choices labelled a., b., c. ... or A., B., C. ...
- Answer key entries like "1. D. Explanation..."

Install:
    pip install pymupdf

Run:
    python pdf_quiz_to_json.py week_1.pdf Format.json week_1_output.json

Notes:
- The parser is intentionally heuristic because quiz PDFs are not truly structured data.
- If a PDF answer key has a typo, use the --overrides option to correct answers manually.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

try:
    import fitz  # PyMuPDF
except ImportError as exc:  # pragma: no cover
    raise SystemExit(
        "PyMuPDF is required. Install it with: pip install pymupdf"
    ) from exc


ROMAN_LABELS = {
    "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x",
    "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii", "xviii", "xix", "xx",
}

QUESTION_START_RE = re.compile(r"^\s*(\d{1,3})\s*[\.)]\s*(.*)$")
ANSWER_START_RE = re.compile(r"^\s*(\d{1,3})\s*[\.)]\s*(.*)$")
LABEL_START_RE = re.compile(r"^\s*([ivxlcdm]{1,6}|[A-Z]|[a-z]|\d{1,3})\s*[\.)]\s*(.*)$")
LOWER_OPTION_RE = re.compile(r"^\s*([a-z])\s*[\.)]\s*(.*)$")


def clean_space(text: str) -> str:
    """Normalize whitespace while preserving normal punctuation."""
    text = re.sub(r"\s+", " ", text).strip()
    text = text.replace(" ?", "?").replace(" .", ".").replace(" ,", ",")
    return text


def extract_text_lines(pdf_path: Path) -> List[str]:
    """Extract text from the PDF, one cleaned line at a time."""
    lines: List[str] = []
    doc = fitz.open(pdf_path)
    for page in doc:
        text = page.get_text("text")
        for raw in text.splitlines():
            line = raw.strip()
            if not line:
                continue
            # Drop page numbers. These commonly appear as standalone lines in course PDFs.
            if re.fullmatch(r"\d{1,4}", line):
                continue
            # Drop common page/header labels. Add more skip rules here if your PDFs need them.
            if re.fullmatch(r"Week\s+\d+", line, flags=re.IGNORECASE):
                continue
            lines.append(line)
    return lines


def split_questions_and_answers(lines: List[str]) -> Tuple[List[str], List[str]]:
    """Return lines from the Questions section and the Answers section."""
    q_index: Optional[int] = None
    a_index: Optional[int] = None

    for i, line in enumerate(lines):
        if re.fullmatch(r"Questions?", line, flags=re.IGNORECASE):
            q_index = i
            break

    for i, line in enumerate(lines):
        if re.fullmatch(r"Answers?", line, flags=re.IGNORECASE):
            a_index = i
            break

    if a_index is None:
        raise ValueError("Could not find an 'Answers' section in the PDF text.")

    question_lines = lines[q_index + 1 if q_index is not None else 0 : a_index]
    answer_lines = lines[a_index + 1 :]
    return question_lines, answer_lines


def split_numbered_blocks(lines: List[str]) -> "OrderedDict[int, List[str]]":
    """
    Split text into numbered blocks.

    This uses sequential numbering rather than every numeric label. That prevents
    matching descriptions like "1. Description" inside question 1 from being
    mistaken for a new question.
    """
    blocks: "OrderedDict[int, List[str]]" = OrderedDict()
    current_id: Optional[int] = None
    current_lines: List[str] = []

    for line in lines:
        match = QUESTION_START_RE.match(line)
        starts_next = False
        if match:
            number = int(match.group(1))
            rest = match.group(2).strip()
            if current_id is None:
                # Usually the first question is 1, but this also supports partial PDFs.
                starts_next = True
            elif number == current_id + 1:
                starts_next = True

            if starts_next:
                if current_id is not None:
                    blocks[current_id] = current_lines
                current_id = number
                current_lines = [rest] if rest else []
                continue

        if current_id is not None:
            current_lines.append(line)

    if current_id is not None:
        blocks[current_id] = current_lines

    return blocks


def label_class(label: str) -> str:
    """Classify labels so matching questions can be split into term and choice lists."""
    if label.isdigit():
        return "number"
    if label.isupper():
        return "upper"
    low = label.lower()
    # Treat i, ii, iii, iv... as roman numerals. This supports matching formats.
    if low in ROMAN_LABELS:
        return "roman"
    return "lower"


def parse_labeled_items(lines: List[str], allowed_classes: Optional[Iterable[str]] = None) -> Tuple[List[str], List[Dict[str, str]]]:
    """
    Parse labelled list items from lines.

    Returns:
        prefix_lines: lines before the first labelled item
        items: each item has label, text, and _class
    """
    allowed = set(allowed_classes) if allowed_classes else None
    prefix_lines: List[str] = []
    items: List[Dict[str, str]] = []
    current: Optional[Dict[str, str]] = None
    seen_first_label = False

    for line in lines:
        match = LABEL_START_RE.match(line)
        if match:
            label = match.group(1).strip()
            # For regular multiple-choice parsing, single lowercase labels are
            # choices even when the letter is also a Roman numeral, such as i or v.
            if allowed == {"lower"} and len(label) == 1 and label.islower():
                klass = "lower"
            else:
                klass = label_class(label)
            if allowed is None or klass in allowed:
                if current is not None:
                    current["text"] = clean_space(current["text"])
                    items.append(current)
                current = {"label": label, "text": match.group(2).strip(), "_class": klass}
                seen_first_label = True
                continue

        if current is not None:
            current["text"] = clean_space(current.get("text", "") + " " + line)
        elif not seen_first_label:
            prefix_lines.append(line)

    if current is not None:
        current["text"] = clean_space(current["text"])
        items.append(current)

    return prefix_lines, items


def parse_choice_question(question_id: int, lines: List[str]) -> Dict[str, Any]:
    """Parse a regular single-choice or multiple-choice question."""
    prompt_lines, options = parse_labeled_items(lines, allowed_classes={"lower"})
    prompt = clean_space(" ".join(prompt_lines))

    normalized_options = [
        {"label": item["label"].lower(), "text": item["text"]}
        for item in options
    ]

    prompt_lower = prompt.lower()
    is_multiple = any(
        phrase in prompt_lower
        for phrase in [
            "multiple correct",
            "multiple answers",
            "select all",
            "there could be multiple",
            "choose all",
        ]
    )

    result: Dict[str, Any] = {
        "id": question_id,
        "type": "multiple_choice" if is_multiple else "single_choice",
        "prompt": prompt,
        "options": normalized_options,
    }
    if is_multiple:
        result["multiple_correct_answers"] = True
        result["answer"] = {"correct_options": [], "explanation": ""}
    else:
        result["answer"] = {"correct_option": "", "explanation": ""}
    return result


def group_matching_items(items: List[Dict[str, str]]) -> List[Tuple[str, List[Dict[str, str]]]]:
    """Group consecutive labelled items by label class."""
    groups: List[Tuple[str, List[Dict[str, str]]]] = []
    for item in items:
        klass = item["_class"]
        public_item = {"label": item["label"], "text": item["text"]}
        if groups and groups[-1][0] == klass:
            groups[-1][1].append(public_item)
        else:
            groups.append((klass, [public_item]))
    return groups


def parse_matching_question(question_id: int, lines: List[str]) -> Dict[str, Any]:
    """Parse a matching question with two labelled lists."""
    prompt_lines, items = parse_labeled_items(lines)
    prompt = clean_space(" ".join(prompt_lines))
    groups = group_matching_items(items)

    # In a normal matching question, the first labelled group is terms and the
    # second labelled group is descriptions/choices. If the PDF has more groups,
    # keep the first two and include a warning for review.
    terms: List[Dict[str, str]] = []
    target_items: List[Dict[str, str]] = []
    target_key = "choices"
    warnings: List[str] = []

    if len(groups) >= 2:
        first_class, terms = groups[0]
        second_class, target_items = groups[1]
        target_key = "descriptions" if second_class == "number" else "choices"
        if len(groups) > 2:
            warnings.append("More than two labelled groups were detected; only the first two groups were used.")
    else:
        warnings.append("Matching question detected, but two labelled groups were not found.")
        if groups:
            _, terms = groups[0]

    answer_matches = [{"term_label": term["label"], "answer_label": ""} for term in terms]
    result: Dict[str, Any] = {
        "id": question_id,
        "type": "matching",
        "prompt": prompt,
        "terms": terms,
        target_key: target_items,
        "answer": {"matches": answer_matches, "explanation": ""},
    }
    if warnings:
        result["parser_warnings"] = warnings
    return result


def looks_like_matching(lines: List[str]) -> bool:
    text = clean_space(" ".join(lines)).lower()
    if "match" in text or "one answer per" in text:
        return True

    # Extra heuristic: two different labelled-list classes in the same block can
    # indicate a matching question, especially if one group is uppercase/roman and
    # the second group is numbered/lowercase.
    _, items = parse_labeled_items(lines)
    classes = [klass for klass, _group in group_matching_items(items)]
    return len(classes) >= 2 and classes[0] != "lower"


def parse_questions(question_lines: List[str]) -> List[Dict[str, Any]]:
    blocks = split_numbered_blocks(question_lines)
    questions: List[Dict[str, Any]] = []

    for question_id, lines in blocks.items():
        if looks_like_matching(lines):
            questions.append(parse_matching_question(question_id, lines))
        else:
            questions.append(parse_choice_question(question_id, lines))

    return questions


def split_answer_blocks(answer_lines: List[str]) -> "OrderedDict[int, str]":
    blocks = split_numbered_blocks(answer_lines)
    return OrderedDict((qid, clean_space(" ".join(lines))) for qid, lines in blocks.items())


def get_option_labels(question: Dict[str, Any]) -> List[str]:
    return [opt["label"] for opt in question.get("options", [])]


def extract_choice_labels(answer_text: str, valid_labels: List[str]) -> Tuple[List[str], str]:
    """
    Extract answer labels from an answer-key line.

    Examples:
        "D. Explanation" -> (["d"], "Explanation")
        "A, C and D. Explanation" -> (["a", "c", "d"], "Explanation")
    """
    valid = {label.lower() for label in valid_labels}
    text = answer_text.strip()

    # Most answer keys use: "D. Explanation"
    direct = re.match(r"^\s*([A-Za-z])\s*[\.)]\s*(.*)$", text)
    if direct and direct.group(1).lower() in valid:
        return [direct.group(1).lower()], clean_space(direct.group(2))

    # Multiple answers may use: "A, C and D. Explanation"
    first_sentence, sep, rest = text.partition(".")
    if len(first_sentence) <= 40:
        labels = [m.group(1).lower() for m in re.finditer(r"\b([A-Za-z])\b", first_sentence)]
        labels = [label for label in labels if label in valid]
        if labels:
            return labels, clean_space(rest if sep else text)

    return [], text


def parse_matching_answer_pairs(answer_text: str, term_labels: List[str], answer_labels: List[str]) -> Tuple[Dict[str, str], str]:
    """
    Extract matching answer pairs from the answer key.

    Handles forms such as:
        A-2, B-3, C-4
        A: 2; B: 3
        i = c, ii = f
    """
    term_set = {x.lower(): x for x in term_labels}
    answer_set = {x.lower(): x for x in answer_labels}
    pairs: Dict[str, str] = {}

    pair_re = re.compile(
        r"\b([A-Za-z]+|\d{1,3})\b\s*(?:-|–|—|:|=|→|->|to)\s*\b([A-Za-z]+|\d{1,3})\b",
        flags=re.IGNORECASE,
    )
    for left, right in pair_re.findall(answer_text):
        left_key = left.lower()
        right_key = right.lower()
        if left_key in term_set and right_key in answer_set:
            pairs[term_set[left_key]] = answer_set[right_key]
        elif right_key in term_set and left_key in answer_set:
            pairs[term_set[right_key]] = answer_set[left_key]

    return pairs, answer_text


def attach_answers(questions: List[Dict[str, Any]], answer_lines: List[str]) -> None:
    answer_blocks = split_answer_blocks(answer_lines)
    by_id = {q["id"]: q for q in questions}

    for question_id, answer_text in answer_blocks.items():
        question = by_id.get(question_id)
        if question is None:
            continue

        if question["type"] == "matching":
            target_key = "descriptions" if "descriptions" in question else "choices"
            term_labels = [term["label"] for term in question.get("terms", [])]
            answer_labels = [item["label"] for item in question.get(target_key, [])]
            pair_map, explanation = parse_matching_answer_pairs(answer_text, term_labels, answer_labels)
            for match in question["answer"]["matches"]:
                match["answer_label"] = pair_map.get(match["term_label"], "")
            question["answer"]["explanation"] = clean_space(explanation)
            continue

        option_labels = get_option_labels(question)
        labels, explanation = extract_choice_labels(answer_text, option_labels)

        if question["type"] == "multiple_choice":
            question["answer"]["correct_options"] = labels
            question["answer"]["explanation"] = explanation
        else:
            question["answer"]["correct_option"] = labels[0] if labels else ""
            question["answer"]["explanation"] = explanation


def apply_overrides(questions: List[Dict[str, Any]], overrides_path: Optional[Path]) -> None:
    """
    Apply manual corrections from a JSON file.

    Override file examples:
        {
          "4": {"answer": {"correct_option": "c"}},
          "6": {"answer": {"correct_option": "d"}}
        }

    For matching:
        {
          "1": {"answer": {"matches": [{"term_label": "A", "answer_label": "2"}]}}
        }
    """
    if overrides_path is None:
        return
    overrides = json.loads(overrides_path.read_text(encoding="utf-8"))
    by_id = {str(q["id"]): q for q in questions}

    for qid, patch in overrides.items():
        question = by_id.get(str(qid))
        if not question:
            continue
        deep_update(question, patch)


def deep_update(target: Dict[str, Any], patch: Dict[str, Any]) -> None:
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            deep_update(target[key], value)
        else:
            target[key] = value


def build_output(questions: List[Dict[str, Any]], format_path: Optional[Path]) -> Dict[str, Any]:
    """Use the same top-level container as Format.json when possible."""
    if format_path and format_path.exists():
        try:
            template = json.loads(format_path.read_text(encoding="utf-8"))
            if isinstance(template, dict) and "questions" in template:
                return {"questions": questions}
        except Exception:
            pass
    return {"questions": questions}


def convert_pdf_to_json(pdf_path: Path, format_path: Optional[Path] = None, overrides_path: Optional[Path] = None) -> Dict[str, Any]:
    lines = extract_text_lines(pdf_path)
    question_lines, answer_lines = split_questions_and_answers(lines)
    questions = parse_questions(question_lines)
    attach_answers(questions, answer_lines)
    apply_overrides(questions, overrides_path)
    return build_output(questions, format_path)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Convert quiz PDFs into structured JSON.")
    parser.add_argument("pdf", type=Path, help="Input PDF file")
    parser.add_argument("format", type=Path, nargs="?", help="Optional Format.json template")
    parser.add_argument("output", type=Path, nargs="?", help="Output JSON file")
    parser.add_argument("--overrides", type=Path, help="Optional JSON file with manual answer corrections")
    parser.add_argument("--indent", type=int, default=2, help="JSON indentation level")
    args = parser.parse_args(argv)

    output_path = args.output
    format_path = args.format

    # Allow: python script.py input.pdf output.json
    if output_path is None and format_path is not None and format_path.suffix.lower() == ".json" and format_path.name.lower() != "format.json":
        output_path = format_path
        format_path = None

    if output_path is None:
        output_path = args.pdf.with_suffix(".json")

    result = convert_pdf_to_json(args.pdf, format_path, args.overrides)
    output_path.write_text(json.dumps(result, indent=args.indent, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {len(result.get('questions', []))} questions to {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
