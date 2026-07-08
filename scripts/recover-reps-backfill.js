// scripts/recover-reps-backfill.js
//
// One-time recovery: history/scores.json has ~40 older records with no `rep`
// (captured before rep-logging was added). This re-fetches the internal rep
// per Gong callId and backfills them into the Sales Hub call_scores table.
//
// The daily agent already syncs rep correctly going forward — this only repairs
// the April–June history. Safe to delete after a successful run.
//
// Requires env (all already present as GitHub Actions secrets):
//   GONG_ACCESS_KEY, GONG_ACCESS_KEY_SECRET   — to read parties from Gong
//   SALES_HUB_URL                             — https://sales-hub-2b60.onrender.com
//   SALES_HUB_INTERNAL_API_KEY                — Bearer key for the backfill endpoint
//
// Dry-run by default (prints what it WOULD do). Set APPLY=1 to actually POST.

const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');

const GONG_BASE         = 'https://us-43298.api.gong.io';
const SALES_HUB_URL     = process.env.SALES_HUB_URL;
const SALES_HUB_API_KEY = process.env.SALES_HUB_INTERNAL_API_KEY;
const APPLY             = process.env.APPLY === '1';

// Known name normalizations so recovered history matches the daily sync's spelling.
const NAME_FIX = { 'Joshua Kelonda': 'Joshua Kolenda' };

function gongHeaders() {
  const credentials = Buffer.from(
    `${process.env.GONG_ACCESS_KEY}:${process.env.GONG_ACCESS_KEY_SECRET}`
  ).toString('base64');
  return { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' };
}

// callId -> internal rep name, via Gong's extensive endpoint (parties only).
async function fetchRepNames(callIds) {
  const map = {};
  const CHUNK = 100; // Gong caps callIds per request
  for (let i = 0; i < callIds.length; i += CHUNK) {
    const batch = callIds.slice(i, i + CHUNK);
    const res = await fetch(`${GONG_BASE}/v2/calls/extensive`, {
      method: 'POST',
      headers: gongHeaders(),
      body: JSON.stringify({
        filter: { callIds: batch },
        contentSelector: { exposedFields: { parties: true } },
      }),
    });
    if (!res.ok) {
      console.error(`  Gong extensive failed: ${res.status} ${await res.text()}`);
      continue;
    }
    const data = await res.json();
    for (const c of data.calls || []) {
      const id = c.metaData && c.metaData.id;
      const internal = (c.parties || []).find(p => p.affiliation === 'Internal');
      if (id && internal && internal.name) map[id] = internal.name;
    }
  }
  return map;
}

async function main() {
  const required = { SALES_HUB_URL, SALES_HUB_INTERNAL_API_KEY: SALES_HUB_API_KEY,
    GONG_ACCESS_KEY: process.env.GONG_ACCESS_KEY, GONG_ACCESS_KEY_SECRET: process.env.GONG_ACCESS_KEY_SECRET };
  for (const [k, v] of Object.entries(required)) {
    if (!v) { console.error(`Missing required env: ${k}`); process.exit(1); }
  }

  const file = path.join(__dirname, '..', 'history', 'scores.json');
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));

  const missing = [];
  for (const calls of Object.values(d)) for (const c of calls) {
    if (c.callId && !c.rep) missing.push(c.callId);
  }
  console.log(`Records missing rep: ${missing.length}`);
  if (missing.length === 0) { console.log('Nothing to recover.'); return; }

  const repMap = await fetchRepNames(missing);
  console.log(`Recovered reps from Gong for ${Object.keys(repMap).length}/${missing.length} calls`);

  // Build a backfill payload of every record that now has a rep (original + recovered).
  // The backfill endpoint uses ON CONFLICT DO NOTHING, so the 8 already-imported rows are no-ops.
  const payload = {};
  let recovered = 0, stillUnknown = 0;
  for (const [date, calls] of Object.entries(d)) {
    for (const c of calls) {
      let rep = c.rep || repMap[c.callId] || null;
      if (rep && NAME_FIX[rep]) rep = NAME_FIX[rep];
      if (!rep) { stillUnknown++; continue; }
      if (!c.rep && repMap[c.callId]) recovered++;
      (payload[date] = payload[date] || []).push({ ...c, rep });
    }
  }
  console.log(`Newly recovered: ${recovered} | still unknown (skipped): ${stillUnknown}`);

  if (!APPLY) {
    console.log('\nDRY RUN — set APPLY=1 to POST the backfill.');
    const firstDate = Object.keys(payload)[0];
    console.log('Sample date payload:', JSON.stringify({ [firstDate]: payload[firstDate] }, null, 2).slice(0, 700));
    return;
  }

  const res = await fetch(`${SALES_HUB_URL}/api/call-scores/backfill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SALES_HUB_API_KEY}` },
    body: JSON.stringify(payload),
  });
  console.log(`Backfill: HTTP ${res.status} → ${await res.text()}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
