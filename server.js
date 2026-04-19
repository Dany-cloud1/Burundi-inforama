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
  addLog('Recherche live...', 'info');
  if (!ANTHROPIC_KEY) { addLog('CLE API MANQUANTE!', 'err'); return []; }

  var headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': ANTHROPIC_KEY
  };

  // Single call: search + return JSON directly
  var res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: 'You are a Burundi news collector. Search for latest Burundi news in French or Kirundi. After searching, you MUST respond with ONLY a valid JSON object in this exact format, nothing else: {"articles":[{"id":"1","titre":"title","resume":"2-3 sentence summary in French","source":"source name","handle":"@handle","url":"url or null","langue":"fr","categorie":"politique","date":"date"}]}',
      messages: [{
        role: 'user',
        content: 'Search for the 6 most recent Burundi news articles published in the LAST 3 DAYS ONLY in French from iwacu-burundi.org, pnininahazwe on X, FOCODE_ on X, SOSMediasBDI on X, King Umurundi Freedom (@KUF_ASBL on X), RFI Afrique Burundi, BBC Afrique Burundi, Radio RPA (@rugbob78), Radio Humura, Radio Isanganiro, Radio Inkinzo, Radio Peace FM. IGNORE any article older than 3 days. Then return the JSON.'
      }]
    })
  });

  addLog('Status: ' + res.status, 'info');
  var data = await res.json();

  if (data.error) {
    addLog('Erreur: ' + data.error.message.substring(0, 80), 'err');
    return [];
  }

  // Extract all text from response
  var raw = '';
  if (data.content) {
    for (var i = 0; i < data.content.length; i++) {
      if (data.content[i].type === 'text') {
        raw += data.content[i].text;
      }
    }
  }

  addLog('Texte recu: ' + raw.substring(0, 100), 'info');

  // If no text yet, the model used tools - send follow up
  if (!raw || raw.trim().length < 10) {
    addLog('Envoi demande JSON...', 'info');

    var messages2 = [
      { role: 'user', content: 'Search for the 6 most recent Burundi news articles published in the LAST 3 DAYS ONLY in French from iwacu-burundi.org, pnininahazwe on X, FOCODE_ on X, SOSMediasBDI on X, King Umurundi Freedom (@KUF_ASBL on X), RFI Afrique Burundi, BBC Afrique Burundi, Radio RPA (@rugbob78), Radio Humura, Radio Isanganiro, Radio Inkinzo, Radio Peace FM. IGNORE any article older than 3 days. Then return the JSON.' },
      { role: 'assistant', content: data.content }
    ];

    var res2 = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: messages2,
        system: 'Return ONLY valid JSON in this format, no other text: {"articles":[{"id":"1","titre":"title in French","resume":"summary in French","source":"source","handle":"@handle","url":"url or null","langue":"fr","categorie":"politique","date":"date"}]}'
      })
    });

    var data2 = await res2.json();
    raw = '';
    if (data2.content) {
      for (var j = 0; j < data2.content.length; j++) {
        if (data2.content[j].type === 'text') raw += data2.content[j].text;
      }
    }
    addLog('JSON recu: ' + raw.substring(0, 100), 'info');
  }

  var match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    addLog('Pas de JSON dans: ' + raw.substring(0, 80), 'err');
    return [];
  }

  try {
    var parsed = JSON.parse(match[0]);
    var articles = parsed.articles || [];
    addLog(articles.length + ' articles!', articles.length > 0 ? 'ok' : 'err');
    return articles;
  } catch (e) {
    addLog('Erreur JSON: ' + e.message, 'err');
    return [];
  }
}

function buildMessage(a) {
  var cats = { politique: '🏛️', droits: '✊', economie: '💰', societe: '🌍', sport: '⚽' };
  var cat = cats[a.categorie] || '📰';
  var msg = cat + ' ' + (a.titre||'') + '\n\n' + (a.resume||'') + '\n\nSource: ' + (a.source||'');
  if (a.handle) msg += ' ' + a.handle;
  if (a.date) msg += '\n' + a.date;
  if (a.url) msg += '\n' + a.url;
  msg += '\n\n#Burundi #Actualites\nCanal: @BurundiInforama';
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
    postedTitles.push(article.titre);
    totalPosted++;
    addLog('Poste: ' + (article.titre||'').substring(0, 50), 'ok');
  } else {
    addLog('Erreur Telegram: ' + d.description, 'err');
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
  addLog('Intervalle: ' + INTERVAL_HOURS + 'h', 'info');
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




