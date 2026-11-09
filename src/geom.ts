export type Pt = [number, number];
interface Shape { points: Pt[]; size: number }

// True if point q is within r of the stroke's line (eraser hit test).
export function hitStroke(s: Shape, q: Pt, r: number): boolean {
  const R = r + s.size / 2, p = s.points;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[i + 1] ?? a, dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l)) : 0;
    if (Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy) <= R) return true;
  }
  return false;
}

// Ray casting: is q inside the polygon (lasso loop)?
export function inPoly(poly: Pt[], q: Pt): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > q[1] !== yj > q[1] && q[0] < ((xj - xi) * (q[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// [x0, y0, x1, y1] around the strokes, with a small margin.
export function bbox(ss: Shape[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of ss) for (const [x, y] of s.points) {
    x0 = Math.min(x0, x - s.size); y0 = Math.min(y0, y - s.size); x1 = Math.max(x1, x + s.size); y1 = Math.max(y1, y + s.size);
  }
  return [x0 - 4, y0 - 4, x1 + 4, y1 + 4];
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function perp(p: Pt, a: Pt, b: Pt) {
  const l = dist(a, b);
  return l ? Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / l : dist(p, a);
}

// Douglas-Peucker: keep only the corners of a polyline.
function corners(pts: Pt[], eps: number): Pt[] {
  let best = 0, at = 0;
  for (let i = 1; i < pts.length - 1; i++) { const d = perp(pts[i], pts[0], pts[pts.length - 1]); if (d > best) { best = d; at = i; } }
  if (best <= eps) return [pts[0], pts[pts.length - 1]];
  return [...corners(pts.slice(0, at + 1), eps).slice(0, -1), ...corners(pts.slice(at), eps)];
}

// Points every `step` units along a polyline, so the drawn shape keeps sharp corners.
function densify(poly: Pt[], step = 1): Pt[] {
  const out: Pt[] = [poly[0]];
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i], n = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

// Straight line from a towards b, snapped to multiples of 45° when within 2°.
export function snapLine(a: Pt, b: Pt, angleSnap = true): Pt[] {
  const chord = dist(a, b);
  let ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const snap = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
  if (angleSnap && Math.abs(ang - snap) < (2 * Math.PI) / 180) ang = snap; // only within ±2°
  return densify([a, [a[0] + chord * Math.cos(ang), a[1] + chord * Math.sin(ang)]]);
}

// Scale by k and rotate by t radians about centre c (resizing/rotating a snapped shape).
export const scaleAbout = (pts: Pt[], c: Pt, k: number, t = 0): Pt[] => {
  const cos = Math.cos(t) * k, sin = Math.sin(t) * k;
  return pts.map(([x, y]) => [c[0] + (x - c[0]) * cos - (y - c[1]) * sin, c[1] + (x - c[0]) * sin + (y - c[1]) * cos]);
};

const DEG = Math.PI / 180;
// Snap angle t to the nearest multiple of `step` if within `tol`.
export const snapAngle = (t: number, step: number, tol: number) => {
  const s = Math.round(t / step) * step;
  return Math.abs(t - s) < tol ? s : t;
};
const angleAt = (p: Pt, q: Pt, r: Pt) => { // interior angle at q
  const a = Math.atan2(p[1] - q[1], p[0] - q[0]) - Math.atan2(r[1] - q[1], r[0] - q[0]);
  const t = Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
  return t;
};

// A 4-corner shape with near-right angles → exact rectangle (axis-aligned if close), → square if sides near-equal.
function squareUp(v: Pt[]): Pt[] {
  if (!v.every((q, i) => Math.abs(angleAt(v[(i + 3) % 4], q, v[(i + 1) % 4]) - 90 * DEG) < 12 * DEG)) return v;
  const c: Pt = [v.reduce((s, q) => s + q[0], 0) / 4, v.reduce((s, q) => s + q[1], 0) / 4];
  const th = snapAngle(Math.atan2(v[1][1] - v[0][1], v[1][0] - v[0][0]), 90 * DEG, 12 * DEG);
  let w = (dist(v[0], v[1]) + dist(v[2], v[3])) / 2, h = (dist(v[1], v[2]) + dist(v[3], v[0])) / 2;
  if (Math.abs(w - h) / Math.max(w, h) < 0.12) w = h = (w + h) / 2;
  // Keep the drawing direction (clockwise or not) so corners stay in order.
  const sgn = Math.sign((v[1][0] - v[0][0]) * (v[2][1] - v[1][1]) - (v[1][1] - v[0][1]) * (v[2][0] - v[1][0])) || 1;
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as Pt[]).map(([sx, sy]) => {
    const x = (sx * w) / 2, y = (sy * sgn * h) / 2;
    return [c[0] + x * Math.cos(th) - y * Math.sin(th), c[1] + x * Math.sin(th) + y * Math.cos(th)];
  });
}

// Near-equal sides → equilateral (flat base if close); else a near-right corner → exact 90°.
function tidyTriangle(v: Pt[]): Pt[] {
  const s = [dist(v[0], v[1]), dist(v[1], v[2]), dist(v[2], v[0])];
  if (Math.max(...s) / Math.min(...s) < 1.12) {
    const g: Pt = [(v[0][0] + v[1][0] + v[2][0]) / 3, (v[0][1] + v[1][1] + v[2][1]) / 3];
    const R = v.reduce((t, q) => t + dist(q, g), 0) / 3;
    const dir = Math.sign((v[1][0] - v[0][0]) * (v[2][1] - v[0][1]) - (v[1][1] - v[0][1]) * (v[2][0] - v[0][0])) || 1;
    const f0 = snapAngle(Math.atan2(v[0][1] - g[1], v[0][0] - g[0]) + 90 * DEG, 120 * DEG, 10 * DEG) - 90 * DEG;
    return [0, 1, 2].map((k): Pt => [g[0] + R * Math.cos(f0 + dir * k * 120 * DEG), g[1] + R * Math.sin(f0 + dir * k * 120 * DEG)]);
  }
  for (let i = 0; i < 3; i++) {
    const A = v[(i + 2) % 3], B = v[i], C = v[(i + 1) % 3];
    if (Math.abs(angleAt(A, B, C) - 90 * DEG) < 8 * DEG) {
      const ux = (A[0] - B[0]) / dist(A, B), uy = (A[1] - B[1]) / dist(A, B);
      const side = Math.sign(ux * (C[1] - B[1]) - uy * (C[0] - B[0])) || 1, L = dist(B, C);
      const out = [...v];
      out[(i + 1) % 3] = [B[0] - side * uy * L, B[1] + side * ux * L];
      return out;
    }
  }
  return v;
}

export interface Recognized { line: boolean; pts: Pt[] }

// Recognise a hand-drawn line, triangle, rectangle/quad, circle or ellipse.
// Returns the clean shape's points, or null if the stroke isn't a clear shape.
export function recognize(pts: Pt[]): Recognized | null {
  if (pts.length < 5) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const D = Math.hypot(x1 - x0, y1 - y0);
  if (D < 8) return null; // too small to be a deliberate shape
  const a = pts[0], b = pts[pts.length - 1], chord = dist(a, b);

  if (chord > 0.7 * D && Math.max(...pts.map((p) => perp(p, a, b))) < Math.max(1.5, 0.06 * chord)) return { line: true, pts: snapLine(a, b) };
  if (chord > 0.25 * D) return null; // open curve: not a shape

  // Ellipse fit (axis-aligned, from the bounding box); a near-perfect fit wins over corners.
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
  const err = pts.reduce((s, [x, y]) => s + Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1), 0) / pts.length;
  const ellipse = () => {
    if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.15) rx = ry = (rx + ry) / 2; // near-round → circle
    return Array.from({ length: 97 }, (_, i): Pt => [cx + rx * Math.cos((i * Math.PI) / 48), cy + ry * Math.sin((i * Math.PI) / 48)]);
  };
  if (err < 0.07) return { line: false, pts: ellipse() };

  // Polygon: corners, minus near-straight ones (where the stroke started mid-edge).
  let v = corners([...pts, pts[0]], 0.06 * D).slice(0, -1);
  const turn = (p: Pt, q: Pt, r: Pt) => {
    const t = Math.abs(Math.atan2(r[1] - q[1], r[0] - q[0]) - Math.atan2(q[1] - p[1], q[0] - p[0]));
    return Math.min(t, 2 * Math.PI - t);
  };
  for (let changed = true; changed && v.length > 3; ) {
    changed = false;
    for (let i = 0; i < v.length; i++) {
      if (turn(v[(i + v.length - 1) % v.length], v[i], v[(i + 1) % v.length]) < (25 * Math.PI) / 180) { v.splice(i, 1); changed = true; break; }
    }
  }
  if (v.length === 4) v = squareUp(v);
  if (v.length === 3) v = tidyTriangle(v);
  if (v.length === 3 || v.length === 4) return { line: false, pts: densify([...v, v[0]]) };
  return err < 0.12 ? { line: false, pts: ellipse() } : null;
}

export type Box = [number, number, number, number]; // x0, y0, x1, y1

// Tight bounding box of points (no margin).
export function extent(pts: Pt[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}

// Snap a box so one of its left/centre/right (and top/middle/bottom) lines meets the nearest
// matching line of a target box, if within tol. Returns the shift and the guide lines to show.
export function alignSnap(box: Box, targets: Box[], tol: number) {
  const axis = (a0: number, a1: number, ts: [number, number][]) => {
    let best: { d: number; at: number } | null = null;
    for (const v of [a0, (a0 + a1) / 2, a1]) for (const [t0, t1] of ts) for (const t of [t0, (t0 + t1) / 2, t1]) {
      if (Math.abs(t - v) <= tol && (!best || Math.abs(t - v) < Math.abs(best.d))) best = { d: t - v, at: t };
    }
    return best;
  };
  const sx = axis(box[0], box[2], targets.map((t) => [t[0], t[2]]));
  const sy = axis(box[1], box[3], targets.map((t) => [t[1], t[3]]));
  return { dx: sx?.d ?? 0, dy: sy?.d ?? 0, gx: sx?.at ?? null, gy: sy?.at ?? null };
}

// Nearest key point within tol, or null.
export function nearest(q: Pt, keys: Pt[], tol: number): Pt | null {
  let best: Pt | null = null, bd = tol;
  for (const k of keys) { const d = Math.hypot(k[0] - q[0], k[1] - q[1]); if (d <= bd) { bd = d; best = k; } }
  return best;
}
