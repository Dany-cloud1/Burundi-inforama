const express = require('express');
const app = express();
const { Client } = require('pg');
const PORT = process.env.PORT || 3000;

// --- CONFIG ---
const BOT_TOKEN = process.env.BOT_TOKEN || '8668406284:AAEbopVYNUdb6ZbJTwFZF_LMH7xiFs9pcXg';
const CHANNEL = process.env.CHANNEL || '@BurundiInforama';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const INTERVAL_HOURS = parseFloat(process.env.INTERVAL_HOURS || '1');
const FB_PAGE_ID = process.env.FB_PAGE_ID;
const FB_ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

// --- LOGGING ---
let logs = [];
let totalPosted = 0;
let lastRun = null;
let nextRun = null;
let lastResult = 'En attente...';

function addLog(msg, type = '') {
  const t = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  logs.unshift({ time: t, msg, type });
  if (logs.length > 150) logs.pop();
  console.log(`[${t}] ${msg}`);
}

// --- DATABASE SETUP ---
async function getDb() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();
  return client;
}

async function setupDb() {
  const db = await getDb();
  await db.query(`
    CREATE TABLE IF NOT EXISTS posted_articles (
      id SERIAL PRIMARY KEY,
      url TEXT UNIQUE NOT NULL,
      titre TEXT,
      posted_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await db.end();
  addLog('Base de donnees OK', 'ok');
}

async function isPosted(url) {
  if (!url) return true;
  const db = await getDb();
  const res = await db.query('SELECT 1 FROM posted_articles WHERE url = $1', [url]);
  await db.end();
  return res.rowCount > 0;
}

async function markPosted(url, titre) {
  if (!url) return;
  const db = await getDb();
  await db.query(
    'INSERT INTO posted_articles (url, titre) VALUES ($1, $2) ON CONFLICT (url) DO NOTHING',
    [url, titre]
  );
  await db.end();
}

async function getRecentPostedUrls() {
  const db = await getDb();
  const res = await db.query(
    'SELECT url FROM posted_articles ORDER BY posted_at DESC LIMIT 50'
  );
  await db.end();
  return res.rows.map(r => r.url);
}

// --- DATE CHECK: reject articles older than 3 days ---
function isWithin3Days(dateStr) {
  if (!dateStr) return false;
  try {
    const d = new Date(dateStr);
    if (isNaN(d)) return false;
    const diff = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
    return diff >= 0 && diff <= 3;
  } catch (e) { return false; }
}

// --- FETCH NEWS ---
async function fetchNews() {
  if (!ANTHROPIC_KEY) { addLog('CLE API MANQUANTE!', 'err'); return []; }

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const minus3 = new Date(today - 3 * 86400000).toISOString().split('T')[0];

  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': ANTHROPIC_KEY
  };

  // Get already-posted URLs from DB to tell the AI to avoid them
  const recentUrls = await getRecentPostedUrls();
  const avoidBlock = recentUrls.length > 0
    ? `\nDo NOT include any article from these URLs (already posted):\n${recentUrls.join('\n')}`
    : '';

  const prompt = `Today is ${todayStr}. Search for recent Burundi news articles published between ${minus3} and ${todayStr} (last 3 days only).

Find 6 articles total:
- 4 articles in FRENCH from: iwacu-burundi.org, SOSMediasBDI on X, FOCODE_ on X, RFI Afrique, BBC Afrique, Kaburahe on X, Rugurika on X, RTNBurundi on X
- 2 articles in KIRUNDI from: kwaNtare on X, nshingamateka on X, RT_Isanganiro on X, Pacifique Nininahazwe Facebook (facebook.com/pacininahazwe), Baratuza2000 on X

Rules:
- Every article MUST have a real unique URL starting with http
- Every article MUST be dated between ${minus3} and ${todayStr}
- NO duplicate topics or URLs
- Kirundi articles must be written in Kirundi language
- Search thoroughly for the most recent articles${avoidBlock}

Return ONLY valid JSON, no markdown:
{"articles":[{"titre":"...","resume":"max 100 chars in original language","source":"...","handle":"@...","url":"https://...","langue":"fr or rn","categorie":"politique/economie/societe/droits/sport","date":"YYYY-MM-DD"}]}`;

  addLog('Recherche articles (3 derniers jours)...', 'info');

  let raw = '';

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: 'You are a Burundi news collector. Use web_search to find real recent articles. Respond ONLY with valid JSON — no explanation, no markdown, no text before or after.',
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await res.json();
    if (data.error) { addLog('API Err: ' + data.error.message.substring(0, 80), 'err'); return []; }
    addLog('Status: ' + res.status, 'info');

    for (const block of (data.content || [])) {
      if (block.type === 'text') raw += block.text;
    }

    // Follow-up if model only searched but didn't respond with text
    if (!raw || raw.trim().length < 10) {
      addLog('Suivi requis...', 'info');
      const res2 = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2000,
          system: 'Respond ONLY with valid JSON. No markdown, no explanation.',
          messages: [
            { role: 'user', content: prompt },
            { role: 'assistant', content: data.content },
            { role: 'user', content: 'Now write ONLY the JSON. Start with { end with }. No other text.' }
          ]
        })
      });
      const data2 = await res2.json();
      for (const block of (data2.content || [])) {
        if (block.type === 'text') raw += block.text;
      }
    }
  } catch (e) {
    addLog('Fetch error: ' + e.message, 'err');
    return [];
  }

  // Parse JSON
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) { addLog('Pas de JSON recu', 'err'); return []; }

  let articles = [];
  try {
    const parsed = JSON.parse(raw.substring(start, end + 1));
    articles = parsed.articles || [];
  } catch (e) {
    addLog('JSON parse error: ' + e.message.substring(0, 60), 'err');
    return [];
  }

  addLog(`${articles.length} articles recus`, articles.length > 0 ? 'ok' : '');

  // --- FILTER: remove old, no-URL, or already-posted articles ---
  const fresh = [];
  for (const a of articles) {
    if (!a.url || !a.url.startsWith('http')) {
      addLog(`Ignore (pas d'URL): ${(a.titre || '').substring(0, 40)}`, '');
      continue;
    }
    if (!isWithin3Days(a.date)) {
      addLog(`Ignore (trop vieux: ${a.date}): ${(a.titre || '').substring(0, 35)}`, '');
      continue;
    }
    const posted = await isPosted(a.url);
    if (posted) {
      addLog(`Ignore (DB deja poste): ${(a.titre || '').substring(0, 35)}`, '');
      continue;
    }
    fresh.push(a);
  }

  addLog(`${fresh.length} nouveaux apres filtrage DB`, fresh.length > 0 ? 'ok' : '');
  return fresh;
}

// --- BUILD MESSAGES ---
function buildTelegramMessage(a) {
  const cats = { politique: '🏛️', droits: '✊', economie: '💰', societe: '🌍', sport: '⚽' };
  const cat = cats[a.categorie] || '📰';
  const langTag = a.langue === 'rn' ? ' 🇧🇮 [Kirundi]' : '';
  let msg = `${cat}${langTag} ${a.titre || ''}\n\n${a.resume || ''}\n\nSource: ${a.source || ''}`;
  if (a.handle) msg += ` ${a.handle}`;
  if (a.date) msg += `\n📅 ${a.date}`;
  if (a.url) msg += `\n🔗 ${a.url}`;
  msg += `\n\n#Burundi #Actualites\nCanal: @BurundiInforama`;
  return msg;
}

function buildFacebookMessage(a) {
  const cats = { politique: '🏛️', droits: '✊', economie: '💰', societe: '🌍', sport: '⚽' };
  const cat = cats[a.categorie] || '📰';
  const langTag = a.langue === 'rn' ? ' 🇧🇮 [Kirundi]' : '';
  let msg = `${cat}${langTag} ${a.titre || ''}\n\n${a.resume || ''}\n\nSource: ${a.source || ''}`;
  if (a.handle) msg += ` ${a.handle}`;
  if (a.date) msg += `\n📅 ${a.date}`;
  if (a.url) msg += `\n🔗 ${a.url}`;
  msg += `\n\n#Burundi #Actualites #BurundiInforama`;
  return msg;
}

// --- POST TO TELEGRAM ---
async function postToTelegram(article) {
  const text = buildTelegramMessage(article);
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHANNEL, text, disable_web_page_preview: false })
  });
  const d = await r.json();
  if (d.ok) {
    await markPosted(article.url, article.titre);
    totalPosted++;
    addLog(`✅ Telegram: ${(article.titre || '').substring(0, 50)}`, 'ok');
    return true;
  } else {
    addLog(`❌ Telegram: ${d.description}`, 'err');
    return false;
  }
}

// --- POST TO FACEBOOK ---
async function postToFacebook(article) {
  if (!FB_PAGE_ID || !FB_ACCESS_TOKEN) return;
  const text = buildFacebookMessage(article);
  const body = { message: text, access_token: FB_ACCESS_TOKEN };
  if (article.url) body.link = article.url;
  const r = await fetch(`https://graph.facebook.com/v19.0/${FB_PAGE_ID}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const d = await r.json();
  if (d.id) {
    addLog(`✅ Facebook: ${(article.titre || '').substring(0, 50)}`, 'ok');
  } else {
    addLog(`❌ Facebook: ${JSON.stringify(d).substring(0, 80)}`, 'err');
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- MAIN CYCLE ---
async function runCycle() {
  lastRun = new Date().toLocaleString('fr-FR');
  nextRun = new Date(Date.now() + INTERVAL_HOURS * 3600000).toLocaleString('fr-FR');
  addLog('━━━ Nouveau cycle ━━━', 'info');

  try {
    const articles = await fetchNews();

    if (articles.length === 0) {
      lastResult = 'Rien de nouveau';
      addLog('Rien de nouveau — aucun post', 'info');
      return;
    }

    lastResult = `${articles.length} nouveaux articles`;
    for (const article of articles) {
      const posted = await postToTelegram(article);
      await sleep(2000);
      if (posted) await postToFacebook(article);
      await sleep(3000);
    }
  } catch (e) {
    addLog('Erreur cycle: ' + e.message, 'err');
  }
}

async function start() {
  addLog('🇧🇮 BURUNDI INFORAMA DEMARRE', 'ok');
  addLog(`API: ${ANTHROPIC_KEY ? 'OK' : 'MANQUANTE!'}`, ANTHROPIC_KEY ? 'ok' : 'err');
  addLog(`DB: ${DATABASE_URL ? 'OK' : 'MANQUANTE!'}`, DATABASE_URL ? 'ok' : 'err');
  addLog(`Facebook: ${FB_PAGE_ID && FB_ACCESS_TOKEN ? 'OK' : 'Non configure'}`, FB_PAGE_ID && FB_ACCESS_TOKEN ? 'ok' : 'err');
  addLog(`Intervalle: ${INTERVAL_HOURS}h`, 'info');

  if (!DATABASE_URL) {
    addLog('DATABASE_URL manquante! Ajoutez-la dans Render env vars.', 'err');
    return;
  }

  await setupDb();
  await runCycle();
  setInterval(runCycle, INTERVAL_HOURS * 3600000);
}

// --- DASHBOARD ---
app.get('/', (req, res) => {
  const logHtml = logs.map(l =>
    `<div class="log ${l.type}">[${l.time}] ${l.msg}</div>`
  ).join('');
  res.send(`<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="30">
<title>BURUNDI INFORAMA</title>
<style>
  body{background:#08090a;color:#eef0ee;font-family:monospace;padding:16px;max-width:900px;margin:0 auto}
  h1{color:#00e676;font-size:1.2rem}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0}
  .card{background:#111314;border:1px solid #252829;border-radius:8px;padding:14px;text-align:center}
  .num{font-size:1.8rem;font-weight:700}
  .lbl{font-size:0.6rem;color:#6c7370;text-transform:uppercase;margin-top:4px}
  .box{background:#111314;border:1px solid #252829;border-radius:8px;padding:14px;margin-bottom:12px}
  .badge{background:rgba(0,230,118,0.1);border:1px solid rgba(0,230,118,0.3);color:#00e676;border-radius:20px;padding:4px 12px;font-size:0.75rem;display:inline-block}
  .log{font-size:0.72rem;padding:2px 0;color:#6c7370}
  .ok{color:#00e676}.err{color:#ff5252}.info{color:#40c4ff}
  .sub{font-size:0.65rem;color:#6c7370}
</style>
</head><body>
<h1>🇧🇮 BURUNDI INFORAMA</h1>
<p class="sub">@BurundiInforama · auto-refresh 30s</p>
<div class="grid">
  <div class="card"><div class="num" style="color:#00e676">${totalPosted}</div><div class="lbl">Postés</div></div>
  <div class="card"><div class="num" style="color:#40c4ff">${INTERVAL_HOURS}h</div><div class="lbl">Intervalle</div></div>
  <div class="card"><div class="num" style="color:#ffd740;font-size:0.65rem">${lastRun || '-'}</div><div class="lbl">Dernier</div></div>
</div>
<div class="box"><p class="sub">DERNIER RÉSULTAT</p><span class="badge">${lastResult}</span></div>
<div class="box"><p class="sub">PROCHAIN CYCLE</p><span class="badge">${nextRun || 'En attente...'}</span></div>
<div class="box"><p class="sub">JOURNAL</p>${logHtml || '<div class="log">Aucune activité</div>'}</div>
</body></html>`);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', totalPosted, lastRun, nextRun, lastResult });
});

app.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  start();
});
