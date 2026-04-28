from __future__ import annotations

import math
from array import array
from collections import Counter
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Iterable


WORD_LENGTH = 5
PATTERN_COUNT = 3 ** WORD_LENGTH
Feedback = tuple[int, ...]

GREEN = 2
YELLOW = 1
GRAY = 0

FEEDBACK_ALIASES = {
    "G": GREEN,
    "C": GREEN,
    "2": GREEN,
    "Y": YELLOW,
    "P": YELLOW,
    "1": YELLOW,
    "B": GRAY,
    "A": GRAY,
    "X": GRAY,
    "0": GRAY,
}

DEFAULT_ROOT = Path(__file__).resolve().parent
DEFAULT_ANSWERS_PATH = DEFAULT_ROOT / "wordleanswers.txt"
DEFAULT_GUESSES_PATH = DEFAULT_ROOT / "wordleguesses.txt"
WIDE_SEARCH_POOL = 450
POWERS_OF_THREE = tuple(3**index for index in range(WORD_LENGTH))


def load_words(path: str | Path) -> tuple[str, ...]:
    words = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for line in handle:
            word = line.strip().lower()
            if len(word) == WORD_LENGTH and word.isalpha():
                words.append(word)
    if not words:
        raise ValueError(f"No valid {WORD_LENGTH}-letter words found in {path}")
    return tuple(dict.fromkeys(words))


def parse_feedback(raw: str | Iterable[int | str]) -> Feedback:
    if isinstance(raw, str):
        tokens = raw.strip().upper().replace(" ", "")
    else:
        tokens = "".join(str(item).upper() for item in raw)

    if len(tokens) != WORD_LENGTH:
        raise ValueError("Feedback must contain exactly five marks.")

    try:
        return tuple(FEEDBACK_ALIASES[token] for token in tokens)
    except KeyError as exc:
        raise ValueError("Use G/Y/B, C/P/A, or 2/1/0 for feedback.") from exc


def feedback_to_string(feedback: Feedback, style: str = "gyb") -> str:
    alphabets = {
        "gyb": {GREEN: "G", YELLOW: "Y", GRAY: "B"},
        "cpa": {GREEN: "C", YELLOW: "P", GRAY: "A"},
        "numeric": {GREEN: "2", YELLOW: "1", GRAY: "0"},
    }
    alphabet = alphabets.get(style, alphabets["gyb"])
    return "".join(alphabet[value] for value in feedback)


def feedback_to_code(feedback: Feedback) -> int:
    return sum(value * POWERS_OF_THREE[index] for index, value in enumerate(feedback))


def code_to_feedback(code: int) -> Feedback:
    values = []
    for _ in range(WORD_LENGTH):
        code, value = divmod(code, 3)
        values.append(value)
    return tuple(values)


def score_guess_code(guess: str, answer: str) -> int:
    guess = guess.lower()
    answer = answer.lower()
    result = [GRAY] * WORD_LENGTH
    remaining = [0] * 26

    for index in range(WORD_LENGTH):
        if guess[index] == answer[index]:
            result[index] = GREEN
        else:
            remaining[ord(answer[index]) - 97] += 1

    code = 0
    for index in range(WORD_LENGTH):
        if result[index] == GREEN:
            code += GREEN * POWERS_OF_THREE[index]
            continue
        letter_index = ord(guess[index]) - 97
        if remaining[letter_index] > 0:
            code += YELLOW * POWERS_OF_THREE[index]
            remaining[letter_index] -= 1

    return code


@lru_cache(maxsize=None)
def score_guess(guess: str, answer: str) -> Feedback:
    return code_to_feedback(score_guess_code(guess, answer))


@dataclass(frozen=True)
class GuessResult:
    word: str
    score: float
    remaining_if_worst: int
    is_possible_answer: bool


@dataclass(frozen=True)
class BoardState:
    history: tuple[tuple[str, Feedback], ...]
    possible_indices: tuple[int, ...]
    possible: tuple[str, ...]
    solved: bool


class PatternMatrix:
    def __init__(self, answers: tuple[str, ...], guesses: tuple[str, ...]) -> None:
        self.answers = answers
        self.guesses = guesses
        self._rows: dict[str, array] = {}

    def row_for(self, guess: str) -> array:
        guess = guess.lower()
        row = self._rows.get(guess)
        if row is None:
            row = array("B", (score_guess_code(guess, answer) for answer in self.answers))
            self._rows[guess] = row
        return row

    def cached_row_for(self, guess: str) -> array | None:
        return self._rows.get(guess.lower())


class WordBank:
    def __init__(
        self,
        answers_path: str | Path = DEFAULT_ANSWERS_PATH,
        guesses_path: str | Path = DEFAULT_GUESSES_PATH,
    ) -> None:
        self.answers = load_words(answers_path)
        guesses = load_words(guesses_path)
        self.guesses = tuple(dict.fromkeys((*guesses, *self.answers)))
        self.answer_index = {word: index for index, word in enumerate(self.answers)}
        self.guess_index = {word: index for index, word in enumerate(self.guesses)}
        self.all_answer_indices = tuple(range(len(self.answers)))
        self.patterns = PatternMatrix(self.answers, self.guesses)
        self.opening_pool = self._build_opening_pool()

    def _build_opening_pool(self) -> tuple[str, ...]:
        letter_frequency = Counter(letter for word in self.answers for letter in set(word))

        def coverage_score(word: str) -> tuple[int, int, str]:
            unique = set(word)
            return (sum(letter_frequency[letter] for letter in unique), len(unique), word)

        return tuple(
            word
            for word in sorted(self.guesses, key=coverage_score, reverse=True)[:WIDE_SEARCH_POOL]
        )


class SolverEngine:
    def __init__(self, bank: WordBank | None = None) -> None:
        self.bank = bank or WordBank()
        self._entropy_terms: dict[int, tuple[float, ...]] = {}

    def board_from_history(
        self,
        history: Iterable[tuple[str, str | Iterable[int | str]]],
        solved: bool = False,
    ) -> BoardState:
        parsed = tuple((guess.lower(), parse_feedback(feedback)) for guess, feedback in history)
        possible_indices = self.filter_answer_indices(parsed)
        possible = tuple(self.bank.answers[index] for index in possible_indices)
        is_solved = solved or any(feedback == (GREEN,) * WORD_LENGTH for _, feedback in parsed)
        return BoardState(
            history=parsed,
            possible_indices=possible_indices,
            possible=possible,
            solved=is_solved,
        )

    def filter_answers(self, history: Iterable[tuple[str, Feedback]]) -> tuple[str, ...]:
        return tuple(self.bank.answers[index] for index in self.filter_answer_indices(history))

    def filter_answer_indices(self, history: Iterable[tuple[str, Feedback]]) -> tuple[int, ...]:
        candidates = self.bank.all_answer_indices
        for guess, feedback in history:
            code = feedback_to_code(feedback)
            row = self.bank.patterns.row_for(guess)
            candidates = tuple(index for index in candidates if row[index] == code)
        return candidates

    def recommend_wordle(
        self,
        history: Iterable[tuple[str, str | Iterable[int | str]]] = (),
        limit: int = 12,
    ) -> dict:
        board = self.board_from_history(history)
        guesses = self.rank_guesses([board], limit=limit)
        return {
            "mode": "wordle",
            "possible_count": len(board.possible),
            "possible": board.possible[:50],
            "recommendations": [result.__dict__ for result in guesses],
        }

    def recommend_sedecordle(
        self,
        boards: Iterable[Iterable[tuple[str, str | Iterable[int | str]]]],
        solved: Iterable[bool] | None = None,
        limit: int = 12,
    ) -> dict:
        solved_flags = tuple(solved or ())
        states = []
        for index, history in enumerate(boards):
            states.append(self.board_from_history(history, solved_flags[index] if index < len(solved_flags) else False))
        active = [state for state in states if not state.solved and state.possible]
        guesses = self.rank_sedecordle_guesses(active, limit=limit)
        return {
            "mode": "sedecordle",
            "active_boards": len(active),
            "boards": [
                {
                    "index": index,
                    "solved": state.solved,
                    "possible_count": len(state.possible),
                    "possible": state.possible[:20],
                }
                for index, state in enumerate(states)
            ],
            "recommendations": [result.__dict__ for result in guesses],
        }

    def rank_sedecordle_guesses(self, boards: list[BoardState], limit: int = 12) -> list[GuessResult]:
        active_boards = [board for board in boards if board.possible and not board.solved]
        if not active_boards:
            return []

        turns_played = max((len(board.history) for board in active_boards), default=0)
        singleton_words = self._unique_possible_words(
            board for board in active_boards if len(board.possible_indices) == 1
        )
        if singleton_words:
            return self._rank_specific_words(singleton_words, active_boards, limit)

        if turns_played >= 4:
            target_boards = [
                board
                for board in active_boards
                if len(board.possible_indices) <= self._sedecordle_target_size(turns_played)
            ]
            if target_boards:
                return self._rank_specific_words(self._unique_possible_words(target_boards), active_boards, limit)

        return self._rank_guesses(
            active_boards,
            limit,
            self._candidate_words(active_boards),
            solve_bonus=turns_played >= 2,
        )

    def rank_guesses(self, boards: list[BoardState], limit: int = 12) -> list[GuessResult]:
        active_boards = [board for board in boards if board.possible and not board.solved]
        if not active_boards:
            return []
        return self._rank_guesses(active_boards, limit, self._candidate_words(active_boards))

    def _rank_guesses(
        self,
        active_boards: list[BoardState],
        limit: int,
        candidate_words: tuple[str, ...],
        solve_bonus: bool = False,
    ) -> list[GuessResult]:
        possible_union = {word for board in active_boards for word in board.possible}
        possible_answer_indices = {
            index
            for board in active_boards
            for index in board.possible_indices
        }
        weighted_boards = Counter(board.possible_indices for board in active_boards)
        ranked = [
            self._score_candidate(word, weighted_boards, possible_answer_indices, solve_bonus)
            for word in candidate_words
        ]
        ranked.sort(
            key=lambda item: (
                item.score,
                item.is_possible_answer,
                -item.remaining_if_worst,
                item.word,
            ),
            reverse=True,
        )
        return ranked[: max(1, limit)]

    def _rank_specific_words(
        self,
        words: tuple[str, ...],
        active_boards: list[BoardState],
        limit: int,
    ) -> list[GuessResult]:
        return self._rank_guesses(active_boards, limit, words, solve_bonus=True)

    def _unique_possible_words(self, boards: Iterable[BoardState]) -> tuple[str, ...]:
        seen = set()
        words = []
        for board in boards:
            for word in board.possible:
                if word not in seen:
                    seen.add(word)
                    words.append(word)
        return tuple(words)

    def _sedecordle_target_size(self, turns_played: int) -> int:
        if turns_played >= 10:
            return 80
        if turns_played >= 7:
            return 35
        return 12

    def _candidate_words(self, boards: list[BoardState]) -> tuple[str, ...]:
        largest_board = max(len(board.possible) for board in boards)
        possible_union = tuple(dict.fromkeys(word for board in boards for word in board.possible))

        if largest_board <= 3:
            return possible_union
        if largest_board <= 40:
            return tuple(dict.fromkeys((*possible_union, *self.bank.guesses)))
        if largest_board > 300:
            return tuple(dict.fromkeys((*possible_union[:80], *self.bank.opening_pool)))
        return self.bank.guesses

    def _score_candidate(
        self,
        guess: str,
        weighted_boards: Counter[tuple[int, ...]],
        possible_answer_indices: set[int],
        solve_bonus: bool = False,
    ) -> GuessResult:
        entropy = 0.0
        worst_bucket = 0
        row = self._pattern_row_for_candidate(guess, weighted_boards)
        answer_index = self.bank.answer_index.get(guess)

        for possible_indices, weight in weighted_boards.items():
            buckets = [0] * PATTERN_COUNT
            for index in possible_indices:
                if row is None:
                    code = score_guess_code(guess, self.bank.answers[index])
                else:
                    code = row[index]
                buckets[code] += 1

            terms = self._terms_for_total(len(possible_indices))
            board_entropy = sum(terms[count] for count in buckets if count)
            entropy += board_entropy * weight
            if solve_bonus and answer_index in possible_indices:
                entropy += (2.4 + 9.0 / len(possible_indices)) * weight
            worst_bucket = max(worst_bucket, max(buckets))

        return GuessResult(
            word=guess,
            score=round(entropy, 4),
            remaining_if_worst=worst_bucket,
            is_possible_answer=answer_index in possible_answer_indices,
        )

    def _pattern_row_for_candidate(
        self,
        guess: str,
        weighted_boards: Counter[tuple[int, ...]],
    ) -> array | None:
        cached = self.bank.patterns.cached_row_for(guess)
        if cached is not None:
            return cached

        largest_board = max(len(indices) for indices in weighted_boards)
        if largest_board < 300:
            return None
        return self.bank.patterns.row_for(guess)

    def _terms_for_total(self, total: int) -> tuple[float, ...]:
        terms = self._entropy_terms.get(total)
        if terms is None:
            values = [0.0]
            values.extend(
                -(count / total) * math.log2(count / total)
                for count in range(1, total + 1)
            )
            terms = tuple(values)
            self._entropy_terms[total] = terms
        return terms
