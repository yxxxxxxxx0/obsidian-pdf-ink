import { strict as assert } from "node:assert";
import { matchPages } from "./match";

const old = ["Intro to waves", "Wave equation derivation", "Boundary conditions example"];
// New version: a slide inserted at page 2, last slide removed.
const neu = ["Intro to waves", "Admin notices for week 3", "Wave equation derivation"];
assert.deepEqual(matchPages(old, neu), [1, 3, null]);
// Scanned pages (no text) keep their page number.
assert.deepEqual(matchPages(["", ""], ["", "", ""]), [1, 2]);
console.log("match ok");
