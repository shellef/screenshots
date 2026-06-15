const fs = require('fs/promises');
const path = require('path');

// Reconstruct the results list for a job from on-disk metadata.json files,
// used as a fallback when the job is no longer in memory (see /jobs/:id/zip).
async function loadResults(jobDir, job) {
  if (job && Array.isArray(job.results) && job.results.length > 0) {
    return job.results;
  }

  let entries;
  try {
    entries = await fs.readdir(jobDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = [];
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(jobDir, entry.name, 'metadata.json'), 'utf-8'));
      results.push(meta);
    } catch {
      // No metadata.json (e.g. capture was interrupted mid-attempt) - skip it.
    }
  }
  return results;
}

// Standalone HTML page (no external resources) that lists every result with
// links to its screenshot(s)/HTML/metadata (relative paths, matching the zip's
// folder layout), and a client-side text search over each result's metadata.
function buildIndexHtml(jobId, results) {
  const data = JSON.stringify(results).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Captures - ${jobId}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 1000px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  input { width: 100%; box-sizing: border-box; font-size: 1rem; padding: 0.5rem; margin-bottom: 1rem; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #ddd; font-size: 0.9rem; vertical-align: top; overflow-wrap: break-word; word-break: break-all; }
  th { background: #f5f5f5; }
  .status-success { color: #1a7f37; font-weight: 600; }
  .status-error { color: #c0392b; font-weight: 600; }
  a { color: #0366d6; }
  .error-msg { color: #c0392b; white-space: pre-wrap; font-size: 0.8rem; }
  #count { font-size: 0.85rem; color: #555; margin-bottom: 0.5rem; }
</style>
</head>
<body>
  <h1>Captures - ${jobId}</h1>
  <input id="search" type="text" placeholder="Search title, URL, status...">
  <div id="count"></div>
  <table>
    <thead>
      <tr>
        <th style="width: 4%;">#</th>
        <th style="width: 22%;">Requested URL</th>
        <th style="width: 22%;">Final URL</th>
        <th style="width: 16%;">Title</th>
        <th style="width: 6%;">HTTP</th>
        <th style="width: 12%;">Captured (UTC)</th>
        <th style="width: 8%;">Status</th>
        <th style="width: 10%;">Files</th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>

<script>
const results = ${data};
const tbody = document.querySelector('tbody');
const searchEl = document.getElementById('search');
const countEl = document.getElementById('count');

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function render(filterText) {
  const q = (filterText || '').toLowerCase();
  let shown = 0;
  tbody.innerHTML = results.map((r, i) => {
    const haystack = JSON.stringify(r).toLowerCase();
    if (q && !haystack.includes(q)) return '';
    shown++;

    const files = r.status === 'success'
      ? (r.screenshots || ['screenshot.png']).map((name, idx) =>
          \`<a href="\${r.folder}/\${name}" target="_blank">screenshot\${idx > 0 ? ' ' + (idx + 1) : ''}</a>\`
        ).join(' | ') +
        \` | <a href="\${r.folder}/metadata.json" target="_blank">metadata</a>\`
      : \`<a href="\${r.folder}/metadata.json" target="_blank">metadata</a>\`;
    const errorRow = r.error ? \`<div class="error-msg">\${escapeHtml(r.error)}</div>\` : '';

    return \`<tr>
      <td>\${i}</td>
      <td>\${escapeHtml(r.requestedUrl)}</td>
      <td>\${escapeHtml(r.finalUrl || '')}</td>
      <td>\${escapeHtml(r.title || '')}</td>
      <td>\${r.httpStatus ?? ''}</td>
      <td>\${r.capturedAt || ''}</td>
      <td class="status-\${r.status}">\${r.status}\${errorRow}</td>
      <td>\${files}</td>
    </tr>\`;
  }).join('');
  countEl.textContent = \`Showing \${shown} of \${results.length}\`;
}

searchEl.addEventListener('input', () => render(searchEl.value));
render('');
</script>
</body>
</html>
`;
}

module.exports = { loadResults, buildIndexHtml };
