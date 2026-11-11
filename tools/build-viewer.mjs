// Bundles the browser pages into self-contained HTML files:
//   dist/viewer.html    replay viewer (resolves a demo battle in the browser, or plays one sent by the designer)
//   dist/designer.html  ship designer
//   dist/galaxy.html    galaxy map (world, economy, fleets), with the designer and viewer built in
//   dist/play.html      the same galaxy page in online mode: the page the game server serves
//   dist/*.artifact.html  the same pages without the <html> skeleton (for hosts that add their own)
// Usage: node tools/build-viewer.mjs [viewer|designer|galaxy|play]   (no argument builds them all)
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const PAGES = {
  viewer: { entry: 'src/viewer/app.js', html: 'src/viewer/index.html', artifact: 'dist/artifact.html' },
  designer: { entry: 'src/designer/app.js', html: 'src/designer/index.html', artifact: 'dist/designer.artifact.html' },
  galaxy: { entry: 'src/galaxy/app.js', html: 'src/galaxy/index.html', artifact: 'dist/galaxy.artifact.html' },
  play: { entry: 'src/galaxy/app.js', html: 'src/galaxy/index.html', artifact: null, online: true },
};
const only = process.argv[2];
mkdirSync('dist', { recursive: true });
const built = {};
// The designer embeds the viewer page (its test battles play in an overlay), and the galaxy map
// embeds both (shipyard design and battle replays), so they build in this order.
for (const [name, p] of Object.entries(PAGES)) {
  const res = await build({
    entryPoints: [p.entry], bundle: true, format: 'esm', write: false,
    minify: true, target: 'es2020', legalComments: 'none',
    define: name === 'designer' ? { __VIEWER_PAGE__: JSON.stringify(built.viewer) }
      : name === 'galaxy' || name === 'play' ? { __VIEWER_PAGE__: JSON.stringify(built.viewer), __DESIGNER_PAGE__: JSON.stringify(built.designer), __ONLINE__: String(!!p.online) } : {},
  });
  const js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const page = readFileSync(p.html, 'utf8').replace('/*APP*/', () => js);
  built[name] = page;
  if (only && only !== name) continue;
  if (p.artifact) writeFileSync(p.artifact, page);
  // The online page carries a build id (a hash of its own code). The server reads it from the page
  // it serves and refuses actions from pages of another build, which are told to refresh.
  const stamp = p.online ? `<meta name="lsb-build" content="${createHash('sha256').update(page).digest('hex').slice(0, 12)}">` : '';
  writeFileSync(`dist/${name}.html`, `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">${stamp}</head><body style="margin:0">\n${page}\n</body></html>\n`);
  console.log(`dist/${name}.html ${(page.length / 1024).toFixed(0)} KB`);
}
