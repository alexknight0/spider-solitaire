// Spider solver used to pick winnable deals. It sees the face-down cards and the stock (a deal is
// winnable if some sequence of moves wins it). Between deals it runs a greedy best-first search on
// a heuristic, then deals from the few best positions it found, backtracking if that fails. It
// gives up after maxNodes positions in total. So "not solved" means "no win found", not "impossible".
import { SUIT_SETS, COLS } from "./game.js";

// Defaults were tuned on random deals (~0.2 s per deal; finds a win in about 100% of 1-suit,
// 75% of 2-suit and 20% of 4-suit deals). w = heuristic weights for
// [face-down card, card on a wrong rank, card on the wrong suit, empty column (a bonus)].
export function solve(start, { maxNodes = 60_000, segmentNodes = 2000, keep = 3, w = [4, 3, 1, 4] } = {}) {
  const nSuits = SUIT_SETS[start.suits].length;
  const R = new Int8Array(104);
  const U = new Int8Array(104);
  for (let id = 0; id < 104; id++) {
    R[id] = (id % 13) + 1;
    U[id] = Math.floor(id / 13) % nSuits;
  }
  const stock = start.stock;

  // b (on top) continues a movable run from a (below it).
  const linked = (a, b) => a >= 0 && b >= 0 && U[a] === U[b] && R[a] === R[b] + 1;
  const runStart = (col) => {
    let i = col.length - 1;
    while (i > 0 && linked(col[i - 1], col[i])) i--;
    return i;
  };
  const flipTop = (col) => {
    if (col.length && col[col.length - 1] < 0) col[col.length - 1] = ~col[col.length - 1];
  };
  // Removes a finished K..A run from the top of col (in place). Returns 1 if it did.
  const collect = (col) => {
    if (col.length < 13 || R[col[col.length - 1]] !== 1 || col.length - runStart(col) < 13) return 0;
    col.length -= 13;
    flipTop(col);
    return 1;
  };

  // Lower is better: face-down cards still to uncover and cards not yet in suit order.
  const score = (cols, found) => {
    let h = -found * 30;
    for (const col of cols) {
      if (!col.length) {
        h -= w[3];
        continue;
      }
      for (let i = 0; i < col.length; i++) {
        const x = col[i];
        if (x < 0) {
          h += w[0];
          continue;
        }
        if (i === 0) continue;
        const a = col[i - 1];
        if (a < 0) continue;
        if (R[a] !== R[x] + 1) h += w[1];
        else if (U[a] !== U[x]) h += w[2];
      }
    }
    return h;
  };
  const keyOf = (cols) => cols.map((c) => c.join(",")).sort().join("|");

  const heap = [];
  const push = (n) => {
    heap.push(n);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].h <= n.h) break;
      heap[i] = heap[p];
      i = p;
    }
    heap[i] = n;
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heap[c + 1].h < heap[c].h) c++;
        if (heap[c].h >= last.h) break;
        heap[i] = heap[c];
        i = c;
      }
      heap[i] = last;
    }
    return top;
  };

  let nodes = 0;
  const won = (found) => found === 8;

  // Best-first search over moves without dealing. Returns "won", or up to `keep` of the best
  // positions found that have no empty column (so the next deal is allowed).
  const segment = (cols0, stockLen, found0) => {
    const limit = stockLen ? segmentNodes : segmentNodes * 4;
    const seen = new Set();
    const best = [];
    heap.length = 0;
    const add = (cols, found) => {
      if (won(found)) return true;
      const key = keyOf(cols);
      if (seen.has(key)) return false;
      seen.add(key);
      const n = { cols, found, h: score(cols, found) };
      push(n);
      if (stockLen && cols.every((c) => c.length)) {
        best.push(n);
        if (best.length > keep * 4) {
          best.sort((a, b) => a.h - b.h);
          best.length = keep;
        }
      }
      return false;
    };
    if (add(cols0, found0)) return "won";
    let count = 0;
    while (heap.length && count < limit && nodes < maxNodes) {
      const { cols, found } = pop();
      count++;
      nodes++;
      const empty = cols.findIndex((c) => !c.length);
      for (let f = 0; f < COLS; f++) {
        const src = cols[f];
        if (!src.length) continue;
        const s = runStart(src);
        for (let i = s; i < src.length; i++) {
          const r = R[src[i]];
          const partial = i > s; // splits a same-suit run
          for (let t = 0; t < COLS; t++) {
            if (t === f) continue;
            const dst = cols[t];
            if (!dst.length) {
              // Empty columns are interchangeable; moving a whole column into one does nothing.
              if (t !== empty || i === 0) continue;
            } else {
              const top = dst[dst.length - 1];
              if (R[top] !== r + 1) continue;
              // Splitting a run only helps if the part moved keeps its suit link.
              if (partial && U[top] !== U[src[i]]) continue;
            }
            const next = cols.slice();
            const a = src.slice(0, i);
            flipTop(a);
            const b = dst.concat(src.slice(i));
            const done = collect(b);
            next[f] = a;
            next[t] = b;
            if (add(next, found + done)) return "won";
          }
        }
      }
    }
    best.sort((a, b) => a.h - b.h);
    return best.slice(0, keep);
  };

  // Depth-first over the deals: try dealing from each of the best positions in turn.
  const search = (cols, stockLen, found) => {
    if (nodes >= maxNodes) return false;
    const res = segment(cols, stockLen, found);
    if (res === "won") return true;
    for (const n of res) {
      let done = 0;
      const next = n.cols.map((c, k) => {
        const col = c.concat(stock[stockLen - 1 - k]);
        done += collect(col);
        return col;
      });
      if (search(next, stockLen - COLS, n.found + done)) return true;
      if (nodes >= maxNodes) return false;
    }
    return false;
  };

  let found0 = start.found.length;
  const cols0 = start.cols.map((c) => c.slice());
  for (const c of cols0) found0 += collect(c);
  const solved = search(cols0, stock.length, found0);
  return { solved, nodes };
}
