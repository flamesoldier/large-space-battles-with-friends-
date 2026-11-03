// Bundles the viewer (and the sim it runs in-browser) into one self-contained HTML file.
//   dist/viewer.html    open directly in a browser
//   dist/artifact.html  same page without the <html> skeleton (for hosts that add their own)
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const res = await build({
  entryPoints: ['src/viewer/app.js'], bundle: true, format: 'esm', write: false,
  minify: true, target: 'es2020', legalComments: 'none',
});
const js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const page = readFileSync('src/viewer/index.html', 'utf8').replace('/*APP*/', () => js);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/artifact.html', page);
writeFileSync('dist/viewer.html', `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body style="margin:0">\n${page}\n</body></html>\n`);
console.log(`dist/viewer.html ${(page.length / 1024).toFixed(0)} KB`);
