import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('./', import.meta.url);
const data = JSON.parse(readFileSync(new URL('status.json', root), 'utf8'));
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const allowed = ['Complete', 'Partial', 'In Progress', 'Unverified', 'Pending', 'Not Started', 'Blocked'];
const ids = new Set();
for (const item of data.items) {
  if (!item.id || ids.has(item.id) || !allowed.includes(item.status) || !item.title || !item.notes || !item.dateLabel) throw Error('Invalid or duplicate status item');
  ids.add(item.id);
  if (item.status === 'Complete' && (!item.actualDate || !item.evidence)) throw Error('Completion needs date and evidence');
  if (!item.evidence.startsWith('https://github.com/DaveHomeAssist/agent-chat/')) throw Error('Unexpected evidence URL');
}
const done = data.items.filter(i => i.status === 'Complete').sort((a,b) => a.actualDate.localeCompare(b.actualDate));
const remaining = data.items.filter(i => i.status !== 'Complete');
const template = readFileSync(new URL('template.html', root), 'utf8');
const css = readFileSync(new URL('styles.css', root), 'utf8');
const script = readFileSync(new URL('controls.js', root), 'utf8');
const payload = JSON.stringify(data).replaceAll('<', '\\u003c');
const html = template.replace('/* STYLES */', () => css).replace('/* DATA */', () => payload).replace('/* CONTROLS */', () => script);
writeFileSync(new URL('index.html', root), html);
console.log(`Rendered ${done.length} completed and ${remaining.length} remaining items.`);
