/* CheckFit - servidor de notificações
   - agendar: o app pede um aviso para daqui a X segundos (fim do descanso do treino)
   - enviarAgendado: fila que dispara o aviso na hora certa (Cloud Tasks)
   - testar: envia uma notificação de teste
   - lembretesTick: a cada 15 min envia os lembretes do dia (refeições, água, peso, sequência, cartas, suplementos e remédios)
   - lerPlano: lê o plano alimentar (foto ou PDF) com IA e devolve no formato do app */
const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {onTaskDispatched} = require('firebase-functions/v2/tasks');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {setGlobalOptions} = require('firebase-functions/v2');
const admin = require('firebase-admin');
const {getFunctions} = require('firebase-admin/functions');

admin.initializeApp();
setGlobalOptions({region: 'us-central1', memory: '256MiB', maxInstances: 5});
const db = admin.firestore();
const SITE = 'https://checkfitapp.com.br/';

async function enviar(uid, L, msg) {
  const tokens = (L.tokens || []).filter(Boolean);
  if (!tokens.length) return 0;
  const r = await admin.messaging().sendEachForMulticast({
    tokens,
    webpush: {
      headers: {Urgency: 'high', TTL: String(msg.ttl || 600)},
      notification: {title: msg.titulo, body: msg.corpo, icon: SITE + 'icon-192.png', tag: msg.tag || undefined},
      fcmOptions: {link: msg.url || SITE}
    },
    data: {tag: msg.tag || '', url: msg.url || SITE}
  });
  const ruins = [];
  r.responses.forEach((x, i) => {
    const c = !x.success && x.error && x.error.code;
    if (c === 'messaging/registration-token-not-registered' || c === 'messaging/invalid-registration-token' || c === 'messaging/invalid-argument') ruins.push(tokens[i]);
    else if (!x.success) console.warn('falha ao enviar', uid, c);
  });
  if (ruins.length) await db.doc('lembretes/' + uid).update({tokens: admin.firestore.FieldValue.arrayRemove(...ruins)});
  return r.successCount;
}

const txt = (v, max, padrao) => String(v || padrao).slice(0, max);

exports.agendar = onCall(async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Entre no app primeiro.');
  const seg = Math.max(5, Math.min(900, Math.round(+(req.data && req.data.seg) || 0)));
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await db.doc('lembretes/' + uid).set({descanso: id}, {merge: true});
  await getFunctions().taskQueue('locations/us-central1/functions/enviarAgendado').enqueue(
    {uid, id, tag: 'descanso', titulo: txt(req.data.titulo, 80, 'Descanso concluído ⏱️'), corpo: txt(req.data.corpo, 160, 'Hora da próxima série! 💪')},
    {scheduleDelaySeconds: seg + 2}
  );
  return {id};
});

exports.enviarAgendado = onTaskDispatched({retryConfig: {maxAttempts: 2, minBackoffSeconds: 5}, rateLimits: {maxConcurrentDispatches: 20}}, async (req) => {
  const {uid, id, tag, titulo, corpo} = req.data || {};
  if (!uid) return;
  const s = await db.doc('lembretes/' + uid).get();
  if (!s.exists) return;
  const L = s.data();
  if (tag === 'descanso' && L.descanso !== id) return; /* cancelado ou substituído pelo app */
  await enviar(uid, L, {titulo, corpo, tag, ttl: 120});
  if (tag === 'descanso') await db.doc('lembretes/' + uid).update({descanso: null});
});

exports.testar = onCall(async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Entre no app primeiro.');
  const s = await db.doc('lembretes/' + uid).get();
  if (!s.exists) throw new HttpsError('failed-precondition', 'Ative as notificações primeiro.');
  const n = await enviar(uid, s.data(), {titulo: 'CheckFit 🔔', corpo: 'Notificações ativadas! É assim que seus lembretes vão chegar.', tag: 'teste'});
  return {enviados: n};
});

/* ---------- lembretes do dia ---------- */
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const hm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? (+m[1]) * 60 + (+m[2]) : null; };
function eventos(L, agora) {
  const tz = typeof L.tz === 'number' ? L.tz : -180, P = Object.assign({refeicoes: true, agua: false, peso: false, pesoHora: '07:30', seq: true, carta: true, rem: true, remNome: false, remRep: true}, L.prefs || {});
  const out = [], hojeLoc = ymd(agora + tz * 60000);
  [0, 1].forEach((k) => {
    const data = ymd(Date.parse(hojeLoc + 'T00:00:00Z') + k * 864e5), base = Date.parse(data + 'T00:00:00Z') - tz * 60000;
    const add = (min, ev) => { if (min != null) out.push(Object.assign({t: base + min * 60000, data}, ev)); };
    if (P.refeicoes) (L.refeicoes || []).forEach((r) => add(hm(r.h), {tipo: 'ref', id: r.id, n: r.n}));
    if (P.agua) [600, 780, 960, 1140].forEach((m) => add(m, {tipo: 'agua'}));
    if (P.peso) add(hm(P.pesoHora) == null ? 450 : hm(P.pesoHora), {tipo: 'peso'});
    if (P.seq) add(1230, {tipo: 'seq'});
    if (P.carta && (L.cartas || []).includes(data)) add(540, {tipo: 'carta'});
    if (P.rem) (L.remedios || []).forEach((m) => {
      if (!remHoje(m, data)) return;
      (m.hs || []).forEach((h) => { const x = hm(h); if (x == null) return; add(x, {tipo: 'rem', id: m.id, h, m}); if (P.remRep !== false) add(x + 30, {tipo: 'rem', id: m.id, h, m, rep: true}); });
      if (m.ae) { const falta = Math.round((Date.parse(m.ae + 'T00:00:00Z') - Date.parse(data + 'T00:00:00Z')) / 864e5); if (falta === 5 || falta === 1) add(540, {tipo: 'est', id: m.id, m, falta}); }
    });
  });
  return out.sort((a, b) => a.t - b.t);
}
function remHoje(m, data) {
  if (m.ini && data < m.ini) return false;
  if (m.d === 'semana') return (m.wd || []).includes(new Date(data + 'T12:00:00Z').getUTCDay());
  if (m.d === 'alterna') return Math.round((Date.parse(data + 'T00:00:00Z') - Date.parse((m.ini || data) + 'T00:00:00Z')) / 864e5) % 2 === 0;
  return true;
}
const REM_IC = {remedio: '💊', suplemento: '🧴', vitamina: '🍊'};
function remMsg(evs, P) {
  const nome = !!P.remNome, rep = evs[0].rep, ms = evs.map((e) => e.m), so = (t) => ms.every((m) => (m.t || 'suplemento') === t);
  let titulo;
  if (nome) { const ns = ms.map((m) => m.n); titulo = (REM_IC[ms[0].t] || '💊') + ' ' + (ns.length > 1 ? ns.slice(0, -1).join(', ') + ' e ' + ns[ns.length - 1] : ns[0]); }
  else titulo = so('remedio') ? '💊 Hora da sua medicação' : ms.every((m) => m.t !== 'remedio') ? '🧴 Hora do seu suplemento' : '💊 Hora dos seus suplementos e remédios';
  const corpo = rep ? 'Você ainda não marcou como tomado. Toque para abrir e marcar.' : (nome && ms.length === 1 && ms[0].dose ? ms[0].dose + ' · ' : '') + 'Toque para abrir o CheckFit e marcar como tomado.';
  return {titulo: titulo.slice(0, 90), corpo, tag: 'rem-' + evs[0].h, url: SITE + '#rem'};
}
function registrou(d) {
  if (!d) return false;
  const meals = Object.values(d.meals || {}).some((r) => r && (r.skip || (r.extras || []).length || Object.values(r.items || {}).some((i) => i && i.on)));
  return meals || (d.agua || []).length > 0 || +d.peso > 0 || (d.treinos || []).length > 0 || (d.musc || []).length > 0 || Object.keys(d.tomas || {}).length > 0;
}
function mensagem(ev, d, L) {
  if (ev.tipo === 'ref') { const r = d && d.meals && d.meals[ev.id]; if (r && (r.skip || (r.extras || []).length || Object.values(r.items || {}).some((i) => i && i.on))) return null; return {titulo: '🍽️ ' + (ev.n || 'Hora da refeição'), corpo: 'Hora da refeição! Marque no CheckFit quando terminar.', tag: 'ref-' + ev.id}; }
  if (ev.tipo === 'agua') { const ml = ((d && d.agua) || []).reduce((a, x) => a + (+x || 0), 0); if (ml >= (L.aguaMeta || 2000)) return null; return {titulo: '💧 Hora de beber água', corpo: 'Um copo agora ajuda a bater a sua meta de hoje.', tag: 'agua'}; }
  if (ev.tipo === 'peso') { if (d && +d.peso > 0) return null; return {titulo: '⚖️ Registre seu peso', corpo: 'Leva 5 segundos e mantém sua evolução em dia.', tag: 'peso'}; }
  if (ev.tipo === 'seq') { if (registrou(d)) return null; return {titulo: '🔥 Sua sequência te espera', corpo: 'Registre qualquer coisa hoje para manter seus dias de presença.', tag: 'seq'}; }
  if (ev.tipo === 'est') return {titulo: L.prefs && L.prefs.remNome ? '📦 ' + ev.m.n + ' está acabando' : '📦 Um item está acabando', corpo: 'Pelas suas marcações, dura mais ' + ev.falta + (ev.falta === 1 ? ' dia' : ' dias') + '. Hora de repor.', tag: 'est-' + ev.id, url: SITE + '#rem'};
  if (ev.tipo === 'carta') return {titulo: '💌 Chegou uma carta sua', corpo: 'Você escreveu para o seu eu de hoje. Abra no CheckFit.', tag: 'carta'};
  return null;
}
async function processar(doc, agora) {
  const uid = doc.id, L = doc.data();
  if (!L.ativo || !(L.tokens || []).length) { await doc.ref.update({prox: agora + 7 * 864e5}); return; }
  const evs = eventos(L, agora), desde = Math.max(L.ultimo || 0, agora - 20 * 60000);
  const devidos = evs.filter((e) => e.t > desde && e.t <= agora), cache = {};
  const P = Object.assign({remNome: false}, L.prefs || {}), grupos = {};
  for (const ev of devidos) {
    if (!(ev.data in cache)) { const s = await db.doc(`users/${uid}/dias/${ev.data}`).get(); cache[ev.data] = s.exists ? s.data() : null; }
    if (ev.tipo === 'rem') {
      const d = cache[ev.data];
      if (d && d.tomas && d.tomas[ev.id + '@' + ev.h]) continue;
      const g = ev.data + ev.h + (ev.rep ? 'r' : ''); (grupos[g] = grupos[g] || []).push(ev); continue;
    }
    const m = mensagem(ev, cache[ev.data], L);
    if (m) await enviar(uid, L, m);
  }
  for (const g of Object.values(grupos)) await enviar(uid, L, remMsg(g, P));
  const prox = (evs.find((e) => e.t > agora) || {t: agora + 864e5}).t;
  await doc.ref.update({ultimo: agora, prox});
}
exports.lembretesTick = onSchedule({schedule: 'every 15 minutes', timeZone: 'America/Belem'}, async () => {
  const agora = Date.now();
  const q = await db.collection('lembretes').where('prox', '<=', agora).limit(500).get();
  for (const doc of q.docs) { try { await processar(doc, agora); } catch (e) { console.error('lembrete', doc.id, e); } }
});

/* ---------- Leitura do plano alimentar por IA (Claude API) ---------- */
const {defineSecret} = require('firebase-functions/params');
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const IA_MODELO = 'claude-sonnet-5-5';
const IA_LIMITE_DIA = 5;
const IA_INSTRUCOES = `Você transcreve planos alimentares prescritos por nutricionistas para o app CheckFit.
Regras obrigatórias:
- Transcreva fielmente o que está no documento. Não invente refeições, alimentos, quantidades nem horários.
- Não dê orientação nutricional, não altere quantidades e não sugira alimentos que não estejam no plano.
- Cada refeição tem uma ou mais opções (ex.: "Opção 1", "Opção 2"). Se o plano não separa opções, use uma opção só chamada "Plano".
- Dentro de cada opção, cada item é um grupo de alimentos. As substituições/equivalentes que o plano permite para aquele item ficam como escolhas do mesmo item, na ordem do documento (a principal primeiro).
- Quantidades exatamente como escritas (ex.: "2 colheres de sopa", "150 g", "1 unidade média").
- kcal: estimativa aproximada para a quantidade indicada, com base em tabelas como a TACO. Se não der para estimar, use 0.
- Horário no formato HH:MM quando o plano informar; se não informar, deixe vazio.
- Orientações gerais da refeição (ex.: "beber 500 ml de água ao acordar") vão em "dica".
- Água diária em ml, se o plano informar.
- Tudo que estiver ilegível, ambíguo ou incompleto vai para "duvidas", em frases curtas e claras para o paciente.
- Se o documento não for um plano alimentar, marque e_plano como false e não preencha refeições.`;
const IA_SCHEMA = {
  type: 'object',
  properties: {
    e_plano: {type: 'boolean'},
    nutri: {type: 'string', description: 'Nome e registro (CRN) do profissional, se aparecer'},
    data: {type: 'string', description: 'Data do plano, se aparecer'},
    agua_ml: {type: 'number'},
    refeicoes: {type: 'array', items: {type: 'object', properties: {
      nome: {type: 'string'}, horario: {type: 'string'}, dica: {type: 'string'},
      opcoes: {type: 'array', items: {type: 'object', properties: {
        rotulo: {type: 'string'},
        itens: {type: 'array', items: {type: 'object', properties: {
          escolhas: {type: 'array', items: {type: 'object', properties: {
            alimento: {type: 'string'}, quantidade: {type: 'string'}, kcal: {type: 'number'}
          }, required: ['alimento', 'quantidade', 'kcal']}}
        }, required: ['escolhas']}}
      }, required: ['rotulo', 'itens']}}
    }, required: ['nome', 'horario', 'opcoes']}},
    duvidas: {type: 'array', items: {type: 'string'}}
  },
  required: ['e_plano', 'refeicoes', 'duvidas']
};
const slug = (s, usados) => {
  let b = String(s || 'item').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16) || 'item', k = b, i = 2;
  while (usados.has(k)) k = b + (i++);
  usados.add(k); return k;
};
function iaParaPlano(r) {
  const ids = new Set(), corta = (s, n) => String(s || '').trim().slice(0, n);
  const meals = (r.refeicoes || []).map((m) => {
    const ks = new Set();
    const options = (m.opcoes || []).map((o) => ({
      label: corta(o.rotulo, 60) || 'Plano',
      items: (o.itens || []).map((it) => {
        const ch = (it.escolhas || []).filter((c) => c && c.alimento).map((c) => [corta(c.alimento, 80), corta(c.quantidade, 40), Math.max(0, Math.round(+c.kcal || 0))]);
        return ch.length ? {k: slug(ch[0][0], ks), ch} : null;
      }).filter(Boolean)
    })).filter((o) => o.items.length);
    const h = /^\d{1,2}:\d{2}$/.test(m.horario || '') ? m.horario.padStart(5, '0') : '';
    return options.length ? {id: slug(m.nome, ids), time: h, name: corta(m.nome, 40) || 'Refeição', tip: corta(m.dica, 300), options} : null;
  }).filter(Boolean);
  const p = {nutri: corta(r.nutri, 80), data: corta(r.data, 20), meals, fonte: 'ia'};
  if (r.agua_ml > 0 && r.agua_ml < 10000) p.agua = Math.round(r.agua_ml);
  return p;
}
exports.lerPlano = onCall({secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 180, memory: '512MiB'}, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Entre no app primeiro.');
  const arqs = (req.data && req.data.arquivos) || [];
  if (!Array.isArray(arqs) || !arqs.length || arqs.length > 6) throw new HttpsError('invalid-argument', 'Envie de 1 a 6 imagens, ou 1 PDF.');
  let total = 0;
  const conteudo = arqs.map((a) => {
    const tipo = String(a.tipo || ''), dados = String(a.dados || '');
    total += dados.length;
    if (tipo === 'application/pdf') return {type: 'document', source: {type: 'base64', media_type: 'application/pdf', data: dados}};
    if (/^image\/(jpeg|png|webp|gif)$/.test(tipo)) return {type: 'image', source: {type: 'base64', media_type: tipo, data: dados}};
    throw new HttpsError('invalid-argument', 'Formato não aceito. Use foto (JPG/PNG) ou PDF.');
  });
  if (total > 14 * 1024 * 1024) throw new HttpsError('invalid-argument', 'Arquivo grande demais. Envie fotos menores ou um PDF de até 10 MB.');
  // limite diário por pessoa
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10), usoRef = db.doc(`iaUso/${uid}`);
  const uso = await db.runTransaction(async (t) => {
    const s = await t.get(usoRef), d = s.exists ? s.data() : {};
    const n = d.dia === hoje ? (d.n || 0) : 0;
    if (n >= IA_LIMITE_DIA) return -1;
    t.set(usoRef, {dia: hoje, n: n + 1, total: (d.total || 0) + 1, ultimo: Date.now()}, {merge: true});
    return n + 1;
  });
  if (uso < 0) throw new HttpsError('resource-exhausted', `Você já enviou ${IA_LIMITE_DIA} planos hoje. Tente de novo amanhã ou fale com o suporte.`);
  conteudo.push({type: 'text', text: 'Transcreva este plano alimentar chamando a ferramenta salvar_plano.'});
  let resp;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {'x-api-key': String(ANTHROPIC_API_KEY.value() || '').trim(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json'},
      body: JSON.stringify({model: IA_MODELO, max_tokens: 8000, system: IA_INSTRUCOES,
        tools: [{name: 'salvar_plano', description: 'Salva o plano alimentar transcrito.', input_schema: IA_SCHEMA}],
        tool_choice: {type: 'tool', name: 'salvar_plano'},
        messages: [{role: 'user', content: conteudo}]})
    });
    resp = await r.json().catch(() => ({}));
    if (!r.ok) { console.error('IA erro', r.status, JSON.stringify(resp).slice(0, 500)); const t = (resp.error && resp.error.type) || ''; throw new Error('api ' + r.status + (t ? ' ' + t : '')); }
  } catch (e) {
    const cod = String((e && e.message) || 'rede').replace(/[^\w .-]/g, '').slice(0, 60);
    console.error('IA falhou', cod);
    await usoRef.set({n: admin.firestore.FieldValue.increment(-1)}, {merge: true}).catch(() => {});
    throw new HttpsError('unavailable', 'Não consegui ler o plano agora. Tente de novo em alguns minutos. (código: ' + cod + ')');
  }
  const uso_ = resp.usage || {};
  await usoRef.set({tokensEntrada: admin.firestore.FieldValue.increment(uso_.input_tokens || 0), tokensSaida: admin.firestore.FieldValue.increment(uso_.output_tokens || 0)}, {merge: true}).catch(() => {});
  const bloco = (resp.content || []).find((c) => c.type === 'tool_use' && c.name === 'salvar_plano');
  const r = bloco && bloco.input;
  if (!r) throw new HttpsError('internal', 'Não consegui entender o documento. Tente uma foto mais nítida.');
  if (r.e_plano === false) return {ok: false, motivo: 'nao-plano', duvidas: r.duvidas || [], restantes: IA_LIMITE_DIA - uso};
  const plano = iaParaPlano(r);
  if (!plano.meals.length) return {ok: false, motivo: 'vazio', duvidas: r.duvidas || [], restantes: IA_LIMITE_DIA - uso};
  return {ok: true, plano, duvidas: (r.duvidas || []).slice(0, 12).map((d) => String(d).slice(0, 200)), restantes: IA_LIMITE_DIA - uso};
});
