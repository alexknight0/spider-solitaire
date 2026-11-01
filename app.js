import { VERSION } from "./version.js";
import {
  COLS, newGame, cardOf, isUp, idOf, canPickUp, canDrop, move, canDeal, deal, collect, isWon, autoTarget,
} from "./game.js";

const $ = (sel) => document.querySelector(sel);
const board = $("#board");
const SAVE_KEY = "spider-solitaire:game";
const SUITS_KEY = "spider-solitaire:suits";
const SYMBOL = { S: "♠\uFE0E", H: "♥\uFE0E", C: "♣\uFE0E", D: "♦\uFE0E" };
const RANK = [, "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const MODE_LABEL = { 1: "1 suit", 2: "2 suits", 4: "4 suits" };
const DRAG_START_PX = 6;
const MOVE_MS = 220;

// ---------------------------------------------------------------- game state
// history holds { s, moves } snapshots from before each action, oldest first, so Undo pops one
// and Undo all goes back to history[0] (the deal).

let S = null;
let history = [];
let moves = 0;
let elapsed = 0; // seconds
let won = false;
let busy = false; // true while a finished run is flying to the foundation

function save() {
  if (!S.stock.length && !S.found.length && S.cols.every((c) => !c.length)) return; // blank table before the first deal
  localStorage.setItem(SAVE_KEY, JSON.stringify({ s: S, history, moves, elapsed, won }));
}

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (!d?.s?.cols) return false;
    ({ s: S, history, moves, elapsed, won } = d);
    return true;
  } catch {
    return false;
  }
}

function startGame(state) {
  localStorage.setItem(SUITS_KEY, String(state.suits));
  S = state;
  history = [];
  moves = 0;
  elapsed = 0;
  won = false;
  buildCards();
  render({ instant: true });
  save();
}

const score = () => 500 - moves + 100 * S.found.length;

// ---------------------------------------------------------------- winnable deals
// With "Winnable deals only" on, solver-worker.js deals random games until solver.js finds a win.
// One winnable deal per difficulty is found ahead of time and kept in localStorage, so New game
// is usually instant.

const WINNABLE_KEY = "spider-solitaire:winnable";
const NEXT_KEY = "spider-solitaire:next:"; // + suits
const winnableOnly = () => localStorage.getItem(WINNABLE_KEY) !== "0";

let worker = null;
let job = null; // { suits, promise, onProgress } for the search in progress
let findToken = 0; // bumped when the player stops waiting for a search

function findDeal(suits) {
  if (job?.suits === suits) return job.promise;
  worker?.terminate();
  worker = new Worker("solver-worker.js", { type: "module" });
  const j = { suits, onProgress: null };
  j.promise = new Promise((resolve) => {
    worker.onmessage = ({ data }) => {
      if (!data.state) {
        j.onProgress?.(data.attempt);
        return;
      }
      worker.terminate();
      worker = null;
      job = null;
      resolve(data.state);
    };
  });
  job = j;
  worker.postMessage({ suits });
  return j.promise;
}

function takeCached(suits) {
  const raw = localStorage.getItem(NEXT_KEY + suits);
  localStorage.removeItem(NEXT_KEY + suits);
  try {
    return raw && JSON.parse(raw);
  } catch {
    return null;
  }
}

function prepareNext(suits) {
  if (!winnableOnly() || localStorage.getItem(NEXT_KEY + suits)) return;
  findDeal(suits).then((s) => localStorage.setItem(NEXT_KEY + suits, JSON.stringify(s)));
}

const findDialog = $("#find-dialog");

async function requestGame(suits) {
  if (!winnableOnly()) {
    startGame(newGame(suits));
    return;
  }
  let s = takeCached(suits);
  if (!s) {
    const token = ++findToken;
    $("#find-text").textContent = `Checking ${MODE_LABEL[suits]} deals…`;
    findDialog.dataset.suits = suits;
    findDialog.showModal();
    findDeal(suits);
    job.onProgress = (n) => ($("#find-text").textContent = `Checked ${n} ${MODE_LABEL[suits]} deal${n === 1 ? "" : "s"}…`);
    s = await findDeal(suits);
    // prepareNext may have cached this same deal; don't hand it out twice.
    localStorage.removeItem(NEXT_KEY + suits);
    if (token !== findToken) return;
    findDialog.close();
  }
  startGame(s);
  prepareNext(suits);
}

$("#find-any").addEventListener("click", () => {
  const suits = +findDialog.dataset.suits;
  findToken++;
  findDialog.close();
  startGame(newGame(suits));
  prepareNext(suits); // keeps the search going for next time
});
findDialog.addEventListener("cancel", (e) => e.preventDefault());

// ---------------------------------------------------------------- layout

let L = null; // current geometry
const cardEls = [];
const loc = []; // id -> { kind: "col" | "stock" | "found", col, idx }
const pos = []; // id -> { x, y, z } last rendered

function layout() {
  const W = board.clientWidth;
  const H = board.clientHeight;
  const g = Math.max(3, Math.min(10, W * 0.008));
  const cw = Math.min((W - g * (COLS + 1)) / COLS, H / 1.4 / 3.4, 110);
  const ch = cw * 1.4;
  const left = (W - (COLS * cw + (COLS - 1) * g)) / 2;
  const top = g * 1.5;
  const footY = H - ch - g * 1.5;
  L = {
    W, H, g, cw, ch, left, top, footY,
    colX: (c) => left + c * (cw + g),
    tableauBottom: footY - g * 2,
  };
  board.style.setProperty("--cw", `${cw}px`);
  placeSlots();
}

function placeSlots() {
  board.querySelectorAll(".slot").forEach((el) => el.remove());
  const add = (x, y, cls) => {
    const el = document.createElement("div");
    el.className = `slot ${cls}`;
    el.style.transform = `translate(${x}px, ${y}px)`;
    board.prepend(el);
  };
  for (let c = 0; c < COLS; c++) add(L.colX(c), L.top, "col-slot");
  add(L.left, L.footY, "found-slot");
}

function computePositions() {
  const { cw, ch, top, footY } = L;
  const out = [];
  // Tableau: face-down cards overlap more than face-up ones; tall columns squeeze to fit.
  S.cols.forEach((col, c) => {
    const fdGap = ch * 0.12;
    const fuGap = ch * 0.27;
    let need = 0;
    for (let i = 0; i < col.length - 1; i++) need += isUp(col[i]) ? fuGap : fdGap;
    const room = L.tableauBottom - top - ch;
    const k = need > room ? room / need : 1;
    let y = top;
    col.forEach((x, i) => {
      out[idOf(x)] = { x: L.colX(c), y, z: i + 1, up: isUp(x), kind: "col", col: c, idx: i };
      y += (isUp(x) ? fuGap : fdGap) * k;
    });
  });
  // Stock: one small pile per remaining deal, bottom right; the next deal is on top.
  const right = L.colX(COLS - 1);
  S.stock.forEach((id, i) => {
    const group = Math.floor(i / COLS);
    out[id] = { x: right - group * cw * 0.22, y: footY, z: 1 + i, up: false, kind: "stock" };
  });
  // Foundation: completed runs bottom left, King showing.
  S.found.forEach((run, f) => {
    run.forEach((id, j) => {
      out[id] = { x: L.left + f * cw * 0.3, y: footY, z: 200 + f * 13 + (13 - j), up: true, kind: "found" };
    });
  });
  return out;
}

function buildCards() {
  board.querySelectorAll(".card").forEach((el) => el.remove());
  for (let id = 0; id < 104; id++) {
    const { suit, rank } = cardOf(S.suits, id);
    const el = document.createElement("div");
    el.className = `card${suit === "H" || suit === "D" ? " red" : ""}`;
    el.dataset.id = id;
    el.innerHTML = `<span class="ix">${RANK[rank]}<b>${SYMBOL[suit]}</b></span><span class="pip">${SYMBOL[suit]}</span>`;
    board.append(el);
    cardEls[id] = el;
    pos[id] = null;
  }
}

let zTimer = 0;

// delays: optional id -> ms, used to stagger deals and collections.
function render({ instant = false, delays = null } = {}) {
  const next = computePositions();
  clearTimeout(zTimer);
  let raised = false;
  // Only test rigs leave cards out of the state; hide those.
  cardEls.forEach((el, id) => (el.hidden = !next[id]));
  next.forEach((p, id) => {
    const el = cardEls[id];
    const prev = pos[id];
    const moved = prev && (Math.abs(prev.x - p.x) > 0.5 || Math.abs(prev.y - p.y) > 0.5);
    el.classList.toggle("down", !p.up);
    el.classList.toggle("stock", p.kind === "stock");
    el.classList.remove("dragging");
    el.style.transition = instant ? "none" : "";
    el.style.transitionDelay = delays?.[id] ? `${delays[id]}ms` : "";
    el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    // Moving cards fly above everything, then drop to their real stacking order.
    el.style.zIndex = moved && !instant ? 1000 + p.z : p.z;
    if (moved && !instant) raised = true;
    loc[id] = p;
    pos[id] = p;
  });
  if (raised) {
    const longest = MOVE_MS + Math.max(0, ...Object.values(delays || {}));
    zTimer = setTimeout(() => next.forEach((p, id) => (cardEls[id].style.zIndex = p.z)), longest + 30);
  }
  if (instant) {
    void board.offsetHeight; // apply the jump before transitions come back on
    cardEls.forEach((el) => (el.style.transition = ""));
  }
  updateHud();
}

function updateHud() {
  $("#mode").textContent = MODE_LABEL[S.suits];
  $("#score").textContent = score();
  $("#moves").textContent = moves;
  $("#time").textContent = formatTime(elapsed);
  $("#undo").disabled = !history.length || busy;
  $("#undo-all").disabled = !history.length || busy;
}

function formatTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor(sec / 60) % 60;
  const s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// ---------------------------------------------------------------- actions

function record() {
  history.push({ s: S, moves });
  moves++;
}

function doMove(from, idx, to) {
  record();
  S = move(S, from, idx, to);
  render();
  afterAction();
}

function doDeal() {
  if (busy || won) return;
  if (!S.stock.length) return;
  if (!canDeal(S)) {
    toast("Every column needs at least one card before you can deal.");
    return;
  }
  record();
  const dealt = S.stock.slice(-COLS).reverse();
  S = deal(S);
  const delays = {};
  dealt.forEach((id, c) => (delays[id] = c * 40));
  render({ delays });
  afterAction(COLS * 40);
}

// Finished K..A runs leave the table once the move that finished them has landed.
function afterAction(extraWait = 0) {
  const { state, done } = collect(S);
  if (!done.length) {
    save();
    return;
  }
  busy = true;
  updateHud();
  setTimeout(() => {
    const delays = {};
    state.found.slice(-done.length).forEach((run) => run.forEach((id, j) => (delays[id] = (12 - j) * 30)));
    S = state;
    render({ delays });
    setTimeout(() => {
      busy = false;
      updateHud();
      if (isWon(S)) win();
      save();
    }, 13 * 30 + MOVE_MS);
  }, MOVE_MS + extraWait + 80);
}

function undo() {
  if (busy || !history.length) return;
  ({ s: S, moves } = history.pop());
  won = false;
  render();
  save();
}

function undoAll() {
  if (busy || !history.length) return;
  ({ s: S, moves } = history[0]);
  history = [];
  won = false;
  render();
  save();
}

function win({ animate = true } = {}) {
  won = true;
  $("#win-text").textContent = `Score ${score()} in ${moves} moves, ${formatTime(elapsed)} (${MODE_LABEL[S.suits]}).`;
  const show = () => $("#win-dialog").showModal();
  if (animate && !reduceMotion.matches) celebrate(show);
  else show();
}

// ---------------------------------------------------------------- win animation
// Like the old Windows Solitaire finish: cards leave the foundation one at a time and bounce
// across the table, leaving a trail of copies behind them. Tapping skips to the win dialog;
// closing the dialog clears the table again.

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const LAUNCH_MS = 120;
const GRAVITY = 0.6; // px per frame², for 40 px cards
let celebration = null; // { canvas, raf, done, finished }

function cardImage(id, dpr) {
  const { cw, ch } = L;
  const c = document.createElement("canvas");
  c.width = Math.ceil(cw * dpr);
  c.height = Math.ceil(ch * dpr);
  const g = c.getContext("2d");
  g.scale(dpr, dpr);
  const { suit, rank } = cardOf(S.suits, id);
  const font = '"Segoe UI", system-ui, -apple-system, Roboto, sans-serif';
  g.beginPath();
  g.roundRect(0.5, 0.5, cw - 1, ch - 1, cw * 0.09);
  g.fillStyle = "#fff";
  g.fill();
  g.strokeStyle = "rgba(0, 0, 0, .55)";
  g.lineWidth = 1;
  g.stroke();
  g.fillStyle = suit === "H" || suit === "D" ? "#c8102e" : "#1b1b1b";
  g.textBaseline = "top";
  g.font = `700 ${Math.max(11, cw * 0.3)}px ${font}`;
  g.fillText(RANK[rank] + SYMBOL[suit], cw * 0.07, ch * 0.03);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `${cw * 0.62}px ${font}`;
  g.fillText(SYMBOL[suit], cw / 2, ch * 0.58);
  return c;
}

function celebrate(done) {
  stopCelebration();
  const dpr = devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.className = "celebration";
  canvas.width = Math.round(L.W * dpr);
  canvas.height = Math.round(L.H * dpr);
  board.append(canvas);
  const g = canvas.getContext("2d");
  g.scale(dpr, dpr);

  // Top card of each pile in turn (the Kings first), like dealing off the foundations.
  const order = [];
  for (let k = 0; k < 13; k++) S.found.forEach((run) => run[k] !== undefined && order.push(run[k]));
  const unit = L.cw / 40; // speeds below are tuned for 40 px cards at 60 fps
  const flying = [];
  let next = 0;
  let lastLaunch = -Infinity;
  let last = performance.now();
  const c = (celebration = { canvas, raf: 0, done, finished: false });

  const frame = (now) => {
    const dt = Math.min(3, (now - last) / (1000 / 60));
    last = now;
    if (next < order.length && now - lastLaunch >= LAUNCH_MS) {
      const id = order[next++];
      const p = pos[id];
      cardEls[id].hidden = true;
      // The foundation is at the bottom, so throw each card up to a random 25–75% of the table height.
      const rise = (0.25 + Math.random() * 0.5) * (p.y + L.ch);
      flying.push({ img: cardImage(id, dpr), x: p.x, y: p.y, vx: (2 + Math.random() * 5) * unit, vy: -Math.sqrt(2 * GRAVITY * unit * rise) });
      lastLaunch = now;
    }
    const floor = L.H - L.ch;
    for (let i = flying.length - 1; i >= 0; i--) {
      const f = flying[i];
      f.vy += GRAVITY * unit * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      if (f.y > floor) {
        f.y = floor;
        f.vy *= -0.75;
      }
      if (f.x > L.W) {
        flying.splice(i, 1);
        continue;
      }
      g.drawImage(f.img, f.x, f.y, L.cw, L.ch);
    }
    if (next >= order.length && !flying.length) {
      finishCelebration();
      return;
    }
    c.raf = requestAnimationFrame(frame);
  };
  c.raf = requestAnimationFrame(frame);
  canvas.addEventListener("pointerdown", finishCelebration);
}

// The animation is over (or skipped): leave the trails on screen and show the dialog.
function finishCelebration() {
  const c = celebration;
  if (!c || c.finished) return;
  c.finished = true;
  cancelAnimationFrame(c.raf);
  c.done();
}

function stopCelebration() {
  if (!celebration) return;
  cancelAnimationFrame(celebration.raf);
  celebration.canvas.remove();
  celebration = null;
  cardEls.forEach((el, id) => (el.hidden = !pos[id]));
}

function shake(ids) {
  ids.forEach((id) => {
    const el = cardEls[id];
    el.classList.remove("shake");
    void el.offsetWidth;
    el.classList.add("shake");
  });
}

let toastTimer = 0;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2500);
}

// ---------------------------------------------------------------- pointer input
// A press that moves less than DRAG_START_PX is a tap (auto-move); anything more is a drag.

let drag = null;

board.addEventListener("pointerdown", (e) => {
  if (drag || busy || won || e.button > 0) return;
  const el = e.target.closest(".card");
  if (!el) return;
  const id = +el.dataset.id;
  const l = loc[id];
  if (l.kind === "stock") {
    doDeal();
    return;
  }
  if (l.kind !== "col" || !l.up) return;
  const col = S.cols[l.col];
  const ids = col.slice(l.idx).map(idOf);
  drag = {
    pointerId: e.pointerId, from: l.col, idx: l.idx, ids,
    sx: e.clientX, sy: e.clientY, moved: false, ok: canPickUp(S, l.col, l.idx),
  };
  board.setPointerCapture(e.pointerId);
});

board.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dx = e.clientX - drag.sx;
  const dy = e.clientY - drag.sy;
  if (!drag.moved) {
    if (Math.hypot(dx, dy) < DRAG_START_PX || !drag.ok) return;
    drag.moved = true;
    drag.ids.forEach((id, i) => {
      cardEls[id].classList.add("dragging");
      cardEls[id].style.zIndex = 3000 + i;
    });
  }
  drag.dx = dx;
  drag.dy = dy;
  drag.ids.forEach((id) => {
    const p = pos[id];
    cardEls[id].style.transform = `translate(${p.x + dx}px, ${p.y + dy}px)`;
  });
});

function endDrag(e, cancelled) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = drag;
  drag = null;
  if (cancelled) {
    render();
    return;
  }
  if (!d.moved) {
    if (!d.ok) {
      shake(d.ids);
      return;
    }
    const to = autoTarget(S, d.from, d.idx);
    if (to >= 0) doMove(d.from, d.idx, to);
    else shake(d.ids);
    return;
  }
  const to = dropTarget(d);
  if (to >= 0) doMove(d.from, d.idx, to);
  else render();
}

// The legal column the dragged card overlaps most (horizontally), or -1.
function dropTarget(d) {
  const first = pos[d.ids[0]];
  const x = first.x + d.dx;
  const y = first.y + d.dy;
  let best = -1;
  let bestOverlap = 0;
  for (let c = 0; c < COLS; c++) {
    if (c === d.from || !canDrop(S, S.cols[d.from][d.idx], c)) continue;
    const overlap = L.cw - Math.abs(L.colX(c) - x);
    if (overlap > bestOverlap && y < L.tableauBottom) {
      best = c;
      bestOverlap = overlap;
    }
  }
  return best;
}

board.addEventListener("pointerup", (e) => endDrag(e, false));
board.addEventListener("pointercancel", (e) => endDrag(e, true));
board.addEventListener("contextmenu", (e) => e.preventDefault());

// ---------------------------------------------------------------- controls

$("#undo").addEventListener("click", undo);
$("#undo-all").addEventListener("click", undoAll);

const newDialog = $("#new-dialog");
$("#new").addEventListener("click", () => {
  newDialog.querySelectorAll("[data-suits]").forEach((b) => b.classList.toggle("current", +b.dataset.suits === S.suits));
  $("#winnable").checked = winnableOnly();
  newDialog.showModal();
});
newDialog.querySelectorAll("[data-suits]").forEach((b) =>
  b.addEventListener("click", () => {
    newDialog.close();
    requestGame(+b.dataset.suits);
  }),
);
$("#winnable").addEventListener("change", (e) => {
  localStorage.setItem(WINNABLE_KEY, e.target.checked ? "1" : "0");
  if (e.target.checked) prepareNext(S.suits);
});
newDialog.querySelector(".cancel").addEventListener("click", () => newDialog.close());
newDialog.addEventListener("click", (e) => { if (e.target === newDialog) newDialog.close(); });

$("#win-dialog").addEventListener("close", stopCelebration);
$("#win-new").addEventListener("click", () => {
  $("#win-dialog").close();
  requestGame(S.suits);
});

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo();
  }
});

// The clock runs while the page is visible and the game has started but isn't won.
setInterval(() => {
  if (document.hidden || won || !history.length) return;
  elapsed++;
  $("#time").textContent = formatTime(elapsed);
  if (elapsed % 5 === 0) save();
}, 1000);
document.addEventListener("visibilitychange", () => { if (document.hidden && S) save(); });

let resizeRaf = 0;
window.addEventListener("resize", () => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    finishCelebration(); // the canvas is sized for the old layout
    layout();
    render({ instant: true });
  });
});

// ---------------------------------------------------------------- version check
// VERSION (version.js) is the copy that's running; version.js fetched with no-store is
// what GitHub Pages serves now. Pages lets browsers cache files for 10 min, so a stale
// copy is common right after a deploy. The game is saved after every move, so updating
// (which reloads the page) carries on where you left off.

const APP_FILES = ["./", "index.html", "app.js", "game.js", "solver.js", "solver-worker.js", "version.js", "style.css", "manifest.webmanifest", "icon.svg"];
const VERSION_CHECK_MS = 5 * 60_000;
const versionBtn = $("#version");
let latestVersion = null;

function formatVersion(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

function setVersionState(state) {
  const labels = {
    checking: "Checking for updates…",
    ok: `Up to date (version ${formatVersion(VERSION)})`,
    stale: `Update available: running ${formatVersion(VERSION)}, latest is ${formatVersion(latestVersion)}. Tap to update.`,
    unknown: `Couldn't check for updates (offline?). Running ${formatVersion(VERSION)}.`,
    updating: "Updating…",
  };
  versionBtn.dataset.state = state;
  versionBtn.title = labels[state];
  versionBtn.setAttribute("aria-label", labels[state]);
  versionBtn.querySelector("span").textContent = state === "stale" ? "Update" : "";
}

async function checkVersion() {
  if (versionBtn.dataset.state === "updating") return;
  try {
    const res = await fetch(`version.js?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    latestVersion = (await res.text()).match(/VERSION = "([^"]+)"/)?.[1];
    if (!latestVersion) throw new Error("no version");
    // ISO timestamps compare as strings; only a newer live copy counts as an update.
    setVersionState(latestVersion > VERSION ? "stale" : "ok");
  } catch {
    setVersionState("unknown");
  }
}

versionBtn.addEventListener("click", async () => {
  const state = versionBtn.dataset.state;
  if (state !== "stale") {
    if (state === "unknown" || state === "ok") {
      toast("Checking for updates…");
      await checkVersion();
    }
    toast(versionBtn.title);
    return;
  }
  setVersionState("updating");
  if (S) save();
  // Refresh every file in the HTTP cache first; a plain reload could still use the stale copies.
  await Promise.all(APP_FILES.map((f) => fetch(f, { cache: "reload" }).catch(() => {})));
  location.reload();
});

setVersionState("checking");
checkVersion();
setInterval(checkVersion, VERSION_CHECK_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkVersion(); });
window.addEventListener("online", checkVersion);

// ---------------------------------------------------------------- start

layout();
if (load()) {
  buildCards();
  render({ instant: true });
  if (won) win({ animate: false });
  prepareNext(S.suits);
} else {
  // A blank table until the first deal arrives.
  S = { suits: +localStorage.getItem(SUITS_KEY) || 2, cols: Array.from({ length: COLS }, () => []), stock: [], found: [] };
  buildCards();
  render({ instant: true });
  requestGame(S.suits);
}

// Exposed for tests.
window.__spider = { get state() { return S; }, set state(s) { S = s; history = []; moves = 0; won = false; render({ instant: true }); }, autoTarget };
