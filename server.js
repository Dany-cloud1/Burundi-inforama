const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN || '8668406284:AAEbopVYNUdb6ZbJTwFZF_LMH7xiFs9pcXg';
const CHANNEL = process.env.CHANNEL || '@BurundiInforama';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const INTERVAL_HOURS = 2;

let postedTitles = new Set();
let totalPosted = 0;
let lastRun = null;
let nextRun = null;
let logs = [];

function addLog(msg, type = '') {
  const t = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const entry = { time: t, msg, type };
  logs.unshift(entry);
  if (logs.length > 100) logs.pop();
  console.log(`[${t}] ${msg}`);
}

async function fetchNews() {
  addLog('Recherche des dernières actualités burundaises…', 'info');
  const headers = { 'Content-Type': 'application/json' };
  if (ANTHROPIC_KEY) headers['x-api-key'] = ANTHROPIC_KEY;
  headers['anthropic-version'] = '2023-06-01';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: `Tu es un collecteur d'actualités spécialisé sur le Burundi pour le canal Telegram BURUNDI INFORAMA.
Cherche les toutes dernières nouvelles en FRANÇAIS ou KIRUNDI uniquement, publiées par :
- FOCODE (@FOCODE_ sur X / Facebook FocodeAsblBurundi)
- SOS Médias Burundi (@SOSMediasBDI sur X / Facebook sosmediasburundi)
- Pacifique Nininahazwe (@pnininahazwe sur X)
- Teddy Mazina (@TEDDYMAZINA sur X)
- King Umurundi Freedom (@KUF_ASBL sur X / kingumurundi-freedom.org)
- Iwacu Burundi (@iwacuinfo sur X / iwacu-burundi.org)
- Antoine Kaburahe (@AntoineKaburahe sur X)
- Bob Rugurika (@rugbob78 sur X) — Radio Publique Africaine RPA
- RFI Afrique Burundi, BBC Afrique Burundi

Retourne UNIQUEMENT un JSON valide sans markdown ni backticks :
{"articles":[{"id":"unique_id","titre":"...","resume":"2-3 phrases","source":"...","handle":"@handle","url":null,"langue":"fr ou rn","categorie":"politique|droits|économie|société|sport","date":"..."}]}
6 à 10 articles récents.`,
      messages: [{ role: 'user', content: 'Cherche les dernières actualités Burundi en français ou kirundi. JSON uniquement.' }]
    })
  });

  const data = await res.json();
  const raw = (data.content || []).map(i => i.type === 'text' ? i.text : '').join('');
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean).articles || [];
}

function buildMessage(a) {
  const cat = { politique: '🏛️', droits: '✊', économie: '💰', société: '🌍', sport: '⚽' }[a.categorie] || '📰';
  const tag = a.langue === 'rn' ? '#Burundi #Kirundi' : '#Burundi #Actualités';
  return `${cat} *${a.titre}*\n\n${a.resume}\n\n📌 _Source: ${a.source}${a.handle ? ' ' + a.handle : ''}_${a.date ? '\n🗓 ' + a.date : ''}${a.url ? '\n🔗 ' + a.url : ''}\n\n${tag}\n\n🇧🇮 _Canal: @BurundiInforama_`;
}

async function postToTelegram(article) {
  const text = buildMessage(article);
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHANNEL, text, parse_mode: 'Markdown', disable_web_page_preview: false })
  });
  const d = await r.json();
  if (d.ok) {
    postedTitles.add(article.titre);
    totalPosted++;
    addLog(`✅ Posté: "${article.titre.substring(0, 50)}…"`, 'ok');
  } else {
    addLog(`❌ Erreur Telegram: ${d.description}`, 'err');
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runCycle() {
  lastRun = new Date().toLocaleString('fr-FR');
  const next = new Date(Date.now() + INTERVAL_HOURS * 60 * 60 * 1000);
  nextRun = next.toLocaleString('fr-FR');
  addLog(`--- Cycle démarré (prochain dans ${INTERVAL_HOURS}h) ---`, 'info');
  try {
    const articles = await fetchNews();
    const fresh = articles.filter(a => !postedTitles.has(a.titre));
    addLog(`${articles.length} articles trouvés, ${fresh.length} nouveaux.`, fresh.length > 0 ? 'ok' : '');
    for (const a of fresh) {
      await postToTelegram(a);
      await sleep(2000);
    }
    if (fresh.length === 0) addLog('Aucun nouvel article à poster.', '');
  } catch (e) {
    addLog(`❌ Erreur cycle: ${e.message}`, 'err');
  }
}

async function startScheduler() {
  addLog(`🚀 BURUNDI INFORAMA démarré. Canal: ${CHANNEL}`, 'ok');
  addLog(`⏱ Auto-post toutes les ${INTERVAL_HOURS} heures.`, 'info');
  await runCycle();
  setInterval(runCycle, INTERVAL_HOURS * 60 * 60 * 1000);
}

app.get('/', (req, res) => {
  const logHtml = logs.map(l => `<div class="log ${l.type}">[${l.time}] ${l.msg}</div>`).join('');
  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>BURUNDI INFORAMA — Dashboard</title>
<style>
  body{background:#08090a;color:#eef0ee;font-family:'Segoe UI',sans-serif;margin:0;padding:16px}
  h1{font-size:1.3rem;color:#00e676;margin-bottom:4px}
  .sub{color:#6c7370;font-size:0.8rem;margin-bottom:20px}
  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px}
  .stat{background:#111314;border:1px solid #252829;border-radius:10px;padding:14px;text-align:center}
  .stat .n{font-size:1.8rem;font-weight:700;line-height:1}
  .stat .l{font-size:0.65rem;color:#6c7370;text-transform:uppercase;letter-spacing:1px;margin-top:4px}
  .box{background:#111314;border:1px solid #252829;border-radius:10px;padding:14px;margin-bottom:14px}
  .box h3{font-size:0.75rem;color:#6c7370;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:10px}
  .log{font-size:0.75rem;font-family:monospace;padding:3px 0;border-bottom:1px solid #1a1d1e;color:#6c7370}
  .log.ok{color:#00e676} .log.err{color:#ff5252} .log.info{color:#40c4ff}
  .badge{display:inline-block;background:rgba(0,230,118,0.1);border:1px solid rgba(0,230,118,0.3);color:#00e676;border-radius:20px;padding:4px 12px;font-size:0.75rem;font-weight:600}
</style>
</head>
<body>
<h1>🇧🇮 BURUNDI INFORAMA</h1>
<div class="sub">Dashboard · Canal: @BurundiInforama · Auto-refresh 60s</div>
<div class="stats">
  <div class="stat"><div class="n" style="color:#00e676">${totalPosted}</div><div class="l">Postés</div></div>
  <div class="stat"><div class="n" style="color:#40c4ff">${INTERVAL_HOURS}h</div><div class="l">Intervalle</div></div>
  <div class="stat"><div class="n" style="color:#ffd740;font-size:0.75rem">${lastRun || '—'}</div><div class="l">Dernier cycle</div></div>
</div>
<div class="box"><h3>Prochain post</h3><span class="badge">⏱ ${nextRun || 'En attente…'}</span></div>
<div class="box"><h3>Journal</h3>${logHtml || '<div class="log">Aucune activité.</div>'}</div>
</body></html>`);
});

app.get('/health', (req, res) => res.json({ status: 'ok', totalPosted, lastRun, nextRun }));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startScheduler();
});
