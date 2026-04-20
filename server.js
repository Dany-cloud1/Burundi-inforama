const express = require('express');
const app = express();
const fs = require('fs');
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN || '8668406284:AAEbopVYNUdb6ZbJTwFZF_LMH7xiFs9pcXg';
const CHANNEL = process.env.CHANNEL || '@BurundiInforama';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const INTERVAL_HOURS = parseFloat(process.env.INTERVAL_HOURS || '1');

const FB_PAGE_ID = process.env.FB_PAGE_ID;
const FB_ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN;

const SEEN_FILE = '/tmp/seen_articles.json';
const MAX_SEEN = 500;

// 22 sources in 7 groups + 1 dedicated Kirundi group
const SOURCE_GROUPS = [
  { label: 'Iwacu/RFI/BBC',                                   sources: 'iwacu-burundi.org, RFI Afrique Burundi, BBC Afrique Burundi',          lang: 'French' },
  { label: 'FOCODE/SOSMedias/Nininahazwe',                    sources: 'FOCODE_ on X, SOSMediasBDI on X, pnininahazwe on X',                   lang: 'French or Kirundi' },
  { label: 'KUF/TeddyMazina/Kaburahe',                        sources: 'KUF Burundi on X, TeddyMazina on X, Kaburahe on X',                    lang: 'French or Kirundi' },
  { label: 'Rugurika/RadioHumura/RadioIsanganiro',            sources: 'Rugurika on X, Radio Humura Burundi, isanganiro.org',                   lang: 'French or Kirundi' },
  { label: 'RadioInkinzo/RadioPeaceFM/ntarehouse',            sources: 'Radio Inkinzo Burundi, Radio Peace FM Burundi, ntarehouse on X',        lang: 'French or Kirundi' },
  { label: 'RTNBurundi/GeneralNeva/Baratuza2000',             sources: 'RTNBurundi on X, GeneralNeva on X, Baratuza2000 on X',                  lang: 'French or Kirundi' },
  { label: 'RT_Isanganiro/kwaNtare/BurundiGov/nshingamateka', sources: 'RT_Isanganiro on X, kwaNtare on X, BurundiGov on X, nshingamateka on X', lang: 'French or Kirundi' },
  { label: 'Kirundi ONLY',                                    sources: 'Rugurika on X, RTNBurundi on X, kwaNtare on X, Radio Isanganiro Kirundi, nshingamateka on X', lang: 'Kirundi ONLY — do not return French articles' }
];

// --- Seen articles: store both URL and normalized title ---
function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
  } catch (e) {}
  return { urls: [], titles: [] };
}

function saveSeen(seen) {
  try {
    seen.urls = seen.urls.slice(-MAX_SEEN);
    seen.titles = seen.titles.slice(-MAX_SEEN);
    fs.writeFileSync(SEEN_FILE, JSON.stringify(seen));
  } catch (e) {}
}

function normalize(t) {
  if (!t) return '';
  return t.toLowerCase().replace(/[^a-z0-9\u00C0-\u024F]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isSeen(article, seen) {
  // 1. URL match (most reliable)
  if (article.url && seen.urls.indexOf(article.url) !== -1) return true;
  // 2. Exact title match
  var norm = normalize(article.titre);
  if (seen.titles.indexOf(norm) !== -1) return true;
  // 3. Fuzzy title match — 70% keyword overlap
  var newWords = norm.split(' ').filter(function(w) { return w.length > 4; });
  for (var i = 0; i < seen.titles.length; i++) {
    var oldWords = seen.titles[i].split(' ').filter(function(w) { return w.length > 4; });
    if (newWords.length === 0) continue;
    var matches = newWords.filter(function(w) { return oldWords.indexOf(w) !== -1; });
    if (matches.length / newWords.length >= 0.7) return true;
  }
  return false;
}

function markSeen(article, seen) {
  if (article.url) seen.urls.push(article.url);
  seen.titles.push(normalize(article.titre));
  saveSeen(seen);
}

var seen = loadSeen();
var totalPosted = 0;
var lastRun = null;
var nextRun = null;
var lastResult = 'En attente...';
var logs = [];

function addLog(msg, type) {
  if (!type) type = '';
  var t = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  logs.unshift({ time: t, msg: msg, type: type });
  if (logs.length > 100) logs.pop();
  console.log('[' + t + '] ' + msg);
}

async function fetchFromGroup(group, today, headers) {
  // Give AI the last 20 seen titles to avoid
  var recentTitles = seen.titles.slice(-20);
  var avoidList = recentTitles.length > 0
    ? '\n\nDO NOT include articles similar to these already-posted ones:\n- ' + recentTitles.join('\n- ')
    : '';

  var prompt = 'Today is ' + today + '. Search for the 2 most recent Burundi news articles published TODAY or in the last 24 hours, from ONLY these sources: ' + group.sources + '. Language: ' + group.lang + '. Articles must have a real URL. Newest first. Only include genuinely new stories not similar to recent ones.' + avoidList + '\n\nReturn ONLY the JSON.';

  var res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: 'You are a Burundi news collector. Search the web and respond ONLY with valid JSON. Format: {"articles":[{"id":"1","titre":"title in original language","resume":"summary max 80 chars — keep original language (Kirundi or French)","source":"name","handle":"@x","url":"REAL URL - required","langue":"fr or rn","categorie":"politique","date":"date"}]} — ONLY include articles with a real verifiable URL. Keep Kirundi articles in Kirundi, French articles in French.',
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }]
    })
  });

  var data = await res.json();
  if (data.error) { addLog('Err ' + group.label + ': ' + data.error.message.substring(0, 50), 'err'); return []; }

  var raw = '';
  if (data.content) {
    for (var i = 0; i < data.content.length; i++) {
      if (data.content[i].type === 'text') raw += data.content[i].text;
    }
  }

  if (!raw || raw.trim().length < 5) {
    var res2 = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        system: 'Respond ONLY with valid JSON. Format: {"articles":[{"id":"1","titre":"title in original language","resume":"summary max 80 chars in original language","source":"name","handle":"@x","url":"REAL URL","langue":"fr or rn","categorie":"politique","date":"date"}]}',
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: data.content },
          { role: 'user', content: 'Respond with ONLY the JSON. Start with { end with }.' }
        ]
      })
    });
    var data2 = await res2.json();
    raw = '';
    if (data2.content) {
      for (var j = 0; j < data2.content.length; j++) {
        if (data2.content[j].type === 'text') raw += data2.content[j].text;
      }
    }
  }

  var start = raw.indexOf('{');
  var end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) return [];

  try {
    var parsed = JSON.parse(raw.substring(start, end + 1));
    // Only keep articles with a real URL
    return (parsed.articles || []).filter(function(a) {
      return a.url && a.url.startsWith('http');
    });
  } catch (e) { return []; }
}

async function fetchNews() {
  addLog('Recherche multi-sources (' + SOURCE_GROUPS.length + ' groupes)...', 'info');
  if (!ANTHROPIC_KEY) { addLog('CLE API MANQUANTE!', 'err'); return []; }

  var headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': ANTHROPIC_KEY
  };

  var today = new Date().toDateString();
  var freshArticles = [];

  for (var g = 0; g < SOURCE_GROUPS.length; g++) {
    var group = SOURCE_GROUPS[g];
    addLog('Groupe ' + (g + 1) + '/' + SOURCE_GROUPS.length + ': ' + group.label, 'info');
    var articles = await fetchFromGroup(group, today, headers);
    var groupFresh = articles.filter(function(a) { return !isSeen(a, seen); });
    addLog(group.label + ': ' + groupFresh.length + '/' + articles.length + ' nouveaux', groupFresh.length > 0 ? 'ok' : '');
    freshArticles = freshArticles.concat(groupFresh);
    await new Promise(function(r) { setTimeout(r, 1500); });
  }

  addLog('Total nouveaux: ' + freshArticles.length, freshArticles.length > 0 ? 'ok' : '');
  return freshArticles;
}

function buildMessage(a) {
  var cats = { politique: '🏛️', droits: '✊', economie: '💰', societe: '🌍', sport: '⚽' };
  var cat = cats[a.categorie] || '📰';
  var lang = (a.langue === 'rn') ? ' 🇧🇮 Kirundi' : '';
  var msg = cat + ' ' + (a.titre || '') + lang + '\n\n' + (a.resume || '') + '\n\nSource: ' + (a.source || '');
  if (a.handle) msg += ' ' + a.handle;
  if (a.date) msg += '\n' + a.date;
  if (a.url) msg += '\n' + a.url;
  msg += '\n\n#Burundi #Actualites\nCanal: @BurundiInforama';
  return msg;
}

function buildFacebookMessage(a) {
  var cats = { politique: '🏛️', droits: '✊', economie: '💰', societe: '🌍', sport: '⚽' };
  var cat = cats[a.categorie] || '📰';
  var msg = cat + ' ' + (a.titre || '') + '\n\n' + (a.resume || '') + '\n\nSource: ' + (a.source || '');
  if (a.handle) msg += ' ' + a.handle;
  if (a.date) msg += '\n' + a.date;
  if (a.url) msg += '\n\n🔗 ' + a.url;
  msg += '\n\n#Burundi #Actualites #BurundiInforama';
  return msg;
}

async function postToTelegram(article) {
  var text = buildMessage(article);
  var r = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHANNEL, text: text, disable_web_page_preview: false })
  });
  var d = await r.json();
  if (d.ok) {
    markSeen(article, seen);
    totalPosted++;
    addLog('Poste Telegram: ' + (article.titre || '').substring(0, 50), 'ok');
  } else {
    addLog('Erreur Telegram: ' + d.description, 'err');
  }
}

async function postToFacebook(article) {
  if (!FB_PAGE_ID || !FB_ACCESS_TOKEN) return;
  var text = buildFacebookMessage(article);
  var url = 'https://graph.facebook.com/v19.0/' + FB_PAGE_ID + '/feed';
  var body = { message: text, access_token: FB_ACCESS_TOKEN };
  if (article.url) body.link = article.url;
  var r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  var d = await r.json();
  if (d.id) {
    addLog('Poste Facebook: ' + (article.titre || '').substring(0, 50), 'ok');
  } else {
    addLog('Erreur Facebook: ' + JSON.stringify(d).substring(0, 80), 'err');
  }
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function runCycle() {
  lastRun = new Date().toLocaleString('fr-FR');
  nextRun = new Date(Date.now() + INTERVAL_HOURS * 3600000).toLocaleString('fr-FR');
  addLog('--- Cycle demarre ---', 'info');
  try {
    var articles = await fetchNews();

    if (articles.length === 0) {
      // ✅ Nothing new — skip silently, no posting
      lastResult = 'Rien de nouveau';
      addLog('Rien de nouveau — aucun post envoye', 'info');
      return;
    }

    lastResult = articles.length + ' nouveaux articles';
    for (var j = 0; j < articles.length; j++) {
      await postToTelegram(articles[j]);
      await sleep(2000);
      await postToFacebook(articles[j]);
      await sleep(2000);
    }
  } catch (e) {
    addLog('Erreur: ' + e.message, 'err');
  }
}

async function startScheduler() {
  addLog('BURUNDI INFORAMA demarre sur ' + CHANNEL, 'ok');
  addLog('Cle API: ' + (ANTHROPIC_KEY ? 'OK' : 'MANQUANTE!'), ANTHROPIC_KEY ? 'ok' : 'err');
  addLog('Facebook: ' + (FB_PAGE_ID && FB_ACCESS_TOKEN ? 'OK' : 'Non configure'), FB_PAGE_ID && FB_ACCESS_TOKEN ? 'ok' : 'err');
  addLog('Sources: ' + SOURCE_GROUPS.length + ' groupes / 22 sources', 'info');
  addLog('Articles vus: ' + seen.urls.length, 'info');
  addLog('Intervalle: ' + INTERVAL_HOURS + 'h', 'info');
  await runCycle();
  setInterval(runCycle, INTERVAL_HOURS * 3600000);
}

app.get('/', function(req, res) {
  var logHtml = logs.map(function(l) {
    return '<div class="log ' + l.type + '">[' + l.time + '] ' + l.msg + '</div>';
  }).join('');
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="refresh" content="30"><title>BURUNDI INFORAMA</title><style>body{background:#08090a;color:#eef0ee;font-family:sans-serif;padding:16px}h1{color:#00e676}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0}.stat{background:#111314;border:1px solid #252829;border-radius:10px;padding:14px;text-align:center}.n{font-size:1.8rem;font-weight:700}.l{font-size:0.65rem;color:#6c7370;text-transform:uppercase;margin-top:4px}.box{background:#111314;border:1px solid #252829;border-radius:10px;padding:14px;margin-bottom:14px}.log{font-size:0.75rem;font-family:monospace;padding:3px 0;color:#6c7370}.ok{color:#00e676}.err{color:#ff5252}.info{color:#40c4ff}.badge{background:rgba(0,230,118,0.1);border:1px solid rgba(0,230,118,0.3);color:#00e676;border-radius:20px;padding:4px 12px;font-size:0.75rem}</style></head><body><h1>🇧🇮 BURUNDI INFORAMA</h1><p style="color:#6c7370">@BurundiInforama · refresh 30s</p><div class="stats"><div class="stat"><div class="n" style="color:#00e676">' + totalPosted + '</div><div class="l">Postes</div></div><div class="stat"><div class="n" style="color:#40c4ff">' + INTERVAL_HOURS + 'h</div><div class="l">Intervalle</div></div><div class="stat"><div class="n" style="color:#ffd740;font-size:0.7rem">' + (lastRun||'-') + '</div><div class="l">Dernier</div></div></div><div class="box"><p style="color:#6c7370;font-size:0.75rem">DERNIER RESULTAT</p><span class="badge">' + lastResult + '</span></div><div class="box"><p style="color:#6c7370;font-size:0.75rem">PROCHAIN POST</p><span class="badge">' + (nextRun||'En attente...') + '</span></div><div class="box"><p style="color:#6c7370;font-size:0.75rem">JOURNAL</p>' + (logHtml||'<div class="log">Aucune activite</div>') + '</div></body></html>');
});

app.get('/health', function(req, res) {
  res.json({ status: 'ok', totalPosted: totalPosted, lastRun: lastRun, nextRun: nextRun, seenCount: seen.urls.length, lastResult: lastResult });
});

app.listen(PORT, function() {
  console.log('Server running on port ' + PORT);
  startScheduler();
});


