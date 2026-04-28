const WORD_LENGTH = 5;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "WORDLE_SIGNAL_READ") return false;
  try {
    sendResponse({ ok: true, ...readPageState() });
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
  return true;
});

function readPageState() {
  const host = location.hostname.toLowerCase();

  if (host.includes("wordleunlimited.org")) {
    return {
      game: "wordle",
      history: readWordleUnlimitedHistory(),
      source: location.href
    };
  }

  if (host.includes("sedecordle")) {
    const nativeBoards = readSedecordleNativeBoards();
    if (nativeBoards.length) {
      return {
        game: "sedecordle",
        boards: nativeBoards.map((board) => board.history),
        solved: nativeBoards.map((board) => board.solved),
        source: location.href
      };
    }

    const allTiles = findTileLikeElements(document);
    if (!allTiles.length) {
      return {
        game: "sedecordle",
        boards: Array.from({ length: 16 }, () => []),
        solved: Array.from({ length: 16 }, () => false),
        source: location.href
      };
    }

    const boards = readSedecordleBoards(allTiles);
    return {
      game: "sedecordle",
      boards: boards.map((board) => board.history),
      solved: boards.map((board) => board.solved),
      source: location.href
    };
  }

  const allTiles = findTileLikeElements(document);
  if (!allTiles.length) {
    return {
      game: "wordle",
      history: [],
      source: location.href
    };
  }

  return {
    game: "wordle",
    history: readSingleBoard(allTiles).history,
    source: location.href
  };
}

function readWordleUnlimitedHistory() {
  const gameApp = document.querySelector("game-app");
  const root = gameApp?.shadowRoot;
  if (!root) return [];

  const rows = [...root.querySelectorAll("#board game-row")];
  return rows
    .map((row) => {
      const tiles = [...(row.shadowRoot?.querySelectorAll("game-tile") || [])];
      if (tiles.length !== WORD_LENGTH) return null;

      const guess = tiles
        .map((tile, index) => (
          tile.getAttribute("letter") ||
          row.getAttribute("letters")?.[index] ||
          ""
        ))
        .join("")
        .trim()
        .toLowerCase();
      if (!/^[a-z]{5}$/.test(guess)) return null;

      const feedbackMarks = tiles.map(readWordleUnlimitedTileFeedback);
      if (!feedbackMarks.every(Boolean)) return null;

      const feedback = feedbackMarks.join("");
      return [guess, feedback];
    })
    .filter(Boolean);
}

function readWordleUnlimitedTileFeedback(tile) {
  const evaluation = (tile.getAttribute("evaluation") || "").toLowerCase();
  const state = (
    tile.shadowRoot?.querySelector(".tile")?.dataset?.state ||
    ""
  ).toLowerCase();
  const mark = evaluation || state;

  if (mark === "correct") return "G";
  if (mark === "present") return "Y";
  if (mark === "absent") return "B";
  return "";
}

function readSedecordleNativeBoards() {
  const boards = [];
  const completedRows = getSedecordleCompletedRows();
  for (let boardNumber = 1; boardNumber <= 16; boardNumber += 1) {
    const firstCell = document.getElementById(`box${boardNumber},1,1`);
    if (!firstCell) return [];

    const history = [];
    for (let rowNumber = 1; rowNumber <= completedRows; rowNumber += 1) {
      const row = [];
      for (let columnNumber = 1; columnNumber <= WORD_LENGTH; columnNumber += 1) {
        const cell = document.getElementById(`box${boardNumber},${rowNumber},${columnNumber}`);
        if (!cell) continue;
        row.push({
          letter: (cell.textContent || "").trim().toLowerCase(),
          feedback: readSedecordleCellFeedback(cell)
        });
      }

      if (row.length !== WORD_LENGTH) continue;
      if (!row.every((cell) => /^[a-z]$/.test(cell.letter))) continue;
      history.push([
        row.map((cell) => cell.letter).join(""),
        row.map((cell) => cell.feedback).join("")
      ]);
    }

    const nav = document.getElementById(`boxnav-${boardNumber}`);
    const navColor = nav ? normalizeColor(getComputedStyle(nav).backgroundColor) : "";
    boards.push({
      history,
      solved: navColor === "green" || history.some(([, feedback]) => feedback === "GGGGG")
    });
  }
  return boards;
}

function getSedecordleCompletedRows() {
  const counter = document.getElementById("box-guesses");
  const text = (counter?.textContent || "").trim();
  const match = text.match(/^(\d+)\s*\/\s*21$/);
  if (!match) return 21;
  return Math.max(0, Math.min(21, 21 - Number(match[1])));
}

function readSedecordleCellFeedback(cell) {
  const color = normalizeColor(getComputedStyle(cell).backgroundColor);
  if (color === "green") return "G";
  if (color === "yellow") return "Y";
  return "B";
}

function normalizeColor(color) {
  const compact = String(color || "").replace(/\s/g, "").toLowerCase();
  if (
    compact === "#00cc88" ||
    compact === "rgb(0,204,136)" ||
    compact === "rgba(0,204,136,1)" ||
    compact.includes("0,204,136")
  ) {
    return "green";
  }
  if (
    compact === "#ffcc00" ||
    compact === "rgb(255,204,0)" ||
    compact === "rgba(255,204,0,1)" ||
    compact.includes("255,204,0")
  ) {
    return "yellow";
  }
  return "";
}

function findTileLikeElements(root) {
  const roots = collectRoots(root);
  const tiles = [];
  for (const currentRoot of roots) {
    const elements = currentRoot.querySelectorAll("*");
    for (const element of elements) {
      const tile = readTile(element);
      if (tile) tiles.push({ element, ...tile });
    }
  }
  return dedupeTiles(tiles);
}

function collectRoots(root) {
  const roots = [root];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    if (walker.currentNode.shadowRoot) roots.push(walker.currentNode.shadowRoot);
  }
  return roots;
}

function readTile(element) {
  if (isKeyboardOrButton(element)) return null;

  const text = (element.textContent || "").trim().toLowerCase();
  const letter = /^[a-z]$/.test(text) ? text : readLetterFromAria(element);
  if (!letter) return null;

  const feedback = readFeedback(element);
  if (!feedback) return null;

  const rect = element.getBoundingClientRect();
  if (rect.width < 6 || rect.height < 6) return null;
  const aspect = rect.width / rect.height;
  if (aspect < 0.72 || aspect > 1.28) return null;

  return { letter, feedback, rect };
}

function isKeyboardOrButton(element) {
  if (element.closest("button, [role='button'], input, textarea")) return true;

  let current = element;
  while (current && current !== document.body) {
    const label = [
      current.id,
      current.className,
      current.getAttribute("aria-label"),
      current.getAttribute("data-testid")
    ].join(" ").toLowerCase();
    if (/(keyboard|key-board|key row|keyrow)/.test(label)) return true;
    current = current.parentElement;
  }
  return false;
}

function readLetterFromAria(element) {
  const aria = (element.getAttribute("aria-label") || "").toLowerCase();
  const match = aria.match(/\b([a-z])\b/);
  return match ? match[1] : "";
}

function readFeedback(element) {
  const haystack = [
    element.getAttribute("data-state"),
    element.getAttribute("data-status"),
    element.getAttribute("data-evaluation"),
    element.getAttribute("aria-label"),
    element.className
  ].join(" ").toLowerCase();

  if (/\b(correct|green)\b/.test(haystack)) return "G";
  if (/\b(present|yellow|elsewhere)\b/.test(haystack)) return "Y";
  if (/\b(absent|gray|grey|empty|wrong)\b/.test(haystack)) return "B";
  return "";
}

function dedupeTiles(tiles) {
  const seen = new Set();
  return tiles.filter((tile) => {
    const key = [
      Math.round(tile.rect.left),
      Math.round(tile.rect.top),
      tile.letter,
      tile.feedback
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readSingleBoard(tiles) {
  const sorted = [...tiles].sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  const rows = groupRows(sorted);
  return {
    history: rowsToHistory(rows),
    solved: rows.some((row) => row.every((tile) => tile.feedback === "G"))
  };
}

function readSedecordleBoards(tiles) {
  const containers = findBoardContainers(tiles);
  if (containers.length >= 8) {
    return containers.slice(0, 16).map((container) => readSingleBoard(container.tiles));
  }

  const columns = splitByLargeGaps(tiles, "left").flatMap((column) => splitByLargeGaps(column, "top"));
  const boards = columns
    .map((group) => readSingleBoard(group))
    .filter((board) => board.history.length);

  if (boards.length >= 8) return boards.slice(0, 16);
  return [readSingleBoard(tiles)];
}

function findBoardContainers(tiles) {
  const boardMap = new Map();
  for (const tile of tiles) {
    const container = nearestBoardContainer(tile.element);
    if (!container) continue;
    if (!boardMap.has(container)) boardMap.set(container, []);
    boardMap.get(container).push(tile);
  }

  return [...boardMap.entries()]
    .map(([element, groupedTiles]) => ({ element, tiles: groupedTiles }))
    .filter((group) => group.tiles.length >= 5)
    .filter((group, _index, groups) => !groups.some((other) => other !== group && other.element.contains(group.element)))
    .sort((a, b) => {
      const ar = a.element.getBoundingClientRect();
      const br = b.element.getBoundingClientRect();
      return ar.top - br.top || ar.left - br.left;
    });
}

function nearestBoardContainer(element) {
  let current = element.parentElement;
  while (current && current !== document.body) {
    const label = [
      current.id,
      current.className,
      current.getAttribute("role"),
      current.getAttribute("aria-label"),
      current.getAttribute("data-testid")
    ].join(" ").toLowerCase();
    if (/(board|grid|game|puzzle)/.test(label)) return current;
    current = current.parentElement;
  }
  return element.parentElement;
}

function splitByLargeGaps(tiles, axis) {
  const coordinate = axis === "left" ? "left" : "top";
  const size = axis === "left" ? "width" : "height";
  const sorted = [...tiles].sort((a, b) => a.rect[coordinate] - b.rect[coordinate]);
  const groups = [];
  let current = [];
  let previousCenter = null;
  const medianSize = median(sorted.map((tile) => tile.rect[size]));

  for (const tile of sorted) {
    const center = tile.rect[coordinate] + tile.rect[size] / 2;
    if (previousCenter !== null && center - previousCenter > medianSize * 4 && current.length >= 5) {
      groups.push(current);
      current = [];
    }
    current.push(tile);
    previousCenter = center;
  }
  if (current.length) groups.push(current);
  return groups;
}

function groupRows(tiles) {
  const sorted = [...tiles].sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  const rows = [];
  let current = [];
  let currentTop = null;
  const rowTolerance = Math.max(8, median(sorted.map((tile) => tile.rect.height)) * 0.55);

  for (const tile of sorted) {
    if (currentTop === null || Math.abs(tile.rect.top - currentTop) <= rowTolerance) {
      current.push(tile);
      currentTop = currentTop === null ? tile.rect.top : currentTop;
    } else {
      rows.push(current);
      current = [tile];
      currentTop = tile.rect.top;
    }
  }
  if (current.length) rows.push(current);

  return rows
    .map((row) => row.sort((a, b) => a.rect.left - b.rect.left).slice(0, WORD_LENGTH))
    .filter((row) => row.length === WORD_LENGTH);
}

function rowsToHistory(rows) {
  return rows
    .map((row) => [row.map((tile) => tile.letter).join(""), row.map((tile) => tile.feedback).join("")])
    .filter(([guess]) => /^[a-z]{5}$/.test(guess));
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.floor(sorted.length / 2)];
}
