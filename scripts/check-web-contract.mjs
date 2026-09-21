import { readFile } from 'node:fs/promises';

const [html, javascript] = await Promise.all([
  readFile('web/index.html', 'utf8'),
  Promise.all([readFile('web/app.js', 'utf8'),readFile('web/autobuy.js', 'utf8')]).then(parts=>parts.join('\n')),
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
const settingsSubtabs = [...html.matchAll(/\bdata-settings-subtab="([^"]+)"/g)].map((match) => match[1]);
const settingsSections = [...html.matchAll(/\bdata-settings-section="([^"]+)"/g)].map((match) => match[1]);
if (settingsSubtabs.join('|') !== settingsSections.join('|') || new Set(settingsSubtabs).size !== settingsSubtabs.length
  || settingsTabs.some((tab) => settingsSubtabs.filter((section) => section.startsWith(`${tab}/`)).length < 2)
  || settingsSubtabs.some((section) => !settingsTabs.includes(section.split('/')[0]))) {
  throw new Error('Web contract failed. Each Settings category needs matching, unique section tabs and panels.');
}
if (/\son(?:load|error)\s*=/i.test(javascript) || !javascript.includes('data-product-image')) {
  throw new Error('Web contract failed. Product images must use CSP-safe JavaScript load handling.');
}
console.log(`Web contract OK: ${referencedIds.length} JavaScript references and ${htmlIds.length} unique HTML IDs.`);
