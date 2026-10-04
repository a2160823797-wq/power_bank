import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const buildDirectory = resolve(projectRoot, '.offline-build');
const outputFile = resolve(projectRoot, 'PowerBank.html');
const css = (await readFile(resolve(buildDirectory, 'style.css'), 'utf8'))
  .replaceAll('https://tailwindcss.com', '')
  .replaceAll('</style', '<\\/style');
const javascript = (await readFile(resolve(buildDirectory, 'app.js'), 'utf8'))
  .replaceAll('https://react.dev/errors/', 'React error ')
  .replaceAll('</script', '<\\/script');

const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="PowerBank 电池监测、数字电位器与固件升级" />
    <title>PowerBank</title>
    <style>${css}</style>
  </head>
  <body class="antialiased">
    <div id="root"></div>
    <script>${javascript}</script>
  </body>
</html>
`;

const allowedNamespaceUrls = new Set([
  'http://www.w3.org/1998/Math/MathML',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/XML/1998/namespace',
]);
const remainingUrls = [...html.matchAll(/https?:\/\/[^\s"'<>`]+/gi)].map(
  ([url]) => url,
);
const publicUrls = [...new Set(remainingUrls)].filter(
  (url) => !allowedNamespaceUrls.has(url),
);

if (publicUrls.length > 0) {
  throw new Error(
    `Offline page contains public URLs: ${publicUrls.join(', ')}`,
  );
}

await writeFile(outputFile, html, 'utf8');
console.log(`Offline page generated: ${outputFile}`);
