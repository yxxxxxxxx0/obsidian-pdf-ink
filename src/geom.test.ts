import { strict as assert } from "node:assert";
import { bbox, penModel, hitStroke, inPoly, type Pt } from "./geom";

const line = { points: [[0, 0], [10, 0]] as Pt[], size: 1 };
assert(hitStroke(line, [5, 2], 2));      // near the middle of the segment
assert(!hitStroke(line, [5, 5], 2));     // too far away
assert(hitStroke(line, [12, 0], 2));     // near the end, past the last point
assert(hitStroke({ points: [[3, 3]], size: 1 }, [3, 4], 1)); // single-point dot

const sq: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
assert(inPoly(sq, [5, 5]));
assert(!inPoly(sq, [15, 5]));
assert(!inPoly([[1, 1], [2, 2]], [1.5, 1.5])); // fewer than 3 points selects nothing

const [x0, , x1] = bbox([line]);
assert(x0 < 0 && x1 > 10);
console.log("geom ok");

import { recognize, scaleAbout, snapLine } from "./geom";
const wobble = (i: number) => Math.sin(i * 1.7) * 0.6;
const ring = (n: number, f: (t: number) => Pt) => Array.from({ length: n + 1 }, (_, i) => f(i / n));
const ends = (r: Pt[] | null) => r && [r[0], r[r.length - 1]].map((p) => p.map(Math.round));

// Nearly-horizontal wobbly line → straight, snapped to horizontal.
const ln = recognize(Array.from({ length: 40 }, (_, i): Pt => [i * 2, 50 + i * 0.05 + wobble(i)]))!.pts;
assert(ln && Math.abs(ln[0][1] - ln[ln.length - 1][1]) < 0.01, "line snaps flat");

// Wobbly circle → circle (all points at the same radius).
const circ = recognize(ring(60, (t): Pt => [100 + 30 * Math.cos(t * 6.28) + wobble(t * 60), 100 + 31 * Math.sin(t * 6.28)]))!.pts;
assert(circ, "circle recognised");
const rs = circ.map(([x, y]) => Math.hypot(x - 100, y - 100));
assert(Math.max(...rs) - Math.min(...rs) < 2, "circle is round");

// Slightly tilted hand-drawn square, starting mid-edge → axis-aligned 4 corners.
const handSq = ([[50, 0], [100, 2], [101, 100], [1, 99], [0, 1], [48, 0]] as Pt[]).flatMap((p, i, arr) =>
  i ? Array.from({ length: 20 }, (_, k): Pt => [arr[i - 1][0] + ((p[0] - arr[i - 1][0]) * k) / 20, arr[i - 1][1] + ((p[1] - arr[i - 1][1]) * k) / 20]) : []);
const rect = recognize(handSq)!.pts;
assert(rect, "rectangle recognised");
// Hand square is ~100x99 → exact level square: bounding box is square and every point lies on its edge.
const [bx0, by0, bx1, by1] = [Math.min(...rect.map((p) => p[0])), Math.min(...rect.map((p) => p[1])), Math.max(...rect.map((p) => p[0])), Math.max(...rect.map((p) => p[1]))];
assert(Math.abs(bx1 - bx0 - (by1 - by0)) < 0.01, "square has equal sides");
assert(rect.every(([x, y]) => Math.min(Math.abs(x - bx0), Math.abs(x - bx1), Math.abs(y - by0), Math.abs(y - by1)) < 0.01), "square is level");

// Scribble (open, curvy) → no shape.
assert.equal(recognize(Array.from({ length: 50 }, (_, i): Pt => [i * 2, 30 * Math.sin(i / 3)])), null, "scribble ignored");
// Resizing: a line follows the pen (still snapping), shapes scale about their centre.
const fl = snapLine([0, 0], [50, 1.5]); // 1.7°: snaps
assert(Math.abs(snapLine([0, 0], [50, 3])[0][1] - snapLine([0, 0], [50, 3]).at(-1)![1]) > 1, "3° off: no snap");
assert(Math.abs(fl[fl.length - 1][1]) < 0.01 && Math.round(fl[fl.length - 1][0]) === 50, "dragged line snaps flat");
assert.deepEqual(scaleAbout([[10, 0]], [0, 0], 2), [[20, 0]]);
// Rough triangle with near-equal sides → equilateral.
const tri = ([[0, 0], [60, 2], [29, -50], [1, 1]] as Pt[]).flatMap((p, i, arr) =>
  i ? Array.from({ length: 20 }, (_, k): Pt => [arr[i - 1][0] + ((p[0] - arr[i - 1][0]) * k) / 20, arr[i - 1][1] + ((p[1] - arr[i - 1][1]) * k) / 20]) : []);
const t3 = recognize(tri)!.pts, tv = [0, 1, 2].map((i) => t3[Math.round((i * (t3.length - 1)) / 3)]);
const ts = [0, 1, 2].map((i) => Math.hypot(tv[i][0] - tv[(i + 1) % 3][0], tv[i][1] - tv[(i + 1) % 3][1]));
assert(Math.max(...ts) - Math.min(...ts) < 0.01, "equilateral");
// Rotating 90° about the origin.
const r90 = scaleAbout([[10, 0]], [0, 0], 1, Math.PI / 2)[0];
assert(Math.abs(r90[0]) < 1e-9 && Math.abs(r90[1] - 10) < 1e-9, "rotates");
// Alignment: a box 3 units right of a target's left edge snaps onto it; too far → no snap.
import { alignSnap, extent, nearest } from "./geom";
const al = alignSnap([13, 50, 33, 60], [[10, 0, 30, 20]], 5);
assert(al.dx === -3 && al.gx === 10, "left edges align");
assert(alignSnap([100, 100, 110, 110], [[0, 0, 10, 10]], 5).gx === null, "far boxes don't snap");
// Centre-to-centre: box centre 51 vs target centre 50.
assert(alignSnap([41, 200, 61, 210], [[0, 0, 100, 20]], 2).gx === 50, "centres align");
assert.deepEqual(extent([[1, 5], [3, 2]]), [1, 2, 3, 5]);
assert.deepEqual(nearest([10, 10], [[0, 0], [12, 11]], 3), [12, 11]);
console.log("shapes ok", ends(ln));

// Pen model: a straight line stays straight, the stroke ends exactly at the last point,
// and a fast right-angle turn (3 far-apart points) is rounded only slightly and drawn densely.
{
  const line = penModel([[0, 0], [30, 0]]);
  assert.ok(line.every(([, y]) => Math.abs(y) < 1e-9));
  assert.deepEqual(line[line.length - 1], [30, 0]);
  const turn = penModel([[0, 0], [20, 0], [20, 20]]);
  for (let i = 1; i < turn.length; i++) assert.ok(Math.hypot(turn[i][0] - turn[i - 1][0], turn[i][1] - turn[i - 1][1]) < 1.5);
  const cut = Math.min(...turn.map(([x, y]) => Math.hypot(x - 20, y)));
  assert.ok(cut > 0.3 && cut < 2.5, "corner rounded by " + cut);
  console.log("pen model ok, corner rounded by", cut.toFixed(2));
}
