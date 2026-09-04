import { readFile } from 'node:fs/promises';

const [html, javascript] = await Promise.all([
  readFile('web/index.html', 'utf8'),
  readFile('web/app.js', 'utf8'),
]);
const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = [...new Set(htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index))];
const referencedIds = [...new Set([...javascript.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]))];
const missingIds = referencedIds.filter((id) => !htmlIds.includes(id));
if (duplicateIds.length || missingIds.length) {
  throw new Error(`Web contract failed. Duplicate IDs: ${duplicateIds.join(', ') || 'none'}. Missing IDs: ${missingIds.join(', ') || 'none'}.`);
}
console.log(`Web contract OK: ${referencedIds.length} JavaScript references and ${htmlIds.length} unique HTML IDs.`);
