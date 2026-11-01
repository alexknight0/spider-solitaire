// Deals random games until the solver finds a win for one, off the main thread.
// Posts { attempt } after each failed deal and { state, attempt } with the winnable one.
// The loop never yields, so the page cancels a search by terminating the worker.
import { newGame } from "./game.js";
import { solve } from "./solver.js";

onmessage = ({ data: { suits } }) => {
  for (let attempt = 1; ; attempt++) {
    const state = newGame(suits);
    if (solve(state).solved) {
      postMessage({ state, attempt });
      return;
    }
    postMessage({ attempt });
  }
};
