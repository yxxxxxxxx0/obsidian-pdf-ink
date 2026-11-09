// For each old page, the new page (1-based) with the most similar text, or null if it was removed.
// Pages with no text (e.g. scanned) fall back to the same page number.
const words = (t: string) => new Set(t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

export function matchPages(oldTexts: string[], newTexts: string[]): (number | null)[] {
  const nw = newTexts.map(words);
  return oldTexts.map((t, i) => {
    const ow = words(t);
    if (!ow.size) return i < newTexts.length ? i + 1 : null;
    let best = 0, bestJ = -1;
    nw.forEach((s, j) => {
      let common = 0;
      for (const w of ow) if (s.has(w)) common++;
      const score = common / (ow.size + s.size - common); // Jaccard similarity
      // Ties go to the page nearest the old position.
      if (score > best || (score === best && bestJ >= 0 && Math.abs(j - i) < Math.abs(bestJ - i))) { best = score; bestJ = j; }
    });
    return best >= 0.5 ? bestJ + 1 : null;
  });
}
