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
const settingsTabs = [...html.matchAll(/\bdata-settings-tab="([^"]+)"/g)].map((match) => match[1]);
const settingsPanels = [...html.matchAll(/\bdata-settings-panel="([^"]+)"/g)].map((match) => match[1]);
if (settingsTabs.length < 2 || settingsTabs.join('|') !== settingsPanels.join('|')) {
  throw new Error(`Web contract failed. Settings tabs (${settingsTabs.join(', ')}) do not match panels (${settingsPanels.join(', ')}).`);
}
if (/\son(?:load|error)\s*=/i.test(javascript) || !javascript.includes('data-product-image')) {
  throw new Error('Web contract failed. Product images must use CSP-safe JavaScript load handling.');
}
console.log(`Web contract OK: ${referencedIds.length} JavaScript references and ${htmlIds.length} unique HTML IDs.`);
