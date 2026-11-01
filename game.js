// Spider Solitaire rules. Pure functions on plain, JSON-able state so it can be saved,
// undone and tested without the DOM.
//
// State: { suits, cols, stock, found }
//   cols  — 10 arrays of cards, bottom first. A card is its id (0..103) when face up and
//           ~id (negative) when face down.
//   stock — ids still to deal; the last 10 are dealt next.
//   found — completed K..A runs, each an array of 13 ids (K first).

export const SUIT_SETS = { 1: ["S"], 2: ["S", "H"], 4: ["S", "H", "C", "D"] };
export const COLS = 10;

export const isUp = (x) => x >= 0;
export const idOf = (x) => (x >= 0 ? x : ~x);

// 104 cards = 8 runs of 13. With 2 suits each suit appears 4 times, with 4 suits twice.
export function cardOf(suits, x) {
  const id = idOf(x);
  const set = SUIT_SETS[suits];
  return { suit: set[Math.floor(id / 13) % set.length], rank: (id % 13) + 1 };
}

export function newGame(suits, random = Math.random) {
  const ids = Array.from({ length: 104 }, (_, i) => i);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  // Like Microsoft's deal: 54 cards out (first 4 columns get 6, the rest 5), top card face up.
  const cols = [];
  for (let c = 0; c < COLS; c++) {
    const n = c < 4 ? 6 : 5;
    const col = ids.splice(0, n).map((id) => ~id);
    col[n - 1] = ~col[n - 1];
    cols.push(col);
  }
  return { suits, cols, stock: ids, found: [] };
}

export const clone = (s) => ({
  suits: s.suits,
  cols: s.cols.map((c) => c.slice()),
  stock: s.stock.slice(),
  found: s.found.map((f) => f.slice()),
});

// The cards from idx to the end of the column can be picked up if they're all face up,
// one suit, and descending by one.
export function canPickUp(s, col, idx) {
  const c = s.cols[col];
  if (idx < 0 || idx >= c.length || !isUp(c[idx])) return false;
  for (let j = idx; j < c.length - 1; j++) {
    const a = cardOf(s.suits, c[j]);
    const b = cardOf(s.suits, c[j + 1]);
    if (!isUp(c[j + 1]) || a.suit !== b.suit || b.rank !== a.rank - 1) return false;
  }
  return true;
}

// Any suit may go on a card one rank higher; anything may go in an empty column.
export function canDrop(s, firstCard, to) {
  const c = s.cols[to];
  if (!c.length) return true;
  const top = c[c.length - 1];
  return isUp(top) && cardOf(s.suits, top).rank === cardOf(s.suits, firstCard).rank + 1;
}

function flipTop(col) {
  if (col.length && !isUp(col[col.length - 1])) col[col.length - 1] = ~col[col.length - 1];
}

export function move(s, from, idx, to) {
  const n = clone(s);
  const run = n.cols[from].splice(idx);
  n.cols[to].push(...run);
  flipTop(n.cols[from]);
  return n;
}

export const canDeal = (s) => s.stock.length >= COLS && s.cols.every((c) => c.length > 0);

export function deal(s) {
  const n = clone(s);
  const cards = n.stock.splice(-COLS);
  // Deal left to right: the last card in the stock goes to the first column.
  for (let c = 0; c < COLS; c++) n.cols[c].push(cards[COLS - 1 - c]);
  return n;
}

// Moves every finished K..A run to the foundation. Returns the new state and which columns finished.
export function collect(s) {
  let n = s;
  const done = [];
  for (let c = 0; c < COLS; c++) {
    const col = n.cols[c];
    const i = col.length - 13;
    if (i >= 0 && cardOf(n.suits, col[i]).rank === 13 && canPickUp(n, c, i)) {
      if (n === s) n = clone(s);
      n.found.push(n.cols[c].splice(i));
      flipTop(n.cols[c]);
      done.push(c);
    }
  }
  return { state: n, done };
}

export const isWon = (s) => s.found.length === 8;

// Where a tap sends the run starting at (from, idx): the nearest column whose top card is the same
// suit and one higher; otherwise the nearest one higher of any suit; otherwise the nearest empty column.
// Ties go to the right. Returns a column index or -1.
export function autoTarget(s, from, idx) {
  if (!canPickUp(s, from, idx)) return -1;
  const first = cardOf(s.suits, s.cols[from][idx]);
  const order = [];
  for (let d = 1; d < COLS; d++) {
    if (from + d < COLS) order.push(from + d);
    if (from - d >= 0) order.push(from - d);
  }
  const top = (c) => s.cols[c][s.cols[c].length - 1];
  const fits = (c) => s.cols[c].length && canDrop(s, s.cols[from][idx], c);
  const perfect = order.find((c) => fits(c) && cardOf(s.suits, top(c)).suit === first.suit);
  if (perfect !== undefined) return perfect;
  const any = order.find(fits);
  if (any !== undefined) return any;
  // Moving a whole column into an empty one achieves nothing.
  if (idx > 0) {
    const empty = order.find((c) => !s.cols[c].length);
    if (empty !== undefined) return empty;
  }
  return -1;
}
