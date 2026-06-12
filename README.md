# Wordle Signal

Wordle Signal is a Chrome extension that reads your current Wordle-style board and recommends the next best guess. It works locally in the browser, so you do not need to manually click gray/yellow/green tiles or run a Python server.

There is a video of the extension solving a board here: https://x.com/virajm1shra/status/2049239820233331010

## Supported Games

- NYT Wordle
- Wordle Unlimited: `wordleunlimited.org`
- Sedecordle: `sedecordle.com`

## Install For Yourself

Until this is published on the Chrome Web Store, load it as an unpacked extension:

1. Download or clone this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** in the top-right corner.
4. Click **Load unpacked**.
5. Select the `extension` folder inside this repo.
6. Open Wordle, Wordle Unlimited, or Sedecordle.
7. Click the Wordle Signal extension icon and press **Scan**.

If you change the extension code locally, go back to `chrome://extensions` and click the reload button on Wordle Signal.

## How It Works

The extension has two main pieces:

- `extension/contentScript.js` reads the active game page.
- `extension/solver.js` computes the recommendation locally.

No guesses, board states, or browsing data are sent to a server.

## Board Reading Logic

The content script detects which supported game is open and uses a site-specific reader.

For NYT Wordle, it scans visible board tiles and reads the tile state:

- green/correct -> `G`
- yellow/present -> `Y`
- gray/absent -> `B`

For Wordle Unlimited, it reads the custom elements inside `game-app`:

- each `game-row`
- each nested `game-tile`
- the tile `letter`
- the tile `evaluation`

For Sedecordle, it reads Sedecordle's native cell ids:

```text
box{board},{row},{column}
```

Examples:

```text
box1,1,1
box4,3,5
box16,21,5
```

It also reads Sedecordle's remaining-guesses counter so unfinished typed rows are ignored.

## Solver Logic

The solver is based on Wordle feedback pattern matching and entropy scoring.

Each possible feedback result is encoded as a small integer from `0` to `242`. A five-letter feedback pattern has three possible values per tile:

```text
B = 0
Y = 1
G = 2
```

So a pattern like:

```text
BBYGG
```

is encoded as a base-3 number. This makes filtering and scoring much faster than comparing strings or tuples.

## Duplicate Letters

The feedback function handles duplicate letters using the same two-pass logic as Wordle:

1. First mark exact green matches.
2. Count the remaining unmatched answer letters.
3. Mark yellows only while that letter is still available.
4. Everything else becomes gray.

This avoids common duplicate-letter bugs such as incorrectly marking both `L`s yellow when the answer only has one `L`.

## Candidate Filtering

After every scanned guess, the solver filters the answer list by replaying the feedback rule.

For each possible answer:

```text
score_guess(guess, possible_answer) == observed_feedback
```

If the generated pattern matches the observed pattern, that answer remains possible. Otherwise it is removed.

## Entropy Scoring

For each candidate guess, the solver checks how it would split the remaining possible answers into feedback buckets.

A good guess creates many small buckets. The solver computes Shannon entropy:

```text
entropy = sum(-p * log2(p))
```

where `p` is the fraction of possible answers in each feedback bucket.

The higher the entropy, the more information the guess is expected to reveal.

## Performance Optimizations

The extension uses several optimizations:

- Pattern rows are cached per guess.
- Feedback patterns are stored as compact integer codes.
- Entropy terms are cached by candidate count.
- Large early-game searches use a high-coverage opening pool.
- Small candidate sets use direct scoring to avoid unnecessary full-table work.

The recommended first guess from the current word lists is:

```text
SOARE
```

If you only want guesses that can be actual Wordle answers, a strong opener is:

```text
RAISE
```

## Sedecordle Strategy

Sedecordle needs a different policy than normal Wordle because there are 16 boards.

The solver uses a hybrid approach:

1. Early game: maximize information across all active boards.
2. Midgame: continue entropy scoring, but add a bonus for guesses that can solve active boards.
3. Endgame: prioritize boards with small candidate sets.
4. If a board has only one possible answer, prioritize guessing it.

This prevents the solver from chasing global information for too long when it should be finishing boards.

## Project Structure

```text
extension/
  manifest.json
  contentScript.js
  solver.js
  popup.html
  popup.css
  popup.js
  words/
    wordleanswers.txt
    wordleguesses.txt

solver_core.py
wordleanswers.txt
wordleguesses.txt
```

The Chrome extension uses the word lists inside `extension/words/`.

`solver_core.py` is the Python reference implementation. The shipped extension runs from `extension/solver.js`.

## Privacy

Wordle Signal runs locally in Chrome. It reads the current game board from supported pages and computes recommendations on-device. It does not send your board state or guesses anywhere.
