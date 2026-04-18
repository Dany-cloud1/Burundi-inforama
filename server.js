cat > /mnt/user-data/outputs/server.js << 'ENDOFFILE'
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN || '8668406284:AAEbopVYNUdb6ZbJTwFZF_LMH7xiFs9pcXg';
const CHANNEL = process.env.CHANNEL || '@BurundiInforama';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const INTERVAL_HOURS = 2;

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
  addLog('Recherche des actualites...', 'info');

  var headers = { 'Content-Type': 'application/json' };
  if (ANTHROPIC_KEY) headers['x-api-key'] = ANTHROPIC_KEY;
  headers['anthropic-version'] = '2023-06-01';

  // Step 1: search for news
  var searchRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: 'Search for the latest news about Burundi today from FOCODE, SOS Medias Burundi, Pacifique Nininahazwe, Teddy Mazina, King Umurundi Freedom, Iwacu Burundi, Antoine Kaburahe, Bob Rugurika RPA. Find at least 6 recent articles in French or Kirundi language.'
      }]
    })
  });

  var searchData = await searchRes.json();

  // Build conversation with search results
  var messages = [
    { role: 'user', content: 'Search for the latest news about Burundi today from FOCODE, SOS Medias Burundi, Pacifique Nininahazwe, Teddy Mazina, King Umurundi Freedom, Iwacu Burundi, Antoine Kaburahe, Bob Rugurika RPA. Find at least 6 recent articles in French or Kirundi language.' },
    { role: 'assistant', content: searchData.content }
  ];

  messages.push({
    role: 'user',
    content: 'Now based on your search results, give me ONLY a valid JSON object with no other text, no markdown, no explanation. Format: {"articles":[{"id":"1","titre":"title","resume":"2-3 sentence summary in French","source":"source name","handle":"@handle","url":"url or null","langue":"fr or rn","categorie":"politique or droits or economie or societe or sport","date":"date"}]}'
  });

  // Step 2: get JSON from the results
  var jsonRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: messages
    })
  });

  var jsonData = await jsonRes.json();
  var raw = '';
  if (jsonData.content) {
    for (var i = 0; i < jsonData.content.length; i++) {
      if (jsonData.content[i].type === 'text') {
        raw += jsonData.content[i].text;
      }
    }
  }

  addLog('Reponse API: ' + raw.substring(0, 100), 'info');

  var match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    addLog('Pas de JSON trouve', 'err');
    return [];
  }
  try {
    var parsed = JSON.parse(match[0]);
    return parsed.articles || [];
  } catch (e) {
    addLog('Erreur JSON: ' + e.message, 'err');
    return [];
  }
}

function buildMessage(a) {
  var cat = { politique: '🏛️', droits: '✊', economie: '💰', societe: '🌍', sport: '⚽' }[a.categorie] || '📰';
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
    addLog('Erreur Telegram: ' + d.description, 'err');
  }
}

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

async function runCycle() {
  lastRun = new Date().toLocaleString('fr-FR');
  nextRun = new Date(Date.now() + INTERVAL_HOURS * 3600000).toLocaleString('fr-FR');
  addLog('--- Cycle demarre ---', 'info');
  try {
    var articles = await fetchNews();
    var fresh = [];
    for (var i = 0; i < articles.length; i++) {
      if (postedTitles.indexOf(articles[i].titre) === -1) {
        fresh.push(articles[i]);
      }
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
  addLog('Auto-post toutes les ' + INTERVAL_HOURS + 'h', 'info');
  await runCycle();
  setInterval(runCycle, INTERVAL_HOURS * 3600000);
}

app.get('/', function(req, res) {
  var logHtml = logs.map(function(l) {
    return '<div class="log ' + l.type + '">[' + l.time + '] ' + l.msg + '</div>';
  }).join('');
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="refresh" content="60"><title>BURUNDI INFORAMA</title><style>body{background:#08090a;color:#eef0ee;font-family:sans-serif;padding:16px}h1{color:#00e676}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0}.stat{background:#111314;border:1px solid #252829;border-radius:10px;padding:14px;text-align:center}.n{font-size:1.8rem;font-weight:700}.l{font-size:0.65rem;color:#6c7370;text-transform:uppercase;margin-top:4px}.box{background:#111314;border:1px solid #252829;border-radius:10px;padding:14px;margin-bottom:14px}.log{font-size:0.75rem;font-family:monospace;padding:3px 0;color:#6c7370}.ok{color:#00e676}.err{color:#ff5252}.info{color:#40c4ff}.badge{background:rgba(0,230,118,0.1);border:1px solid rgba(0,230,118,0.3);color:#00e676;border-radius:20px;padding:4px 12px;font-size:0.75rem}</style></head><body><h1>🇧🇮 BURUNDI INFORAMA</h1><p style="color:#6c7370">@BurundiInforama · refresh 60s</p><div class="stats"><div class="stat"><div class="n" style="color:#00e676">' + totalPosted + '</div><div class="l">Postes</div></div><div class="stat"><div class="n" style="color:#40c4ff">' + INTERVAL_HOURS + 'h</div><div class="l">Intervalle</div></div><div class="stat"><div class="n" style="color:#ffd740;font-size:0.7rem">' + (lastRun||'-') + '</div><div class="l">Dernier</div></div></div><div class="box"><p style="color:#6c7370;font-size:0.75rem">PROCHAIN POST</p><span class="badge">' + (nextRun||'En attente...') + '</span></div><div class="box"><p style="color:#6c7370;font-size:0.75rem">JOURNAL</p>' + (logHtml||'<div class="log">Aucune activite</div>') + '</div></body></html>');
});

app.get('/health', function(req, res) {
  res.json({ status: 'ok', totalPosted: totalPosted, lastRun: lastRun, nextRun: nextRun });
});

app.listen(PORT, function() {
  console.log('Server running on port ' + PORT);
  startScheduler();
});
ENDOFFILE
echo "Done"
