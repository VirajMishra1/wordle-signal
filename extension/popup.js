import { SolverEngine } from "./solver.js";

const statusEl = document.querySelector("#status");
const bestEl = document.querySelector("#best");
const bestWordEl = document.querySelector("#bestWord");
const bestMetaEl = document.querySelector("#bestMeta");
const boardsEl = document.querySelector("#boards");
const rankingsEl = document.querySelector("#rankings");
const refreshButton = document.querySelector("#refresh");

let enginePromise;

refreshButton.addEventListener("click", scanActiveTab);
scanActiveTab();

async function scanActiveTab() {
  setStatus("Scanning board...");
  bestEl.classList.add("hidden");
  boardsEl.innerHTML = "";
  rankingsEl.innerHTML = "";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab found.");
    if (!isSupportedUrl(tab.url || "")) {
      throw new Error("Open NYT Wordle or Sedecordle, then scan again.");
    }

    const pageState = await sendReadMessage(tab.id);
    if (!pageState.ok) throw new Error(pageState.error || "Could not read this board.");

    const engine = await getEngine();
    const result = pageState.game === "sedecordle"
      ? engine.recommendSedecordle(pageState.boards, pageState.solved, 8)
      : engine.recommendWordle(pageState.history, 8);

    renderResult(pageState, result);
  } catch (error) {
    setStatus(error.message, true);
  }
}

function isSupportedUrl(url) {
  return /nytimes\.com\/games\/wordle|wordleunlimited\.org|sedecordle\.com/i.test(url);
}

function sendReadMessage(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: "WORDLE_SIGNAL_READ" }, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error("Reload the game page, then scan again."));
        return;
      }
      resolve(response);
    });
  });
}

function getEngine() {
  if (!enginePromise) enginePromise = SolverEngine.create();
  return enginePromise;
}

function renderResult(pageState, result) {
  const best = result.recommendations[0];
  const historyCount = pageState.game === "sedecordle"
    ? pageState.boards.reduce((sum, board) => sum + board.length, 0)
    : pageState.history.length;

  if (!best) {
    setStatus("No active unsolved boards found.");
    return;
  }

  const modeLabel = pageState.game === "sedecordle" ? "Sedecordle" : "Wordle";
  const countLabel = pageState.game === "sedecordle"
    ? `${result.activeBoards} active boards`
    : `${result.possibleCount} possible answers`;

  setStatus(`${modeLabel} read: ${historyCount} completed row${historyCount === 1 ? "" : "s"}.`);
  bestWordEl.textContent = best.word.toUpperCase();
  bestMetaEl.textContent = `${countLabel} · worst case ${best.remainingIfWorst} left`;
  bestEl.classList.remove("hidden");

  renderBoards(pageState, result);
  renderRankings(result.recommendations);
}

function renderBoards(pageState, result) {
  if (pageState.game === "wordle") {
    boardsEl.innerHTML = miniBoard("W", pageState.history);
    return;
  }

  boardsEl.innerHTML = pageState.boards
    .map((history, index) => {
      const board = result.boards[index];
      const label = board?.solved ? "✓" : String(board?.possibleCount ?? "?");
      return miniBoard(`#${String(index + 1).padStart(2, "0")} ${label}`, history);
    })
    .join("");
}

function miniBoard(title, history) {
  const rows = history.map(([, feedback]) => `
    <div class="mini-row">
      ${[...feedback].map((mark) => `<span class="tile ${normalizeMark(mark)}"></span>`).join("")}
    </div>
  `).join("");
  return `<div class="board"><b>${title}</b>${rows || "<span class='label'>empty</span>"}</div>`;
}

function normalizeMark(mark) {
  if ("GC2".includes(mark)) return "G";
  if ("YP1".includes(mark)) return "Y";
  return "B";
}

function renderRankings(recommendations) {
  rankingsEl.innerHTML = `
    <ol>
      ${recommendations.map((item) => `
        <li>
          <span class="word">${item.word}</span>
          <span class="score">${item.score}</span>
        </li>
      `).join("")}
    </ol>
  `;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}
