const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN || '8668406284:AAEbopVYNUdb6ZbJTwFZF_LMH7xiFs9pcXg';
const CHANNEL = process.env.CHANNEL || '@BurundiInforama';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const INTERVAL_HOURS = parseInt(process.env.INTERVAL_HOURS || '1');

var postedTitles = [];
var totalPosted = 0;
var lastRun = null;
var nextRun = null;
var logs = [];

function addLog(msg, type) {
  if (!type) type = '';
  var t = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  logs.unshift({ time: t, msg: msg, type: type });
  if (logs.length > 100) logs.pop();
  console.log('[' + t + '] ' + msg);
}

async function fetchNews() {
  addLog('Recherche live avec web search...', 'info');

  if (!ANTHROPIC_KEY) {
    addLog('CLE API MANQUANTE!', 'err');
    return [];
  }

  var headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': ANTHROPIC_KEY
  };

  // Step 1: Web search for real news
  var searchRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 3000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: 'Recherche les toutes dernieres actualites publiees aujourd hui ou cette semaine sur le Burundi par: Pacifique Nininahazwe (@pnininahazwe sur X/Twitter), FOCODE (@FOCODE_ sur X), SOS Medias Burundi (@SOSMediasBDI sur X), Teddy Mazina (@TEDDYMAZINA sur X), King Umurundi Freedom (@KUF_ASBL sur X), Iwacu Burundi (iwacu-burundi.org et @iwacuinfo), Antoine Kaburahe (@AntoineKaburahe sur X), Bob Rugurika RPA (@rugbob78 sur X), RFI Afrique Burundi, BBC Afrique Burundi. Cherche aussi sur leurs pages Facebook. Trouve minimum 6 articles tres recents en francais ou kirundi.'
      }]
    })
  });

  addLog('Status web search: ' + searchRes.status, 'info');
  var searchData = await searchRes.json();

  if (searchData.error) {
    addLog('Erreur web search: ' + searchData.error.message, 'err');
    return [];
  }

  addLog('Web search reussi!', 'ok');

  // Step 2: Extract JSON from results
  var messages = [
    {
      role: 'user',
      content: 'Recherche les toutes dernieres actualites publiees aujourd hui ou cette semaine sur le Burundi par: Pacifique Nininahazwe (@pnininahazwe sur X/Twitter), FOCODE (@FOCODE_ sur X), SOS Medias Burundi (@SOSMediasBDI sur X), Teddy Mazina (@TEDDYMAZINA sur X), King Umurundi Freedom (@KUF_ASBL sur X), Iwacu Burundi (iwacu-burundi.org et @iwacuinfo), Antoine Kaburahe (@AntoineKaburahe sur X), Bob Rugurika RPA (@rugbob78 sur X), RFI Afrique Burundi, BBC Afrique Burundi. Cherche aussi sur leurs pages Facebook. Trouve minimum 6 articles tres recents en francais ou kirundi.'
    },
    { role: 'assistant', content: searchData.content }
  ];

  messages.push({
    role: 'user',
    content: 'Parfait. Maintenant retourne UNIQUEMENT ce JSON valide sans aucun texte avant ou apres, sans markdown, sans backticks: {"articles":[{"id":"1","titre":"titre exact de l article","resume":"resume de 2-3 phrases en francais ou kirundi","source":"nom exact de la source","handle":"@handle","url":"url de l article ou null","langue":"fr ou rn","categorie":"politique ou droits ou economie ou societe ou sport","date":"date exacte de publication"}]}'
  });

  var jsonRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      messages: messages
    })
  });

  var jsonData = await jsonRes.json();
  var raw = '';
  if (jsonData.content) {
    for (var i = 0; i < jsonData.content.length; i++) {
      if (jsonData.content[i].type === 'text') raw += jsonData.content[i].text;
    }
  }

  addLog('Reponse JSON: ' + raw.substring(0, 150), 'info');

  var match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    addLog('Pas de JSON trouve', 'err');
    return [];
  }

  try {
    var parsed = JSON.parse(match[0]);
    var articles = parsed.articles || [];
    addLog('Articles trouves: ' + articles.length, articles.length > 0 ? 'ok' : 'err');
    return articles;
  } catch (e) {
    addLog('Erreur JSON: ' + e.message, 'err');
    return [];
  }
}

function buildMessage(a) {
  var cats = { politique: '🏛️', droits: '✊', economie: '💰', societe: '🌍', sport: '⚽' };
  var cat = cats[a.categorie] || '📰';
  var tag = a.langue === 'rn' ? '#Burundi #Kirundi' : '#Burundi #Actualites';
  var msg = cat + ' *' + a.titre + '*\n\n' + a.resume + '\n\n📌 _Source: ' + a.source;
  if (a.handle) msg += ' ' + a.handle;
  msg += '_';
  if (a.date) msg += '\n🗓 ' + a.date;
  if (a.url) msg += '\n🔗 ' + a.url;
  msg += '\n\n' + tag + '\n\n🇧🇮 _Canal: @BurundiInforama_';
  return msg;
}

async function postToTelegram(article) {
  // Clean markdown special chars from title and resume
  var text = buildMessage(article);
  var r = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHANNEL, text: text, parse_mode: 'Markdown', disable_web_page_preview: false })
  });
  var d = await r.json();
  if (d.ok) {
    postedTitles.push(article.titre);
    totalPosted++;
    addLog('Poste: ' + article.titre.substring(0, 50), 'ok');
  } else {
    // Try without markdown if parsing fails
    var r2 = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHANNEL, text: text.replace(/[*_]/g, ''), disable_web_page_preview: false })
    });
    var d2 = await r2.json();
    if (d2.ok) {
      postedTitles.push(article.titre);
      totalPosted++;
      addLog('Poste (sans markdown): ' + article.titre.substring(0, 50), 'ok');
    } else {
      addLog('Erreur Telegram: ' + d2.description, 'err');
    }
  }
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function runCycle() {
  lastRun = new Date().toLocaleString('fr-FR');
  nextRun = new Date(Date.now() + INTERVAL_HOURS * 3600000).toLocaleString('fr-FR');
  addLog('--- Cycle demarre ---', 'info');
  try {
    var articles = await fetchNews();
    var fresh = [];
    for (var i = 0; i < articles.length; i++) {
      if (postedTitles.indexOf(articles[i].titre) === -1) fresh.push(articles[i]);
    }
    addLog(articles.length + ' articles, ' + fresh.length + ' nouveaux', fresh.length > 0 ? 'ok' : '');
    for (var j = 0; j < fresh.length; j++) {
      await postToTelegram(fresh[j]);
      await sleep(2000);
    }
    if (fresh.length === 0) addLog('Aucun nouvel article', '');
  } catch (e) {
    addLog('Erreur: ' + e.message, 'err');
  }
}

async function startScheduler() {
  addLog('BURUNDI INFORAMA demarre sur ' + CHANNEL, 'ok');
  addLog('Cle API: ' + (ANTHROPIC_KEY ? 'OK' : 'MANQUANTE!'), ANTHROPIC_KEY ? 'ok' : 'err');
  addLog('Intervalle: toutes les ' + INTERVAL_HOURS + 'h', 'info');
  await runCycle();
  setInterval(runCycle, INTERVAL_HOURS * 3600000);
}

app.get('/', function(req, res) {
  var logHtml = logs.map(function(l) {
    return '<div class="log ' + l.type + '">[' + l.time + '] ' + l.msg + '</div>';
  }).join('');
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="refresh" content="30"><title>BURUNDI INFORAMA</title><style>body{background:#08090a;color:#eef0ee;font-family:sans-serif;padding:16px}h1{color:#00e676}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0}.stat{background:#111314;border:1px solid #252829;border-radius:10px;padding:14px;text-align:center}.n{font-size:1.8rem;font-weight:700}.l{font-size:0.65rem;color:#6c7370;text-transform:uppercase;margin-top:4px}.box{background:#111314;border:1px solid #252829;border-radius:10px;padding:14px;margin-bottom:14px}.log{font-size:0.75rem;font-family:monospace;padding:3px 0;color:#6c7370}.ok{color:#00e676}.err{color:#ff5252}.info{color:#40c4ff}.badge{background:rgba(0,230,118,0.1);border:1px solid rgba(0,230,118,0.3);color:#00e676;border-radius:20px;padding:4px 12px;font-size:0.75rem}</style></head><body><h1>🇧🇮 BURUNDI INFORAMA</h1><p style="color:#6c7370">@BurundiInforama · refresh 30s</p><div class="stats"><div class="stat"><div class="n" style="color:#00e676">' + totalPosted + '</div><div class="l">Postes</div></div><div class="stat"><div class="n" style="color:#40c4ff">' + INTERVAL_HOURS + 'h</div><div class="l">Intervalle</div></div><div class="stat"><div class="n" style="color:#ffd740;font-size:0.7rem">' + (lastRun||'-') + '</div><div class="l">Dernier</div></div></div><div class="box"><p style="color:#6c7370;font-size:0.75rem">PROCHAIN POST</p><span class="badge">' + (nextRun||'En attente...') + '</span></div><div class="box"><p style="color:#6c7370;font-size:0.75rem">JOURNAL</p>' + (logHtml||'<div class="log">Aucune activite</div>') + '</div></body></html>');
});

app.get('/health', function(req, res) {
  res.json({ status: 'ok', totalPosted: totalPosted, lastRun: lastRun, nextRun: nextRun });
});

app.listen(PORT, function() {
  console.log('Server running on port ' + PORT);
  startScheduler();
});

