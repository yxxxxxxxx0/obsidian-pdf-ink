import { FileView, FuzzySuggestModal, Menu, Notice, setIcon, Plugin, TFile, loadPdfJs, debounce, normalizePath } from "obsidian";
import { matchPages } from "./match";
import { BlendMode, LineCapStyle, LineJoinStyle, PDFDocument, rgb, setLineJoin } from "pdf-lib";
import { alignSnap, bbox, extent, hitStroke, inPoly, nearest, recognize, scaleAbout, snapAngle, snapLine, type Box, type Pt } from "./geom";

const VIEW_TYPE = "pdf-ink";
const HOLD_MS = 450;
const MAX_PX = 16e6; // iPad Safari blanks canvases above ~16.7M pixels
// shape: snapped, drawn exactly with no smoothing/taper. hl: highlighter, drawn translucent at `alpha` under the pen ink.
interface Stroke { points: Pt[]; color: string; size: number; shape?: boolean; hl?: boolean; alpha?: number }
// A photo placed on a page; img is the image file's path in the vault.
interface Img { img: string; x: number; y: number; w: number; h: number }
type Item = Stroke | Img;
const isImg = (it: Item): it is Img => "img" in it;
const isStroke = (it: Item): it is Stroke => !isImg(it);
const shapeOf = (it: Item) => (isImg(it) ? { points: [[it.x, it.y], [it.x + it.w, it.y + it.h]] as Pt[], size: 0 } : it);
const boxOf = (items: Item[]): Box => extent(items.flatMap((it) => shapeOf(it).points));
const clone = (it: Item): Item => (isImg(it) ? { ...it } : { ...it, points: it.points.map((q): Pt => [q[0], q[1]]) });
type Ink = Record<number, Item[]>; // page number -> items, in PDF units (zoom-independent)
interface Page { n: number; w: number; h: number; pdf: HTMLCanvasElement; img: HTMLCanvasElement; ink: HTMLCanvasElement; drawn: number }
// An undoable change: the page's item list before it. Items are never edited in place once saved (moves edit clones),
// so a shallow copy of the list is a full snapshot.
interface Edit { n: number; before: Item[] }

// Module-level so copy in one PDF and paste in another works.
let clip: Item[] = [];
const CLIP_MARK = "pdf-ink:copied-ink"; // put on the system clipboard on copy, so paste knows not to look for an image

// Writing size is per device (iPad and Mac screens differ), so it lives in localStorage, not the synced vault.
const SIZE_KEY = "pdf-ink-writing-scale";
const savedScale = () => { try { return Number(localStorage.getItem(SIZE_KEY)) || null; } catch { return null; } };
// Per-device toolbar preferences (recent colours, highlighter opacity).
const load = <T,>(k: string, d: T): T => { try { return JSON.parse(localStorage.getItem("pdf-ink-" + k) ?? "") ?? d; } catch { return d; } };
const keep = (k: string, v: unknown) => { try { localStorage.setItem("pdf-ink-" + k, JSON.stringify(v)); } catch { /* private mode: not remembered */ } };
const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const SIZE_RANGE = { pen: [0.3, 5, 0.1], highlighter: [3, 30, 1] }; // min, max, step (PDF units)

const inkPathOf = (pdfPath: string) => normalizePath(pdfPath + ".ink.json");

// Ballpoint-style ink (like GoodNotes/Notability): even width, curved through the midpoints of
// lightly smoothed Pencil points, with short tapers at the ends. Built in PDF units, so zoom never rebuilds it.
interface InkShape { mid: Path2D; d: string; ends: number[][] } // d: mid as SVG path (for export); ends: [x1, y1, x2, y2, width] tapered segments

const boxPoly = ([x0, y0, x1, y1]: number[]): Pt[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

function inkShape(pts: Pt[], size: number, taperEnd: boolean, exact = false): InkShape {
  if (exact) {
    const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join("");
    return { mid: new Path2D(d), d, ends: [] };
  }
  // Average each point with its neighbours to remove hand jitter.
  const q = pts.map(([x, y], i) => {
    const a = pts[i - 1] ?? pts[i], b = pts[i + 1] ?? pts[i];
    return [(a[0] + 2 * x + b[0]) / 4, (a[1] + 2 * y + b[1]) / 4];
  });
  const ends: number[][] = [];
  if (q.length === 1) { const dot = `M${q[0][0]} ${q[0][1]}L${q[0][0] + 0.01} ${q[0][1]}`; return { mid: new Path2D(dot), d: dot, ends }; }

  const d = [0];
  for (let i = 1; i < q.length; i++) d.push(d[i - 1] + Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]));
  const total = d[d.length - 1], T = Math.min(size * 12, total / 3);
  // Width factor at distance m along the stroke: 0.3 at the tips, 1 after T.
  // Smoothstep easing: width grows slowly from the tip and blends into full width with no visible kink.
  const ease = (t: number) => { t = Math.min(1, Math.max(0, t)); return 0.25 + 0.75 * t * t * (3 - 2 * t); };
  const f = (m: number) => Math.min(T ? ease(m / T) : 1, taperEnd && T ? ease((total - m) / T) : 1);

  let a = -1, b = -1; // first and last full-width segment
  for (let i = 0; i < q.length - 1; i++) {
    if (f(d[i]) >= 1 && f(d[i + 1]) >= 1) { if (a < 0) a = i; b = i; continue; }
    // Split tapered segments into tiny pieces so the width changes in small steps, not jumps.
    const k = Math.max(1, Math.ceil((d[i + 1] - d[i]) / (size * 0.25)));
    for (let j = 0; j < k; j++) {
      const t0 = j / k, t1 = (j + 1) / k, lerp = (t: number, c: number) => q[i][c] + (q[i + 1][c] - q[i][c]) * t;
      ends.push([lerp(t0, 0), lerp(t0, 1), lerp(t1, 0), lerp(t1, 1), f(d[i] + (d[i + 1] - d[i]) * (t0 + t1) / 2) * size]);
    }
  }
  let svg = "";
  if (a >= 0) {
    svg = `M${q[a][0]} ${q[a][1]}`;
    for (let i = a + 1; i <= b; i++) svg += `Q${q[i][0]} ${q[i][1]} ${(q[i][0] + q[i + 1][0]) / 2} ${(q[i][1] + q[i + 1][1]) / 2}`;
    svg += `L${q[b + 1][0]} ${q[b + 1][1]}`;
  }
  return { mid: new Path2D(svg), d: svg, ends };
}

async function pageTexts(doc: any): Promise<string[]> {
  const out: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const tc = await (await doc.getPage(n)).getTextContent();
    out.push(tc.items.map((i: any) => i.str).join(" "));
  }
  return out;
}

class InkView extends FileView {
  ink: Ink = {};
  tool: "pen" | "highlighter" | "eraser" | "lasso" = "pen";
  undos: Edit[] = []; // this session only (not saved)
  redos: Edit[] = [];
  sel?: { p: Page; items: Item[] }; // lasso selection
  lasso?: { p: Page; pts: Pt[] }; // lasso loop being drawn
  guides?: { p: Page; x: number | null; y: number | null; pt?: Pt }; // alignment guides shown while dragging
  dirty = false; // only write when this device changed something, so a stale tab can't overwrite newer ink
  canSave = false;
  scale = 1;
  color = { pen: "#1a1a1a", highlighter: "#ffd400" };
  size = { pen: load("size-pen", 1.3), highlighter: load("size-highlighter", 10) };
  imgs = new Map<string, HTMLImageElement>();
  recent: string[] = load("recent", ["#1a1a1a", "#1f5bd6", "#d62828"]);
  hlAlpha: number = load("hl-alpha", 0.35);
  bar!: HTMLElement;
  sizes: { w: number; h: number }[] = [];
  pages: Page[] = [];
  paths = new WeakMap<Stroke, InkShape>();
  doc: any;
  scroller!: HTMLElement;
  stack!: HTMLElement; // holds the pages; scaled with CSS during a pinch
  observer?: IntersectionObserver;
  save = debounce(() => this.writeInk(), 600, true);

  onload() { super.onload(); this.registerDomEvent(document, "paste", (e) => this.onPaste(e)); }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return this.file ? `✏️ ${this.file.basename}` : "PDF Ink"; }

  async onLoadFile(file: TFile) {
    this.contentEl.empty();
    this.contentEl.addClass("pdf-ink");
    this.bar = this.contentEl.createDiv("pdf-ink-bar");
    this.toolbar();
    this.scroller = this.contentEl.createDiv("pdf-ink-scroll");
    this.bindPinch();
    this.undos = [];
    this.redos = [];
    this.dirty = this.canSave = false;

    try {
      this.ink = await this.readInk(file.path);
      this.canSave = true;
    } catch (e) {
      this.ink = {};
      new Notice("PDF Ink: the saved drawing file is damaged, so saving is off to protect it.");
      console.error(e);
    }

    try {
      const pdfjs = await loadPdfJs();
      this.doc = await pdfjs.getDocument({ data: await this.app.vault.readBinary(file) }).promise;
      this.sizes = [];
      for (let n = 1; n <= this.doc.numPages; n++) {
        const vp = (await this.doc.getPage(n)).getViewport({ scale: 1 });
        this.sizes.push({ w: vp.width, h: vp.height });
      }
    } catch (e) {
      new Notice("PDF Ink: couldn't open this PDF.");
      console.error(e);
      return;
    }
    // Open at the calibrated writing size, so the page is the same size in split screen as full screen.
    this.scale = savedScale() ?? this.fitScale();
    this.layout();
  }

  async onUnloadFile() {
    await this.writeInk();
    this.imgs.forEach((im) => URL.revokeObjectURL(im.src));
    this.imgs.clear();
    this.observer?.disconnect();
    this.doc?.destroy();
  }

  async readInk(pdfPath: string): Promise<Ink> {
    const a = this.app.vault.adapter, p = inkPathOf(pdfPath);
    return (await a.exists(p)) ? JSON.parse(await a.read(p)) : {};
  }

  async writeInk() {
    if (!this.file || !this.dirty || !this.canSave) return;
    try {
      await this.app.vault.adapter.write(inkPathOf(this.file.path), JSON.stringify(this.ink));
      this.dirty = false;
    } catch (e) {
      new Notice("PDF Ink: couldn't save your drawing!");
      console.error(e);
    }
  }

  changed() { this.dirty = true; this.save(); }

  // Rebuilt on every change: tiny, and keeps active states simple.
  toolbar() {
    const bar = this.bar;
    bar.empty();
    const btn = (icon: string, label: string, on: () => void, active = false) => {
      const b = bar.createDiv({ cls: "clickable-icon pdf-ink-btn", attr: { "aria-label": label } });
      setIcon(b, icon);
      b.toggleClass("is-active", active);
      b.onclick = on;
      return b;
    };
    const sep = () => bar.createDiv("pdf-ink-sep");
    const setTool = (t: InkView["tool"]) => { this.tool = t; this.sel = undefined; this.pages.forEach((q) => this.redrawInk(q)); this.toolbar(); };

    btn("pen", "Pen", () => setTool("pen"), this.tool === "pen");
    btn("highlighter", "Highlighter", () => setTool("highlighter"), this.tool === "highlighter");
    btn("eraser", "Eraser", () => setTool("eraser"), this.tool === "eraser");
    btn("lasso", "Lasso select", () => setTool("lasso"), this.tool === "lasso");

    const ink = this.tool === "highlighter" ? "highlighter" : this.tool === "pen" ? "pen" : null;
    if (ink) {
      sep();
      for (const c of this.recent) {
        const sw = bar.createDiv({ cls: "pdf-ink-swatch", attr: { "aria-label": c } });
        sw.style.background = c;
        sw.toggleClass("is-active", c === this.color[ink]);
        sw.onclick = () => this.useColor(c);
      }
      btn("plus", "More colours", () => this.colorPicker());
      sep();
      const [mn, mx, st] = SIZE_RANGE[ink];
      const dot = bar.createDiv("pdf-ink-dot");
      const showDot = () => { const d = 3 + (15 * (this.size[ink] - mn)) / (mx - mn); dot.style.cssText = `width:${d}px;height:${d}px;background:${this.color[ink]}`; };
      showDot();
      this.slider("Size", mn, mx, st, this.size[ink], (v) => v.toFixed(st < 1 ? 1 : 0), (v) => { this.size[ink] = v; keep("size-" + ink, v); showDot(); });
      if (ink === "highlighter") this.slider("Opacity", 10, 90, 1, Math.round(this.hlAlpha * 100), (v) => `${v}%`, (v) => { this.hlAlpha = v / 100; keep("hl-alpha", this.hlAlpha); });
    }
    sep();
    btn("undo-2", "Undo", () => this.undo()).toggleClass("is-disabled", !this.undos.length);
    btn("redo-2", "Redo", () => this.redo()).toggleClass("is-disabled", !this.redos.length);
    sep();
    if (this.tool === "lasso") {
      btn("scissors", "Cut", () => this.cutSel());
      btn("copy", "Copy", () => this.copySel());
      btn("trash-2", "Delete selection", () => this.deleteSel());
    }
    btn("clipboard-paste", "Paste (photo or copied ink)", () => this.pasteButton());
    btn("image-plus", "Insert photo", () => this.pickImage());

    bar.createDiv("pdf-ink-spacer");
    btn("zoom-out", "Zoom out", () => this.setScale(this.scale / 1.1));
    btn("zoom-in", "Zoom in", () => this.setScale(this.scale * 1.1));
    btn("more-horizontal", "More", () => {}).onclick = (e) => {
      const m = new Menu();
      m.addItem((i) => i.setTitle("Fit width").setIcon("maximize-2").onClick(() => this.setScale(this.fitScale())));
      m.addItem((i) => i.setTitle("Go to writing size").setIcon("ruler").onClick(() => {
        const s = savedScale();
        if (s) this.setScale(s); else new Notice("PDF Ink: no writing size yet. Zoom until writing feels right, then use “Set writing size”.");
      }));
      m.addItem((i) => i.setTitle("Set writing size").setIcon("pin").onClick(() => {
        try { localStorage.setItem(SIZE_KEY, String(this.scale)); new Notice(`PDF Ink: writing size saved (${Math.round(this.scale * 100)}%).`); }
        catch { new Notice("PDF Ink: couldn't save the writing size on this device."); }
      }));
      m.addSeparator();
      m.addItem((i) => i.setTitle("Export PDF with ink").setIcon("download").onClick(() => this.exportPdf()));
      m.addItem((i) => i.setTitle("Import ink from another PDF…").setIcon("file-input").onClick(() => this.pickSource()));
      m.showAtMouseEvent(e);
    };
  }

  slider(label: string, min: number, max: number, step: number, val: number, fmt: (v: number) => string, on: (v: number) => void) {
    const r = this.bar.createEl("input", { type: "range", cls: "pdf-ink-range", attr: { min: String(min), max: String(max), step: String(step), "aria-label": label } });
    r.value = String(val);
    const lab = this.bar.createSpan({ cls: "pdf-ink-range-label", text: fmt(val) });
    r.oninput = () => { lab.setText(fmt(+r.value)); on(+r.value); };
  }

  // Use a colour for the current pen/highlighter and move it to the front of the 3 recent colours.
  useColor(c: string) {
    const ink = this.tool === "highlighter" ? "highlighter" : "pen";
    this.color[ink] = c;
    this.recent = [c, ...this.recent.filter((x) => x !== c)].slice(0, 3);
    keep("recent", this.recent);
    this.toolbar();
  }

  // Popover with the system colour picker (any colour) and a hex code field.
  colorPicker() {
    this.contentEl.querySelector(".pdf-ink-pop")?.remove();
    const pop = this.contentEl.createDiv("pdf-ink-pop");
    const cur = this.color[this.tool === "highlighter" ? "highlighter" : "pen"];
    const wheel = pop.createEl("input", { type: "color", attr: { "aria-label": "Pick any colour" } });
    wheel.value = cur;
    const hex = pop.createEl("input", { type: "text", placeholder: "#1f5bd6", attr: { "aria-label": "Colour code", maxlength: "7" } });
    hex.value = cur;
    const done = (c: string) => { this.useColor(c); pop.remove(); };
    wheel.onchange = () => done(wheel.value);
    const apply = () => {
      const m = hex.value.trim().match(HEX);
      if (!m) return hex.addClass("is-invalid");
      let v = m[1].toLowerCase();
      if (v.length === 3) v = [...v].map((x) => x + x).join("");
      done("#" + v);
    };
    hex.onkeydown = (e) => { if (e.key === "Enter") apply(); };
    pop.createEl("button", { text: "Use", cls: "mod-cta" }).onclick = apply;
    pop.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Close" } }, (x) => { setIcon(x, "x"); x.onclick = () => pop.remove(); });
  }

  // Synchronous on purpose: page sizes are cached, so overlapping zoom taps can't interleave.
  layout() {
    this.scroller.empty();
    this.stack = this.scroller.createDiv("pdf-ink-stack");
    this.observer?.disconnect();
    this.pages = [];
    this.sel = this.lasso = undefined;
    this.observer = new IntersectionObserver((es) => es.forEach((e) => {
      const p = this.pages[+(e.target as HTMLElement).dataset.n! - 1];
      if (e.isIntersecting) this.renderPage(p);
      else for (const c of [p.pdf, p.img, p.ink]) { c.width = c.height = 0; p.drawn = 0; } // free iPad canvas memory
    }), { root: this.scroller, rootMargin: "800px" });
    this.sizes.forEach(({ w, h }, i) => {
      const el = this.stack.createDiv({ cls: "pdf-ink-page", attr: { "data-n": String(i + 1) } });
      el.style.width = `${w * this.scale}px`;
      el.style.height = `${h * this.scale}px`;
      const page = { n: i + 1, w, h, pdf: el.createEl("canvas"), img: el.createEl("canvas"), ink: el.createEl("canvas"), drawn: 0 };
      this.pages.push(page);
      this.bindPen(page);
      this.observer!.observe(el);
    });
  }

  // Two-finger pinch: CSS-scale the pages live (cheap), then re-render sharp at the new zoom on release.
  bindPinch() {
    let d0 = 0, k = 1, f: Pt = [0, 0];
    const fingers = (e: TouchEvent) => Array.from(e.touches).filter((t) => (t as any).touchType !== "stylus");
    const gap = (t: Touch[]) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    this.scroller.addEventListener("touchstart", (e) => {
      const t = fingers(e);
      if (t.length !== 2) return;
      d0 = gap(t); k = 1;
      const r = this.scroller.getBoundingClientRect();
      f = [(t[0].clientX + t[1].clientX) / 2 - r.left, (t[0].clientY + t[1].clientY) / 2 - r.top]; // focus, in the scroller's box
      this.stack.style.transformOrigin = `${this.scroller.scrollLeft + f[0]}px ${this.scroller.scrollTop + f[1]}px`;
    }, { passive: true });
    this.scroller.addEventListener("touchmove", (e) => {
      const t = fingers(e);
      if (!d0 || t.length !== 2) return;
      e.preventDefault(); // stop the scroll from fighting the pinch
      k = Math.min(5 / this.scale, Math.max(0.3 / this.scale, gap(t) / d0));
      this.stack.style.transform = `scale(${k})`;
    }, { passive: false });
    const end = (e: TouchEvent) => {
      if (!d0 || fingers(e).length >= 2) return;
      d0 = 0;
      this.stack.style.transform = "";
      if (Math.abs(k - 1) > 0.01) this.zoomAt(this.scale * k, f);
    };
    this.scroller.addEventListener("touchend", end);
    this.scroller.addEventListener("touchcancel", end);
  }

  // Zoom keeping the content under point f (in the scroller's box) in place.
  zoomAt(s: number, f: Pt) {
    const old = this.scale, x = this.scroller.scrollLeft + f[0], y = this.scroller.scrollTop + f[1];
    this.scale = Math.min(5, Math.max(0.3, s));
    this.layout();
    const k = this.scale / old;
    this.scroller.scrollLeft = x * k - f[0];
    this.scroller.scrollTop = y * k - f[1];
  }

  fitScale() { return (this.scroller.clientWidth - 24) / this.sizes[0].w || 1; }

  setScale(s: number) {
    const ratio = this.scroller.scrollTop / this.scroller.scrollHeight;
    this.scale = Math.min(5, Math.max(0.3, s));
    this.layout();
    this.scroller.scrollTop = ratio * this.scroller.scrollHeight;
  }

  // Pixels per PDF unit for a page, capped so the canvas stays under the iPad limit.
  res(p: Page) {
    const r = this.scale * (window.devicePixelRatio || 1);
    return Math.min(r, Math.sqrt(MAX_PX / (p.w * p.h)));
  }

  async renderPage(p: Page) {
    if (p.drawn === this.scale) return;
    p.drawn = this.scale;
    const r = this.res(p);
    for (const c of [p.pdf, p.img, p.ink]) { c.width = Math.floor(p.w * r); c.height = Math.floor(p.h * r); }
    const page = await this.doc.getPage(p.n);
    try {
      await page.render({ canvasContext: p.pdf.getContext("2d")!, viewport: page.getViewport({ scale: r }) }).promise;
    } catch { p.drawn = 0; return; } // page was scrolled away or re-laid out mid-render
    this.redrawInk(p);
  }

  redrawInk(p: Page, live?: Stroke) {
    if (!p.drawn) return;
    const r = this.res(p);
    // Photos on their own layer under the ink (the ink layer multiplies, which would make photos see-through).
    const ic = p.img.getContext("2d")!;
    ic.setTransform(1, 0, 0, 1, 0, 0);
    ic.clearRect(0, 0, p.img.width, p.img.height);
    ic.setTransform(r, 0, 0, r, 0, 0);
    for (const it of (this.ink[p.n] ?? []).filter(isImg)) {
      const im = this.image(it.img);
      if (im.complete && im.naturalWidth) ic.drawImage(im, it.x, it.y, it.w, it.h);
      else { ic.fillStyle = "#eee"; ic.fillRect(it.x, it.y, it.w, it.h); } // loading, or the file is missing
    }
    const ctx = p.ink.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, p.ink.width, p.ink.height);
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.lineCap = ctx.lineJoin = "round";
    const all = [...(this.ink[p.n] ?? []).filter(isStroke), ...(live ? [live] : [])];
    // Highlighter under pen ink; it's drawn as one path, so overlaps within a stroke don't darken.
    for (const st of [...all.filter((x) => x.hl), ...all.filter((x) => !x.hl)]) {
      let sh = st === live ? undefined : this.paths.get(st);
      // The end taper only appears once the Pencil lifts, so the tip doesn't shrink while writing.
      if (!sh) { sh = inkShape(st.points, st.size, st !== live, st.shape || st.hl); if (st !== live) this.paths.set(st, sh); }
      ctx.strokeStyle = st.color;
      ctx.globalAlpha = st.hl ? st.alpha ?? 0.35 : 1;
      ctx.lineWidth = st.size;
      ctx.stroke(sh.mid);
      for (const [x1, y1, x2, y2, w] of sh.ends) {
        ctx.lineWidth = w;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([6 / this.scale, 4 / this.scale]);
    ctx.lineWidth = 1.5 / this.scale;
    ctx.strokeStyle = "#1f5bd6";
    if (this.sel?.p === p) {
      const [x0, y0, x1, y1] = this.selBox()!;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.setLineDash([]);
      // Resize handles on all four corners.
      for (const [hx, hy] of boxPoly([x0, y0, x1, y1])) {
        ctx.beginPath(); ctx.arc(hx, hy, 7 / this.scale, 0, 2 * Math.PI);
        ctx.fillStyle = "#fff"; ctx.fill();
        ctx.lineWidth = 2 / this.scale; ctx.strokeStyle = "#1f5bd6"; ctx.stroke();
      }
    }
    if (this.guides?.p === p) {
      const g = this.guides;
      ctx.strokeStyle = "#e0368c";
      ctx.lineWidth = 0.6 / this.scale; // hairline guide
      ctx.beginPath();
      if (g.x !== null) { ctx.moveTo(g.x, 0); ctx.lineTo(g.x, p.h); }
      if (g.y !== null) { ctx.moveTo(0, g.y); ctx.lineTo(p.w, g.y); }
      ctx.stroke();
      if (g.pt) { ctx.setLineDash([]); ctx.beginPath(); ctx.arc(g.pt[0], g.pt[1], 5 / this.scale, 0, 2 * Math.PI); ctx.stroke(); }
      ctx.strokeStyle = "#1f5bd6";
    }
    if (this.lasso?.p === p) {
      ctx.beginPath();
      this.lasso.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  bindPen(p: Page) {
    const c = p.ink;
    let mode: "draw" | "erase" | "lasso" | "move" | "scale" | null = null;
    let cur: Stroke | null = null, before: Edit = { n: p.n, before: [] }, count = 0, moved = false;
    let base: Item[] = [], origin: Pt = [0, 0], d0 = 1; // selection resize
    let start: Pt = [0, 0], startBox: Box = [0, 0, 0, 0], applied: Pt = [0, 0], targets: Box[] = []; // move + align
    // Hold-to-snap: if the Pencil stays still for HOLD_MS while drawing, replace the stroke with a clean shape.
    let hold = 0, still: Pt = [0, 0];
    // After snapping, keep the Pencil down to resize: lines follow the pen, shapes scale about their centre.
    let snap: { line: boolean; base: Pt[]; c: Pt; r0: number; a0: number; keys: Pt[] } | null = null;
    const arm = (q: Pt) => {
      still = q;
      window.clearTimeout(hold);
      hold = window.setTimeout(() => {
        const shape = mode === "draw" && cur && !cur.shape && recognize(cur.points);
        if (!shape) return;
        const [x0, y0, x1, y1] = bbox([{ points: shape.pts, size: 0 }]);
        const c: Pt = [(x0 + x1) / 2, (y0 + y1) / 2];
        snap = { line: shape.line, base: shape.pts, c, r0: Math.max(1, Math.hypot(still[0] - c[0], still[1] - c[1])), a0: Math.atan2(still[1] - c[1], still[0] - c[0]), keys: shape.line ? this.keyPoints(p) : [] };
        cur!.points = shape.pts; cur!.shape = true;
        this.redrawInk(p, cur!);
      }, HOLD_MS);
    };
    // Pencil must not scroll; fingers still scroll and pinch.
    const stopStylus = (e: TouchEvent) => { if ((e.touches[0] as any)?.touchType === "stylus") e.preventDefault(); };
    c.addEventListener("touchstart", stopStylus, { passive: false });
    c.addEventListener("touchmove", stopStylus, { passive: false });
    const pt = (e: PointerEvent): Pt => {
      const r = c.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * p.w, ((e.clientY - r.top) / r.height) * p.h];
    };
    c.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") return; // palm/finger: ignore
      c.setPointerCapture(e.pointerId);
      const q = pt(e);
      before = this.snap(p);
      count = this.ink[p.n]?.length ?? 0;
      if (this.tool === "pen" || this.tool === "highlighter") {
        const t = this.tool;
        mode = "draw";
        cur = { points: [q], color: this.color[t], size: this.size[t] };
        if (t === "highlighter") { cur.hl = true; cur.alpha = this.hlAlpha; }
        arm(q);
      }
      else if (this.tool === "eraser") { mode = "erase"; this.erase(p, q); }
      else if (this.sel?.p === p && this.corner(q) >= 0) {
        const [x0, y0, x1, y1] = this.selBox()!, i = this.corner(q);
        origin = [i === 0 || i === 3 ? x1 : x0, i < 2 ? y1 : y0]; // opposite corner stays put
        mode = "scale"; this.detach(); base = this.sel.items.map(clone);
        d0 = Math.max(1, Math.hypot(q[0] - origin[0], q[1] - origin[1])); moved = false;
      }
      else if (this.sel?.p === p && inPoly(boxPoly(this.selBox()!), q)) {
        mode = "move"; this.detach(); moved = false;
        start = q; startBox = boxOf(this.sel.items); applied = [0, 0]; targets = this.targets(p, this.sel.items);
      }
      else {
        const old = this.sel?.p;
        this.sel = undefined;
        if (old && old !== p) this.redrawInk(old);
        mode = "lasso";
        this.lasso = { p, pts: [q] };
      }
    });
    c.addEventListener("pointermove", (e) => {
      if (!mode) return;
      for (const ce of e.getCoalescedEvents?.() ?? [e]) {
        const q = pt(ce);
        if (mode === "draw") {
          if (snap) {
            const dx = q[0] - snap.c[0], dy = q[1] - snap.c[1];
            // Rotation clicks to multiples of 45° when within 5°.
            const rot = snapAngle(Math.atan2(dy, dx) - snap.a0, Math.PI / 4, (5 * Math.PI) / 180);
            // A line end jumps onto a nearby corner/centre/end of something else (beats angle snapping).
            const key = snap.line ? nearest(q, snap.keys, 8 / this.scale) : null;
            this.guides = key ? { p, x: null, y: null, pt: key } : undefined;
            cur!.points = snap.line ? snapLine(snap.base[0], key ?? q, !key) : scaleAbout(snap.base, snap.c, Math.hypot(dx, dy) / snap.r0, rot);
            continue;
          }
          cur!.points.push(q);
          if (Math.hypot(q[0] - still[0], q[1] - still[1]) > 3 / this.scale) arm(q); // moved >3 screen px: restart the hold timer
        }
        else if (mode === "erase") this.erase(p, q);
        else if (mode === "lasso") this.lasso!.pts.push(q);
        else if (mode === "move") {
          const rx = q[0] - start[0], ry = q[1] - start[1];
          const a = alignSnap([startBox[0] + rx, startBox[1] + ry, startBox[2] + rx, startBox[3] + ry], targets, 6 / this.scale);
          const want: Pt = [rx + a.dx, ry + a.dy];
          this.shift(this.sel!.items, want[0] - applied[0], want[1] - applied[1]);
          applied = want;
          moved ||= want[0] !== 0 || want[1] !== 0;
          this.guides = a.gx !== null || a.gy !== null ? { p, x: a.gx, y: a.gy } : undefined;
        } else {
          // Resize from the top-left corner; line widths stay the same.
          const k = Math.max(0.05, Math.hypot(q[0] - origin[0], q[1] - origin[1]) / d0);
          const sc = (v: number, o: number) => o + (v - o) * k;
          this.sel!.items.forEach((it, i) => {
            const b = base[i];
            if (isImg(it) && isImg(b)) Object.assign(it, { x: sc(b.x, origin[0]), y: sc(b.y, origin[1]), w: b.w * k, h: b.h * k });
            else if (!isImg(it) && !isImg(b)) { it.points = scaleAbout(b.points, origin, k); this.paths.delete(it); }
          });
          moved = true;
        }
      }
      this.redrawInk(p, cur ?? undefined);
    });
    const end = () => {
      window.clearTimeout(hold);
      snap = null;
      this.guides = undefined;
      if (!mode) return;
      let edited = true;
      if (mode === "draw") (this.ink[p.n] ??= []).push(cur!);
      else if (mode === "erase") edited = (this.ink[p.n]?.length ?? 0) < count;
      else if (mode === "lasso") { edited = false; this.select(p); }
      else edited = moved;
      mode = null; cur = null;
      if (edited) this.record(before); else this.redrawInk(p);
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
  }

  snap(p: Page): Edit { return { n: p.n, before: [...(this.ink[p.n] ?? [])] }; }

  // Commit an action: it can be undone, and any redo history is dropped.
  record(e: Edit) {
    this.undos.push(e);
    this.redos = [];
    this.redrawInk(this.pages[e.n - 1]);
    this.changed();
    this.toolbar();
  }

  step(from: Edit[], to: Edit[]) {
    const e = from.pop();
    if (!e) return;
    to.push(this.snap(this.pages[e.n - 1]));
    this.ink[e.n] = e.before;
    this.sel = undefined;
    this.redrawInk(this.pages[e.n - 1]);
    this.changed();
    this.toolbar();
  }
  undo() { this.step(this.undos, this.redos); }
  redo() { this.step(this.redos, this.undos); }

  // shortcut: erases when the eraser circle touches any stroke point-by-point; a very fast swipe could skip a thin stroke.
  erase(p: Page, q: Pt) {
    const r = 10 / this.scale; // ~10 screen px; photos are never erased, use lasso + delete
    this.ink[p.n] = (this.ink[p.n] ?? []).filter((s) => isImg(s) || !hitStroke(s, q, r));
  }

  // Select anything the lasso loop touches: a stroke with any point inside, a photo overlapping the loop.
  select(p: Page) {
    const poly = this.lasso!.pts;
    this.lasso = undefined;
    const inside = (it: Item) => isImg(it)
      ? [...boxPoly([it.x, it.y, it.x + it.w, it.y + it.h]), [it.x + it.w / 2, it.y + it.h / 2] as Pt].some((q) => inPoly(poly, q))
        || poly.some(([x, y]) => x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h)
      : it.points.some((q) => inPoly(poly, q));
    const list = this.ink[p.n] ?? [];
    let items: Item[];
    if (poly.every((q) => Math.hypot(q[0] - poly[0][0], q[1] - poly[0][1]) < 8 / this.scale)) {
      // A tap, not a loop: pick the top item under the Pencil (ink above photos).
      const q = poly[0];
      const hit = [...list].reverse().find((it) => !isImg(it) && hitStroke(it, q, 8 / this.scale))
        ?? [...list].reverse().find((it) => isImg(it) && q[0] >= it.x && q[0] <= it.x + it.w && q[1] >= it.y && q[1] <= it.y + it.h);
      items = hit ? [hit] : [];
    } else items = poly.length < 3 ? [] : list.filter(inside);
    this.sel = items.length ? { p, items } : undefined;
    this.redrawInk(p);
  }

  // Lines other things can align to: every other item's box, plus the page itself (edges and centre).
  targets(p: Page, skip: Item[]): Box[] {
    return [[0, 0, p.w, p.h], ...(this.ink[p.n] ?? []).filter((it) => !skip.includes(it)).map((it) => boxOf([it]))];
  }

  // Points a line end can snap onto: other items' corners and centres, and stroke ends.
  keyPoints(p: Page): Pt[] {
    return (this.ink[p.n] ?? []).flatMap((it) => {
      const [x0, y0, x1, y1] = boxOf([it]);
      const ks: Pt[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [(x0 + x1) / 2, (y0 + y1) / 2]];
      if (!isImg(it)) ks.push(it.points[0], it.points[it.points.length - 1]);
      return ks;
    });
  }

  selBox() { return this.sel && bbox(this.sel.items.map(shapeOf)); }

  // Index of the selection corner handle under q (TL, TR, BR, BL), or -1.
  corner(q: Pt) { return boxPoly(this.selBox()!).findIndex(([x, y]) => Math.hypot(q[0] - x, q[1] - y) < 18 / this.scale); }

  // Swap the selected items for copies before moving/resizing them, so the undo snapshot keeps the originals.
  detach() {
    const s = this.sel!, copies = s.items.map(clone);
    this.ink[s.p.n] = (this.ink[s.p.n] ?? []).map((it) => { const i = s.items.indexOf(it); return i < 0 ? it : copies[i]; });
    s.items = copies;
  }

  shift(items: Item[], dx: number, dy: number) {
    for (const it of items) {
      if (isImg(it)) { it.x += dx; it.y += dy; }
      else { for (const q of it.points) { q[0] += dx; q[1] += dy; } this.paths.delete(it); }
    }
  }

  // shortcut: a deleted photo's file stays in the vault's attachments folder; delete it by hand if unwanted.
  deleteSel() {
    const s = this.sel;
    if (!s) return;
    const e = this.snap(s.p);
    this.ink[s.p.n] = this.ink[s.p.n].filter((x) => !s.items.includes(x));
    this.sel = undefined;
    this.record(e);
  }

  copySel() {
    if (!this.sel) return new Notice("PDF Ink: lasso something first.");
    clip = this.sel.items.map(clone);
    navigator.clipboard?.writeText(CLIP_MARK).catch(() => {});
    new Notice(`PDF Ink: copied ${clip.length} item${clip.length === 1 ? "" : "s"}.`);
  }

  cutSel() {
    if (!this.sel) return new Notice("PDF Ink: lasso something first.");
    this.copySel();
    this.deleteSel();
  }

  // The page at the middle of the screen, and that point in page units: where pasted things land.
  viewCentre(): [Page, Pt] {
    const r = this.scroller.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let best = this.pages[0], gap = Infinity;
    for (const q of this.pages) {
      const b = q.ink.getBoundingClientRect(), g = cy < b.top ? b.top - cy : cy > b.bottom ? cy - b.bottom : 0;
      if (g < gap) { gap = g; best = q; }
    }
    const b = best.ink.getBoundingClientRect(), cl = (v: number, m: number) => Math.min(m, Math.max(0, v));
    return [best, [cl(((cx - b.left) / b.width) * best.w, best.w), cl(((cy - b.top) / b.height) * best.h, best.h)]];
  }

  // Add items centred on the screen, then select them (lasso tool) so they can be moved or resized at once.
  place(items: Item[]) {
    const [p, c] = this.viewCentre();
    const [x0, y0, x1, y1] = bbox(items.map(shapeOf));
    this.shift(items, c[0] - (x0 + x1) / 2, c[1] - (y0 + y1) / 2);
    const e = this.snap(p);
    (this.ink[p.n] ??= []).push(...items);
    this.tool = "lasso";
    this.sel = { p, items };
    this.record(e);
  }

  pasteInk() {
    if (!clip.length) return new Notice("PDF Ink: nothing to paste. Copy ink with the lasso, or copy a photo first.");
    this.place(clip.map(clone));
  }

  // Toolbar paste: a photo on the system clipboard wins, unless the last thing copied was our own ink.
  async pasteButton() {
    try {
      for (const it of await navigator.clipboard.read()) {
        const t = it.types.find((x) => x.startsWith("image/"));
        if (t) return this.insertImage(await it.getType(t));
      }
    } catch { /* clipboard read refused or unsupported: fall back to copied ink */ }
    this.pasteInk();
  }

  // Keyboard paste (Cmd+V), only while this view is the active one.
  onPaste(e: ClipboardEvent) {
    if (this.app.workspace.getActiveViewOfType(InkView) !== this) return;
    const f = Array.from(e.clipboardData?.files ?? []).find((x) => x.type.startsWith("image/"));
    e.preventDefault();
    if (f) this.insertImage(f); else this.pasteInk();
  }

  pickImage() {
    // Must be in the page: iPad Safari drops the change event of a detached file input.
    const inp = this.contentEl.createEl("input", { type: "file", cls: "pdf-ink-file", attr: { accept: "image/*" } });
    inp.onchange = () => { const f = inp.files?.[0]; inp.remove(); if (f) this.insertImage(f); };
    inp.click();
  }

  // Save the photo as a vault attachment (so it syncs) and place it on the page.
  async insertImage(blob: Blob) {
    if (!this.file || !this.canSave) return new Notice("PDF Ink: saving is off for this file, so photos can't be added.");
    try {
      // Re-encode (iPad photos are often HEIC, which other devices can't show) and cap at 2048px to keep files small.
      const bmp = await createImageBitmap(blob);
      const z = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
      const cv = createEl("canvas");
      cv.width = Math.round(bmp.width * z); cv.height = Math.round(bmp.height * z);
      cv.getContext("2d")!.drawImage(bmp, 0, 0, cv.width, cv.height);
      bmp.close();
      const png = blob.type === "image/png" || blob.type === "image/gif"; // keep transparency
      const out = await new Promise<Blob | null>((r) => cv.toBlob(r, png ? "image/png" : "image/jpeg", 0.9));
      if (!out) throw new Error("image encode failed");
      const path = await this.app.fileManager.getAvailablePathForAttachment(`Pasted image ${Date.now()}.${png ? "png" : "jpg"}`, this.file.path);
      await this.app.vault.createBinary(path, await out.arrayBuffer());
      const [p] = this.viewCentre();
      const k = Math.min((0.6 * p.w) / cv.width, (0.6 * p.h) / cv.height); // 60% of the page at most
      this.place([{ img: path, x: 0, y: 0, w: cv.width * Math.min(1, k), h: cv.height * Math.min(1, k) }]);
    } catch (err) {
      new Notice("PDF Ink: couldn't add that photo.");
      console.error(err);
    }
  }

  image(path: string) {
    let im = this.imgs.get(path);
    if (!im) {
      // Load from the file's bytes: resource URLs aren't reliably drawable on the iPad.
      const el = (im = new Image());
      el.onload = () => this.pages.forEach((q) => this.redrawInk(q));
      this.imgs.set(path, el);
      this.app.vault.adapter.readBinary(path)
        .then((b) => { el.src = URL.createObjectURL(new Blob([b])); })
        .catch((e) => console.error("PDF Ink: missing photo", path, e));
    }
    return im;
  }

  // Write "<name> (annotated).pdf" next to the original: ink as vector lines (sharp, text stays selectable) plus photos.
  async exportPdf() {
    if (!this.file) return;
    await this.writeInk();
    const notice = new Notice("PDF Ink: exporting…", 0);
    try {
      const pdf = await PDFDocument.load(await this.app.vault.readBinary(this.file), { ignoreEncryption: true });
      const pages = pdf.getPages();
      const rgbOf = (h: string) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
      for (const [k, items] of Object.entries(this.ink)) {
        const page = pages[+k - 1];
        if (!page || !items.length) continue;
        // shortcut: assumes the page isn't rotated in the PDF's own settings (true for normal slides/notes); rotated pages would come out misplaced.
        const box = page.getCropBox(), top = box.y + box.height;
        page.pushOperators(setLineJoin(LineJoinStyle.Round));
        for (const it of items.filter(isImg)) {
          const bytes = await this.app.vault.adapter.readBinary(it.img).catch(() => null);
          if (!bytes) continue; // photo file was deleted
          const im = it.img.toLowerCase().endsWith(".png") ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
          page.drawImage(im, { x: box.x + it.x, y: top - it.y - it.h, width: it.w, height: it.h });
        }
        const strokes = items.filter(isStroke);
        for (const st of [...strokes.filter((x) => x.hl), ...strokes.filter((x) => !x.hl)]) {
          const sh = inkShape(st.points, st.size, true, st.shape || st.hl);
          const o = {
            x: box.x, y: top, borderColor: rgbOf(st.color), borderLineCap: LineCapStyle.Round,
            borderOpacity: st.hl ? st.alpha ?? 0.35 : 1, blendMode: st.hl ? BlendMode.Multiply : BlendMode.Normal,
          };
          if (sh.d) page.drawSvgPath(sh.d, { ...o, borderWidth: st.size });
          for (const [x1, y1, x2, y2, w] of sh.ends) page.drawSvgPath(`M${x1} ${y1}L${x2} ${y2}`, { ...o, borderWidth: w });
        }
      }
      const out = await pdf.save();
      const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
      const path = normalizePath(`${this.file.parent?.path ?? ""}/${this.file.basename} (annotated).pdf`);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, buf);
      else await this.app.vault.createBinary(path, buf);
      new Notice(`PDF Ink: exported to ${path}`);
    } catch (e) {
      new Notice("PDF Ink: export failed. Your drawings are unchanged.");
      console.error(e);
    } finally {
      notice.hide();
    }
  }

  pickSource() {
    const pdfs = this.app.vault.getFiles().filter((f) => f.extension === "pdf" && f !== this.file);
    const view = this;
    new (class extends FuzzySuggestModal<TFile> {
      getItems() { return pdfs; }
      getItemText(f: TFile) { return f.path; }
      onChooseItem(f: TFile) { view.importFrom(f); }
    })(this.app).open();
  }

  // Copy strokes from an older version of this PDF, moving each page's ink to the page with the same text.
  async importFrom(src: TFile) {
    if (!this.canSave) return new Notice("PDF Ink: saving is off for this file, so import is blocked.");
    let old: Ink;
    try { old = await this.readInk(src.path); } catch { return new Notice("PDF Ink: that drawing file is damaged."); }
    if (!Object.keys(old).length) return new Notice(`PDF Ink: ${src.basename} has no drawings.`);
    const pdfjs = await loadPdfJs();
    const oldDoc = await pdfjs.getDocument({ data: await this.app.vault.readBinary(src) }).promise;
    const map = matchPages(await pageTexts(oldDoc), await pageTexts(this.doc));
    oldDoc.destroy();
    let moved = 0;
    for (const [k, strokes] of Object.entries(old)) {
      const to = map[+k - 1];
      if (!to) continue; // page was removed in the new version
      (this.ink[to] ??= []).push(...strokes);
      moved += strokes.length;
    }
    this.layout();
    this.changed();
    new Notice(`PDF Ink: imported ${moved} strokes from ${src.basename}.`);
  }
}

export default class PdfInkPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE, (leaf) => new InkView(leaf));
    const open = (f: TFile) => this.app.workspace.getLeaf(true).setViewState({ type: VIEW_TYPE, state: { file: f.path }, active: true });
    this.addCommand({
      id: "annotate-pdf", name: "Annotate current PDF",
      checkCallback: (chk) => {
        const f = this.app.workspace.getActiveFile();
        if (f?.extension !== "pdf") return false;
        if (!chk) open(f);
        return true;
      },
    });
    this.registerEvent(this.app.workspace.on("file-menu", (menu, f) => {
      if (f instanceof TFile && f.extension === "pdf") menu.addItem((i) => i.setTitle("Annotate with PDF Ink").setIcon("pen-tool").onClick(() => open(f)));
    }));
    // Open every PDF in PDF Ink, so drawings are always visible.
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      const f = (leaf?.view as FileView | undefined)?.file;
      if (leaf?.view.getViewType() === "pdf" && f) leaf.setViewState({ type: VIEW_TYPE, state: { file: f.path }, active: true });
    }));
    // Keep drawings attached when a PDF is renamed or moved.
    this.registerEvent(this.app.vault.on("rename", async (f, oldPath) => {
      const a = this.app.vault.adapter, from = inkPathOf(oldPath);
      if (f instanceof TFile && f.extension === "pdf" && (await a.exists(from))) await a.rename(from, inkPathOf(f.path));
    }));
  }
}
