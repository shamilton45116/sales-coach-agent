const fetch = require('node-fetch');

const GONG_BASE = 'https://us-43298.api.gong.io';
const MIN_DURATION_SECS = 600; // 10 minutes

// Set GONG_TEAM_EMAILS in GitHub Secrets as comma-separated rep emails
// e.g. "alice@toolbx.com,bob@toolbx.com"
// Leave blank to include all internal Gong users
function getAllowedEmails() {
  const raw = process.env.GONG_TEAM_EMAILS || '';
  if (!raw.trim()) return null;
  return new Set(raw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean));
}

function gongHeaders() {
  const credentials = Buffer.from(
    `${process.env.GONG_ACCESS_KEY}:${process.env.GONG_ACCESS_KEY_SECRET}`
  ).toString('base64');
  return {
    Authorization: `Basic ${credentials}`,
    'Content-Type': 'application/json',
  };
}

async function fetchYesterdaysCalls() {
  const now = new Date();
  const todayMidnight = new Date(now);
  todayMidnight.setHours(0, 0, 0, 0);
  const yesterdayMidnight = new Date(todayMidnight);
  yesterdayMidnight.setDate(yesterdayMidnight.getDate() - 1);

  const fromDateTime = yesterdayMidnight.toISOString();
  const toDateTime   = todayMidnight.toISOString();
  console.log(`Fetching Gong calls: ${fromDateTime} → ${toDateTime}`);

  // Step 1: Get list of calls in date range
  const listRes = await fetch(
    `${GONG_BASE}/v2/calls?fromDateTime=${fromDateTime}&toDateTime=${toDateTime}`,
    { headers: gongHeaders() }
  );
  if (!listRes.ok) throw new Error(`Gong calls fetch failed: ${listRes.status} ${await listRes.text()}`);

  const allCalls = (await listRes.json()).calls || [];
  console.log(`  Total calls found: ${allCalls.length}`);

  // Step 2: Filter by duration (>10 min)
  const longCalls = allCalls.filter(c => (c.duration || 0) >= MIN_DURATION_SECS);
  console.log(`  After 10-min filter: ${longCalls.length}`);
  if (longCalls.length === 0) return [];

  // Step 3: Fetch detailed call data to get parties/speakers with emails
  const detailRes = await fetch(`${GONG_BASE}/v2/calls/extensive`, {
    method: 'POST',
    headers: gongHeaders(),
    body: JSON.stringify({
      filter: { callIds: longCalls.map(c => c.id) },
      contentSelector: {
        exposedFields: {
          parties: true,
          content: { pointsOfInterest: false, brief: false, outline: false, highlights: false },
        },
      },
    }),
  });
  const detailMap = {};
  if (detailRes.ok) {
    for (const c of (await detailRes.json()).calls || []) {
      detailMap[c.metaData?.id] = c;
    }
  }

  // Step 4: Apply team filter — only keep calls where an internal rep is on the allowed list
  const allowedEmails = getAllowedEmails();
  const teamCalls = longCalls.filter(c => {
    if (!allowedEmails) return true; // no filter set — allow all
    const detail  = detailMap[c.id];
    const parties = detail?.parties || [];
    return parties.some(p => {
      const email = (p.emailAddress || '').toLowerCase();
      return allowedEmails.has(email);
    });
  });
  console.log(`  After team filter: ${teamCalls.length}`);
  if (teamCalls.length === 0) return [];

  // Step 5: Fetch transcripts
  const transcriptRes = await fetch(`${GONG_BASE}/v2/calls/transcript`, {
    method: 'POST',
    headers: gongHeaders(),
    body: JSON.stringify({ filter: { callIds: teamCalls.map(c => c.id) } }),
  });
  const transcriptMap = {};
  if (transcriptRes.ok) {
    for (const t of (await transcriptRes.json()).callTranscripts || []) {
      transcriptMap[t.callId] = t.transcript
        .map(seg => `${seg.speakerName}: ${seg.sentences.map(s => s.text).join(' ')}`)
        .join('\n');
    }
  }

  // Step 6: Build enriched call objects
  const enriched = teamCalls
    .filter(c => transcriptMap[c.id] && transcriptMap[c.id].length > 100)
    .map(c => {
      const parties  = detailMap[c.id]?.parties || [];

      // Find the internal rep — prefer one whose email is on the allowed list
      let internal = allowedEmails
        ? parties.find(p => allowedEmails.has((p.emailAddress || '').toLowerCase()))
        : parties.find(p =>
            (p.affiliation === 'Internal' || p.methods?.some(m => m.affiliation === 'Internal')) && p.name
          );
      if (!internal) internal = parties.find(p => p.name); // fallback

      const rep = internal?.name || extractRepFromTitle(c.title) || 'Unknown Rep';

      return {
        id:         c.id,
        title:      c.title || 'Untitled call',
        rep,
        duration:   c.duration || 0,
        started:    c.started,
        transcript: transcriptMap[c.id],
      };
    });

  console.log(`  With transcripts: ${enriched.length}`);
  return enriched;
}

// Fallback: pull rep name from call title e.g. "Mohler | TOOLBX - Sync" → "Mohler"
function extractRepFromTitle(title) {
  if (!title) return null;
  const match = title.match(/^([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s*[|&-]/);
  return match ? match[1].trim() : null;
}

async function addCallsToLibrary(callIds) {
  if (!callIds || callIds.length === 0) return;
  const res = await fetch(`${GONG_BASE}/v2/library/calls`, {
    method: 'PUT',
    headers: gongHeaders(),
    body: JSON.stringify({ callIds }),
  });
  if (!res.ok) {
    console.warn(`  Gong library tagging failed: ${res.status} ${await res.text()}`);
    return false;
  }
  console.log(`  Added ${callIds.length} call(s) to Gong Library`);
  return true;
}

module.exports = { fetchYesterdaysCalls, addCallsToLibrary };
