import esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "fs";
const out = process.env.HOME + "/Documents/MY vault/.obsidian/plugins/pdf-ink";
mkdirSync(out, { recursive: true });
const copy = () => { for (const f of ["manifest.json", "styles.css"]) copyFileSync(f, `${out}/${f}`); };
const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"], bundle: true, format: "cjs", target: "es2020",
  external: ["obsidian", "electron"], outfile: `${out}/main.js`, logLevel: "info",
  plugins: [{ name: "copy", setup(b) { b.onEnd(copy); } }],
});
if (process.argv.includes("--watch")) await ctx.watch(); else { await ctx.rebuild(); await ctx.dispose(); }
