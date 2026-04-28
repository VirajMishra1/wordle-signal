const WORD_LENGTH = 5;
const PATTERN_COUNT = 3 ** WORD_LENGTH;
const GREEN = 2;
const YELLOW = 1;
const GRAY = 0;
const WIDE_SEARCH_POOL = 450;
const POWERS_OF_THREE = [1, 3, 9, 27, 81];
const SOLVED_CODE = GREEN * POWERS_OF_THREE.reduce((sum, value) => sum + value, 0);

const FEEDBACK_ALIASES = {
  G: GREEN, C: GREEN, "2": GREEN,
  Y: YELLOW, P: YELLOW, "1": YELLOW,
  B: GRAY, A: GRAY, X: GRAY, "0": GRAY
};

function parseFeedback(raw) {
  const tokens = String(raw || "").toUpperCase().replace(/\s/g, "");
  if (tokens.length !== WORD_LENGTH) {
    throw new Error("Feedback must contain exactly five marks.");
  }
  return [...tokens].map((token) => {
    if (!(token in FEEDBACK_ALIASES)) {
      throw new Error("Use G/Y/B, C/P/A, or 2/1/0 feedback.");
    }
    return FEEDBACK_ALIASES[token];
  });
}

function feedbackToCode(feedback) {
  let code = 0;
  for (let index = 0; index < WORD_LENGTH; index += 1) {
    code += feedback[index] * POWERS_OF_THREE[index];
  }
  return code;
}

function scoreGuessCode(guess, answer) {
  const result = [GRAY, GRAY, GRAY, GRAY, GRAY];
  const remaining = new Uint8Array(26);

  for (let index = 0; index < WORD_LENGTH; index += 1) {
    if (guess[index] === answer[index]) {
      result[index] = GREEN;
    } else {
      remaining[answer.charCodeAt(index) - 97] += 1;
    }
  }

  let code = 0;
  for (let index = 0; index < WORD_LENGTH; index += 1) {
    if (result[index] === GREEN) {
      code += GREEN * POWERS_OF_THREE[index];
      continue;
    }
    const letterIndex = guess.charCodeAt(index) - 97;
    if (remaining[letterIndex] > 0) {
      code += YELLOW * POWERS_OF_THREE[index];
      remaining[letterIndex] -= 1;
    }
  }
  return code;
}

function readWords(text) {
  const seen = new Set();
  const words = [];
  for (const raw of text.split(/\r?\n/)) {
    const word = raw.trim().toLowerCase();
    if (/^[a-z]{5}$/.test(word) && !seen.has(word)) {
      seen.add(word);
      words.push(word);
    }
  }
  return words;
}

async function loadText(path) {
  const response = await fetch(chrome.runtime.getURL(path));
  if (!response.ok) throw new Error(`Could not load ${path}`);
  return response.text();
}

class PatternRows {
  constructor(answers) {
    this.answers = answers;
    this.rows = new Map();
  }

  cachedRowFor(guess) {
    return this.rows.get(guess);
  }

  rowFor(guess) {
    let row = this.rows.get(guess);
    if (!row) {
      row = new Uint8Array(this.answers.length);
      for (let index = 0; index < this.answers.length; index += 1) {
        row[index] = scoreGuessCode(guess, this.answers[index]);
      }
      this.rows.set(guess, row);
    }
    return row;
  }
}

class SolverEngine {
  constructor(answers, guesses) {
    this.answers = answers;
    this.guesses = [...new Set([...guesses, ...answers])];
    this.answerIndex = new Map(answers.map((word, index) => [word, index]));
    this.allAnswerIndices = answers.map((_, index) => index);
    this.patterns = new PatternRows(answers);
    this.openingPool = this.buildOpeningPool();
    this.entropyTerms = new Map();
  }

  static async create() {
    const [answersText, guessesText] = await Promise.all([
      loadText("words/wordleanswers.txt"),
      loadText("words/wordleguesses.txt")
    ]);
    return new SolverEngine(readWords(answersText), readWords(guessesText));
  }

  buildOpeningPool() {
    const frequencies = new Map();
    for (const word of this.answers) {
      for (const letter of new Set(word)) {
        frequencies.set(letter, (frequencies.get(letter) || 0) + 1);
      }
    }
    return [...this.guesses]
      .sort((a, b) => {
        const scoreA = [...new Set(a)].reduce((sum, letter) => sum + frequencies.get(letter), 0);
        const scoreB = [...new Set(b)].reduce((sum, letter) => sum + frequencies.get(letter), 0);
        if (scoreA !== scoreB) return scoreB - scoreA;
        const uniqueDiff = new Set(b).size - new Set(a).size;
        return uniqueDiff || b.localeCompare(a);
      })
      .slice(0, WIDE_SEARCH_POOL);
  }

  recommendWordle(history, limit = 12) {
    const board = this.boardFromHistory(history);
    return {
      mode: "wordle",
      possibleCount: board.possible.length,
      possible: board.possible.slice(0, 50),
      recommendations: this.rankGuesses([board], limit)
    };
  }

  recommendSedecordle(boards, solved = [], limit = 12) {
    const states = boards.map((history, index) => this.boardFromHistory(history, Boolean(solved[index])));
    const active = states.filter((state) => !state.solved && state.possible.length);
    return {
      mode: "sedecordle",
      activeBoards: active.length,
      boards: states.map((state, index) => ({
        index,
        solved: state.solved,
        possibleCount: state.possible.length,
        possible: state.possible.slice(0, 20)
      })),
      recommendations: this.rankSedecordleGuesses(active, limit)
    };
  }

  boardFromHistory(history, solved = false) {
    const parsed = history
      .map(([guess, feedback]) => [String(guess).toLowerCase(), parseFeedback(feedback)])
      .filter(([guess]) => /^[a-z]{5}$/.test(guess));
    const possibleIndices = this.filterAnswerIndices(parsed);
    return {
      history: parsed,
      possibleIndices,
      possible: possibleIndices.map((index) => this.answers[index]),
      solved: solved || parsed.some(([, feedback]) => feedbackToCode(feedback) === SOLVED_CODE)
    };
  }

  filterAnswerIndices(history) {
    let candidates = this.allAnswerIndices;
    for (const [guess, feedback] of history) {
      const code = feedbackToCode(feedback);
      const row = this.patterns.rowFor(guess);
      candidates = candidates.filter((index) => row[index] === code);
    }
    return candidates;
  }

  rankGuesses(boards, limit = 12) {
    const activeBoards = boards.filter((board) => board.possible.length && !board.solved);
    if (!activeBoards.length) return [];
    return this.rankCandidateWords(activeBoards, limit, this.candidateWords(activeBoards));
  }

  rankSedecordleGuesses(boards, limit = 12) {
    const activeBoards = boards.filter((board) => board.possible.length && !board.solved);
    if (!activeBoards.length) return [];

    const turnsPlayed = Math.max(...activeBoards.map((board) => board.history.length), 0);
    const singletonWords = this.uniquePossibleWords(
      activeBoards.filter((board) => board.possibleIndices.length === 1)
    );
    if (singletonWords.length) {
      return this.rankCandidateWords(activeBoards, limit, singletonWords, true);
    }

    if (turnsPlayed >= 4) {
      const targetSize = this.sedecordleTargetSize(turnsPlayed);
      const targetBoards = activeBoards.filter((board) => board.possibleIndices.length <= targetSize);
      if (targetBoards.length) {
        return this.rankCandidateWords(activeBoards, limit, this.uniquePossibleWords(targetBoards), true);
      }
    }

    return this.rankCandidateWords(activeBoards, limit, this.candidateWords(activeBoards), turnsPlayed >= 2);
  }

  rankCandidateWords(activeBoards, limit, candidateWords, solveBonus = false) {
    const possibleAnswerIndices = new Set();
    const weightedBoards = new Map();
    for (const board of activeBoards) {
      for (const index of board.possibleIndices) possibleAnswerIndices.add(index);
      const key = board.possibleIndices.join(",");
      const existing = weightedBoards.get(key);
      if (existing) {
        existing.weight += 1;
      } else {
        weightedBoards.set(key, { indices: board.possibleIndices, weight: 1 });
      }
    }

    const ranked = candidateWords.map((word) => this.scoreCandidate(word, weightedBoards, possibleAnswerIndices, solveBonus));
    ranked.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.isPossibleAnswer !== b.isPossibleAnswer) return Number(b.isPossibleAnswer) - Number(a.isPossibleAnswer);
      if (a.remainingIfWorst !== b.remainingIfWorst) return a.remainingIfWorst - b.remainingIfWorst;
      return b.word.localeCompare(a.word);
    });
    return ranked.slice(0, Math.max(1, limit));
  }

  uniquePossibleWords(boards) {
    const seen = new Set();
    const words = [];
    for (const board of boards) {
      for (const word of board.possible) {
        if (!seen.has(word)) {
          seen.add(word);
          words.push(word);
        }
      }
    }
    return words;
  }

  sedecordleTargetSize(turnsPlayed) {
    if (turnsPlayed >= 10) return 80;
    if (turnsPlayed >= 7) return 35;
    return 12;
  }

  candidateWords(boards) {
    const largestBoard = Math.max(...boards.map((board) => board.possibleIndices.length));
    const possibleUnion = [];
    const seen = new Set();
    for (const board of boards) {
      for (const word of board.possible) {
        if (!seen.has(word)) {
          seen.add(word);
          possibleUnion.push(word);
        }
      }
    }
    if (largestBoard <= 3) return possibleUnion;
    if (largestBoard <= 40) return [...new Set([...possibleUnion, ...this.guesses])];
    if (largestBoard > 300) return [...new Set([...possibleUnion.slice(0, 80), ...this.openingPool])];
    return this.guesses;
  }

  scoreCandidate(guess, weightedBoards, possibleAnswerIndices, solveBonus = false) {
    let entropy = 0;
    let remainingIfWorst = 0;
    const row = this.patternRowForCandidate(guess, weightedBoards);
    const answerIndex = this.answerIndex.get(guess);

    for (const { indices, weight } of weightedBoards.values()) {
      const buckets = new Uint16Array(PATTERN_COUNT);
      for (const index of indices) {
        const code = row ? row[index] : scoreGuessCode(guess, this.answers[index]);
        buckets[code] += 1;
      }
      const terms = this.termsForTotal(indices.length);
      let boardEntropy = 0;
      let worstBucket = 0;
      for (const count of buckets) {
        if (!count) continue;
        boardEntropy += terms[count];
        if (count > worstBucket) worstBucket = count;
      }
      entropy += boardEntropy * weight;
      if (solveBonus && indices.includes(answerIndex)) {
        entropy += (2.4 + 9.0 / indices.length) * weight;
      }
      if (worstBucket > remainingIfWorst) remainingIfWorst = worstBucket;
    }

    return {
      word: guess,
      score: Math.round(entropy * 10000) / 10000,
      remainingIfWorst,
      isPossibleAnswer: possibleAnswerIndices.has(answerIndex)
    };
  }

  patternRowForCandidate(guess, weightedBoards) {
    const cached = this.patterns.cachedRowFor(guess);
    if (cached) return cached;
    let largest = 0;
    for (const { indices } of weightedBoards.values()) {
      if (indices.length > largest) largest = indices.length;
    }
    return largest < 300 ? null : this.patterns.rowFor(guess);
  }

  termsForTotal(total) {
    let terms = this.entropyTerms.get(total);
    if (!terms) {
      terms = new Float64Array(total + 1);
      for (let count = 1; count <= total; count += 1) {
        const p = count / total;
        terms[count] = -p * Math.log2(p);
      }
      this.entropyTerms.set(total, terms);
    }
    return terms;
  }
}

export { SolverEngine };
