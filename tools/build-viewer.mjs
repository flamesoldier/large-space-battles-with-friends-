// Bundles the browser pages into self-contained HTML files:
//   dist/viewer.html    replay viewer (resolves a demo battle in the browser, or plays one sent by the designer)
//   dist/designer.html  ship designer
//   dist/*.artifact.html  the same pages without the <html> skeleton (for hosts that add their own)
// Usage: node tools/build-viewer.mjs [viewer|designer]   (no argument builds both)
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const PAGES = {
  viewer: { entry: 'src/viewer/app.js', html: 'src/viewer/index.html', artifact: 'dist/artifact.html' },
  designer: { entry: 'src/designer/app.js', html: 'src/designer/index.html', artifact: 'dist/designer.artifact.html' },
};
const only = process.argv[2];
mkdirSync('dist', { recursive: true });
for (const [name, p] of Object.entries(PAGES)) {
  if (only && only !== name) continue;
  const res = await build({
    entryPoints: [p.entry], bundle: true, format: 'esm', write: false,
    minify: true, target: 'es2020', legalComments: 'none',
  });
  const js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const page = readFileSync(p.html, 'utf8').replace('/*APP*/', () => js);
  writeFileSync(p.artifact, page);
  writeFileSync(`dist/${name}.html`, `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body style="margin:0">\n${page}\n</body></html>\n`);
  console.log(`dist/${name}.html ${(page.length / 1024).toFixed(0)} KB`);
}
