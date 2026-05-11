const express = require('express');
const app = express();
const { Client } = require('pg');
const PORT = process.env.PORT || 3000;

// --- CONFIG ---
const BOT_TOKEN = process.env.BOT_TOKEN || '8668406284:AAEbopVYNUdb6ZbJTwFZF_LMH7xiFs9pcXg';
const CHANNEL = process.env.CHANNEL || '@BurundiInforama';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const INTERVAL_HOURS = parseFloat(process.env.INTERVAL_HOURS || '2');
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

// --- CONTENT FORMAT ROTATION ---
const contentFormats = [
  {
    type: 'ACTUALITE',
    emoji: '📰',
    label: 'ACTUALITÉ',
    searchPrompt: 'Trouve des actualités politiques ou sociales récentes et importantes du Burundi publiées dans les 3 derniers jours.',
    sources: 'iwacu-burundi.org, SOSMediasBDI on X, FOCODE_ on X, focode.org, Kaburahe on X, radio_rpa on X, rpa.bi, RT_Isanganiro on X, pnininahazwe on X, ndondeza.org, HollyEude on X, rugbob78 on X, ABPInfos on X, abpinfo.bi, AndreNikwigize1 on X, youtube.com/@TeleRenaissance, youtube.com/@radiopubliqueafricaineijwi55, radiopeacefm.com, UEauBurundi on X, eeas.europa.eu/burundi',
    langue: 'fr'
  },
  {
    type: 'SPORT',
    emoji: '⚽',
    label: 'SPORT',
    searchPrompt: 'Trouve des actualités sportives récentes sur le Burundi: football (Vital\'O FC, Hawks FC, Athletico Olympic, équipe nationale Intamba mu rugamba), athlétisme, ou autre sport burundais.',
    sources: 'X/Twitter: VitalOFC, HawksFC_Bdi, FBFBurundi, AthleticsBdi, sports burundi news, youtube.com/@TeleRenaissance, youtube.com/@radiopubliqueafricaineijwi55',
    langue: 'fr'
  },
  {
    type: 'ECONOMIE',
    emoji: '💰',
    label: 'ÉCONOMIE',
    searchPrompt: 'Trouve des actualités économiques récentes sur le Burundi: prix du café burundais à l\'export, taux de change BRB, commerce EAC, investissements, ou budget national.',
    sources: 'BRB_Burundi on X, OBRBurundi on X, ndondeza.org, pnininahazwe on X, AndreNikwigize1 on X, partners4peace.com, iwacu-burundi.org économie, banquedelarepublique.bi, ABPInfos on X, abpinfo.bi, UEauBurundi on X, eeas.europa.eu/burundi',
    langue: 'fr'
  },
  {
    type: 'CULTURE',
    emoji: '🎭',
    label: 'CULTURE & SOCIÉTÉ',
    searchPrompt: 'Partage des informations intéressantes sur la culture burundaise: musique traditionnelle, danse des tambours, art, festivals, personnalités culturelles, ou traditions burundaises.',
    sources: 'culture burundi actualite, musique burundaise, tambours burundi, artistes burundais, youtube.com/@TeleRenaissance, youtube.com/@radiopubliqueafricaineijwi55, radiopeacefm.com',
    langue: 'fr'
  },


  {
    type: 'DIASPORA',
    emoji: '🌍',
    label: 'DIASPORA',
    searchPrompt: 'Trouve des informations récentes pertinentes pour la communauté burundaise en diaspora: Belgique, France, Canada, USA — événements communautaires, transferts d\'argent, opportunités, ou nouvelles concernant les Burundais à l\'étranger.',
    sources: 'diaspora burundaise europe, burundais belgique france, communaute burundaise canada, pnininahazwe on X, HollyEude on X, AndreNikwigize1 on X, partners4peace.com, UEauBurundi on X, eeas.europa.eu/burundi',
    langue: 'fr'
  }
];

let formatIndex = 0;

function getNextFormat() {
  const format = contentFormats[formatIndex % contentFormats.length];
  formatIndex++;
  return format;
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

async function cleanOldArticles() {
  try {
    const db = await getDb();
    const result = await db.query(
      "DELETE FROM posted_articles WHERE posted_at < NOW() - INTERVAL '3 days'"
    );
    await db.end();
    addLog(`DB nettoyee: ${result.rowCount} anciens articles supprimes`, 'info');
  } catch (e) {
    addLog('Erreur nettoyage DB: ' + e.message, 'err');
  }
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

// --- ENGLISH DETECTION ---
function isEnglish(text) {
  if (!text) return false;
  const englishWords = ['the ', ' is ', ' are ', ' was ', ' were ', ' has ', ' have ',
    ' will ', ' been ', ' after ', ' before ', ' with ', ' from ', ' this ', ' that ',
    ' they ', ' their ', ' said ', 'according', 'reported', 'announced', 'government',
    'president', 'minister', 'country', 'people', 'years', 'rights', 'killed', 'attack'];
  const lower = text.toLowerCase();
  const matches = englishWords.filter(w => lower.includes(w)).length;
  return matches >= 3;
}

// --- DATE CHECK ---
function extractDateFromUrl(url) {
  if (!url) return null;
  const match = url.match(/\/(20\d{2})\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\//);
  if (match) return new Date(`${match[1]}-${match[2]}-${match[3]}`);
  return null;
}

function isWithin3Days(dateStr, url) {
  const now = Date.now();
  const maxAge = 3 * 24 * 60 * 60 * 1000;
  const oneDayFuture = 24 * 60 * 60 * 1000;

  const urlDate = extractDateFromUrl(url);
  if (urlDate && !isNaN(urlDate)) {
    const diff = now - urlDate.getTime();
    return diff >= -oneDayFuture && diff <= maxAge;
  }

  if (!dateStr) return false;
  try {
    const d = new Date(dateStr);
    if (isNaN(d)) return false;
    const diff = now - d.getTime();
    return diff >= -oneDayFuture && diff <= maxAge;
  } catch (e) { return false; }
}

// --- FETCH NEWS WITH VARIETY ---
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

  const recentUrls = await getRecentPostedUrls();
  const avoidBlock = recentUrls.length > 0
    ? `\nDo NOT include any article from these URLs (already posted):\n${recentUrls.join('\n')}`
    : '';

  // ✅ CHANGED: Get 3 content formats per cycle (was 2) for more articles
  const format1 = getNextFormat();
  const format2 = getNextFormat();
  const format3 = getNextFormat();

  function buildGroupPrompt(format) {
    return `Today is ${todayStr}. ${format.searchPrompt}

Search sources: ${format.sources}

Return 3 to 5 items. Rules:
- ONLY content from the last 3 days (since ${minus3}) for news formats
- For PROVERBE and HISTOIRE formats, date restriction does NOT apply
- ONLY French or Kirundi — NO English
- Real URLs starting with http (use "#proverbe" or "#histoire" as URL if no real URL exists)
- "date" field: use today's date ${todayStr} for proverbes/histoire
- Do NOT return an error — always return JSON${avoidBlock}

Return ONLY valid JSON:
{"articles":[{"titre":"...","resume":"max 150 chars","source":"...","handle":"","url":"https://... or #${format.type.toLowerCase()}","langue":"fr or rn","categorie":"${format.type.toLowerCase()}","date":"YYYY-MM-DD","format":"${format.type}"}]}`;
  }

  const GROUPS = [
    { label: `Format: ${format1.label}`, format: format1, prompt: buildGroupPrompt(format1) },
    { label: `Format: ${format2.label}`, format: format2, prompt: buildGroupPrompt(format2) },
    { label: `Format: ${format3.label}`, format: format3, prompt: buildGroupPrompt(format3) }, // ✅ NEW
  ];

  async function searchGroup(group) {
    let raw = '';
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2000,
          system: `Tu es BURUNDI INFORAMA, agrégateur d'actualités burundaises. Use web_search. ONLY French or Kirundi content, NEVER English. Respond ONLY with valid JSON.`,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [{ role: 'user', content: group.prompt }]
        })
      });

      const data = await res.json();
      if (data.error) { addLog(`Err ${group.label}: ` + data.error.message.substring(0, 60), 'err'); return []; }

      for (const block of (data.content || [])) {
        if (block.type === 'text') raw += block.text;
      }

      if (!raw || raw.trim().length < 10) {
        const res2 = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 2000,
            system: 'Respond ONLY with valid JSON. No markdown.',
            messages: [
              { role: 'user', content: group.prompt },
              { role: 'assistant', content: data.content },
              { role: 'user', content: 'Write ONLY the JSON. Start with { end with }.' }
            ]
          })
        });
        const data2 = await res2.json();
        for (const block of (data2.content || [])) {
          if (block.type === 'text') raw += block.text;
        }
      }
    } catch (e) {
      addLog(`Fetch error ${group.label}: ` + e.message, 'err');
      return [];
    }

    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) return [];
    try {
      const parsed = JSON.parse(raw.substring(start, end + 1));
      const articles = parsed.articles || [];
      return articles.map(a => ({ ...a, format: group.format.type, formatEmoji: group.format.emoji, formatLabel: group.format.label }));
    } catch (e) { return []; }
  }

  addLog(`Cycle varié: ${format1.label} + ${format2.label} + ${format3.label}`, 'info');

  addLog(`Recherche ${format1.label}...`, 'info');
  const group1Articles = await searchGroup(GROUPS[0]);
  addLog(`${format1.label}: ${group1Articles.length} résultats`, group1Articles.length > 0 ? 'ok' : '');

  await new Promise(r => setTimeout(r, 6000));

  addLog(`Recherche ${format2.label}...`, 'info');
  const group2Articles = await searchGroup(GROUPS[1]);
  addLog(`${format2.label}: ${group2Articles.length} résultats`, group2Articles.length > 0 ? 'ok' : '');

  await new Promise(r => setTimeout(r, 6000)); // ✅ NEW delay before format3

  addLog(`Recherche ${format3.label}...`, 'info'); // ✅ NEW
  const group3Articles = await searchGroup(GROUPS[2]); // ✅ NEW
  addLog(`${format3.label}: ${group3Articles.length} résultats`, group3Articles.length > 0 ? 'ok' : ''); // ✅ NEW

  const allArticles = [...group1Articles, ...group2Articles, ...group3Articles]; // ✅ CHANGED
  addLog(`Total: ${allArticles.length} articles reçus`, allArticles.length > 0 ? 'ok' : '');

  // --- FILTER ---
  const fresh = [];
  for (const a of allArticles) {
    const isSpecialFormat = a.format === 'PROVERBE' || a.format === 'HISTOIRE';

    if (!isSpecialFormat) {
      if (!a.url || !a.url.startsWith('http')) {
        addLog(`Ignore (pas d'URL): ${(a.titre || '').substring(0, 40)}`, '');
        continue;
      }

      if (a.url.includes('youtube.com') || a.url.includes('youtu.be') ||
        a.url.includes('rfi.fr') || a.url.includes('bbc.') ||
        a.source?.toLowerCase().includes('rfi') ||
        a.source?.toLowerCase().includes('bbc')) {
        addLog(`Ignore (source non autorisée: ${a.source})`, '');
        continue;
      }

      if (!isWithin3Days(a.date, a.url)) {
        addLog(`Ignore (trop vieux: ${a.date}): ${(a.titre || '').substring(0, 35)}`, '');
        continue;
      }
    }

    if (a.langue === 'en' || isEnglish(a.titre + ' ' + a.resume)) {
      addLog(`Ignore (anglais): ${(a.titre || '').substring(0, 40)}`, '');
      continue;
    }

    const dedupKey = isSpecialFormat ? `#${a.format?.toLowerCase()}-${(a.titre || '').substring(0, 30)}` : a.url;
    const posted = await isPosted(dedupKey);
    if (posted) {
      addLog(`Ignore (déjà posté): ${(a.titre || '').substring(0, 35)}`, '');
      continue;
    }

    fresh.push({ ...a, _dedupKey: dedupKey });
  }

  addLog(`${fresh.length} nouveaux après filtrage`, fresh.length > 0 ? 'ok' : '');
  return fresh;
}

// --- BUILD MESSAGES ---
function buildTelegramMessage(a) {
  const emoji = a.formatEmoji || '📰';
  const label = a.formatLabel || 'ACTUALITÉ';
  const langTag = a.langue === 'rn' ? ' 🇧🇮' : '';
  const isSpecialFormat = a.format === 'PROVERBE' || a.format === 'HISTOIRE';

  let msg = `${emoji} *${label}*${langTag}\n\n`;
  msg += `${a.titre || ''}\n\n`;
  msg += `${a.resume || ''}`;

  if (a.source) msg += `\n\nSource: ${a.source}`;
  if (a.handle) msg += ` ${a.handle}`;
  if (a.date && !isSpecialFormat) msg += `\n📅 ${a.date}`;
  if (a.url && a.url.startsWith('http')) msg += `\n🔗 ${a.url}`;

  msg += `\n\n#Burundi #${label.replace(/[^a-zA-Z]/g, '')} #BurundiInforama\nCanal: @BurundiInforama`;
  return msg;
}

function buildFacebookMessage(a) {
  const emoji = a.formatEmoji || '📰';
  const label = a.formatLabel || 'ACTUALITÉ';
  const langTag = a.langue === 'rn' ? ' 🇧🇮' : '';
  const isSpecialFormat = a.format === 'PROVERBE' || a.format === 'HISTOIRE';

  let msg = `${emoji} ${label}${langTag}\n\n`;
  msg += `${a.titre || ''}\n\n`;
  msg += `${a.resume || ''}`;

  if (a.source) msg += `\n\nSource: ${a.source}`;
  if (a.handle) msg += ` ${a.handle}`;
  if (a.date && !isSpecialFormat) msg += `\n📅 ${a.date}`;
  if (a.url && a.url.startsWith('http')) msg += `\n🔗 ${a.url}`;

  msg += `\n\n#Burundi #BurundiInforama`;
  return msg;
}

// --- POST TO TELEGRAM ---
async function postToTelegram(article) {
  const text = buildTelegramMessage(article);
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHANNEL, text, parse_mode: 'Markdown', disable_web_page_preview: false })
  });
  const d = await r.json();
  if (d.ok) {
    await markPosted(article._dedupKey || article.url, article.titre);
    totalPosted++;
    addLog(`✅ Telegram [${article.formatLabel || 'NEWS'}]: ${(article.titre || '').substring(0, 45)}`, 'ok');
    return true;
  } else {
    if (d.description && d.description.includes('parse')) {
      const r2 = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHANNEL, text: text.replace(/\*/g, ''), disable_web_page_preview: false })
      });
      const d2 = await r2.json();
      if (d2.ok) {
        await markPosted(article._dedupKey || article.url, article.titre);
        totalPosted++;
        addLog(`✅ Telegram [${article.formatLabel || 'NEWS'}]: ${(article.titre || '').substring(0, 45)}`, 'ok');
        return true;
      }
    }
    addLog(`❌ Telegram: ${d.description}`, 'err');
    return false;
  }
}

// --- POST TO FACEBOOK ---
async function postToFacebook(article) {
  if (!FB_PAGE_ID || !FB_ACCESS_TOKEN) return;
  const text = buildFacebookMessage(article);
  const body = { message: text, access_token: FB_ACCESS_TOKEN };
  if (article.url && article.url.startsWith('http')) body.link = article.url;

  const r = await fetch(`https://graph.facebook.com/v19.0/${FB_PAGE_ID}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const d = await r.json();
  if (d.id) {
    addLog(`✅ Facebook [${article.formatLabel || 'NEWS'}]: ${(article.titre || '').substring(0, 45)}`, 'ok');
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
  addLog(`Facebook: ${FB_PAGE_ID && FB_ACCESS_TOKEN ? 'OK' : 'Non configuré'}`, FB_PAGE_ID && FB_ACCESS_TOKEN ? 'ok' : 'err');
  addLog(`Intervalle: ${INTERVAL_HOURS}h`, 'info');
  addLog(`Formats: ${contentFormats.map(f => f.emoji + f.label).join(' | ')}`, 'info');

  if (!DATABASE_URL) {
    addLog('DATABASE_URL manquante! Ajoutez-la dans Render env vars.', 'err');
    return;
  }

  await setupDb();
  await cleanOldArticles();
  await runCycle();
  setInterval(runCycle, INTERVAL_HOURS * 3600000);
}

// --- DASHBOARD ---
app.get('/', (req, res) => {
  const logHtml = logs.map(l =>
    `<div class="log ${l.type}">[${l.time}] ${l.msg}</div>`
  ).join('');

  const formatsHtml = contentFormats.map((f, i) => {
    const isNext = i === (formatIndex % contentFormats.length);
    return `<div class="fmt ${isNext ? 'active' : ''}">${f.emoji} ${f.label}</div>`;
  }).join('');

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
.formats{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.fmt{font-size:0.7rem;background:#1a1c1e;border:1px solid #2a2c2e;border-radius:12px;padding:4px 10px;color:#6c7370}
.fmt.active{border-color:#00e676;color:#00e676;background:rgba(0,230,118,0.08)}
</style>
</head><body>
<h1>🇧🇮 BURUNDI INFORAMA</h1>
<p class="sub">@BurundiInforama · auto-refresh 30s</p>
<div class="grid">
  <div class="card"><div class="num" style="color:#00e676">${totalPosted}</div><div class="lbl">Postés</div></div>
  <div class="card"><div class="num" style="color:#40c4ff">${INTERVAL_HOURS}h</div><div class="lbl">Intervalle</div></div>
  <div class="card"><div class="num" style="color:#ffd740;font-size:0.65rem">${lastRun || '-'}</div><div class="lbl">Dernier</div></div>
</div>
<div class="box"><p class="sub">ROTATION DE CONTENU (prochain en vert)</p><div class="formats">${formatsHtml}</div></div>
<div class="box"><p class="sub">DERNIER RÉSULTAT</p><span class="badge">${lastResult}</span></div>
<div class="box"><p class="sub">PROCHAIN CYCLE</p><span class="badge">${nextRun || 'En attente...'}</span></div>
<div class="box"><p class="sub">JOURNAL</p>${logHtml || '<div class="log">Aucune activité</div>'}</div>
</body></html>`);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', totalPosted, lastRun, nextRun, lastResult, nextFormat: contentFormats[formatIndex % contentFormats.length]?.label });
});

app.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  start();
});
