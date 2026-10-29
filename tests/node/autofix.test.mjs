import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = path.resolve('tests/node/autofix');
const files = fs.existsSync(directory)
  ? fs.readdirSync(directory).filter((name) => name.endsWith('.test.mjs')).sort()
  : [];
for (const file of files) await import(pathToFileURL(path.join(directory, file)).href);
console.log(`\nautofix: ${files.length} regressão(ões) de receitas executadas.`);
