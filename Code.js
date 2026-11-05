// frentista-bot: Telegram + Gemini + Planilha Google.
// Segredos ficam em Script Properties (Configurações do projeto → Propriedades do script):
//   TELEGRAM_TOKEN, GEMINI_API_KEY, WEBHOOK_SECRET, CHAT_ID, WEBAPP_URL

const ABA = 'Lançamentos';
const ABA_RESUMO = 'Resumo';
const ANOS = [2026, 2027, 2028, 2029, 2030];
const GEMINI_MODELO = 'gemini-2.5-flash';

const AJUDA = [
  'Fala, chefe! Sou o frentista. Me manda:',
  '📷 Print do Shell Box com o km na legenda (ex.: 48250)',
  '⛽ Ou digitado: valor litros km tipo, ex.: 72,40 11,20 48250 a (c = comum, a = aditivada)',
  '🔧 /manut 380 troca de óleo',
  '🏛️ /imposto 1200 IPVA',
  '🛡️ /seguro 3000',
  '   (data opcional no fim: 26/12 ou 26/12/2025)',
  '📊 /resumo · ↩️ /desfazer',
].join('\n');

const PROMPT_GEMINI = [
  'Este é um comprovante de abastecimento do app Shell Box. Responda só JSON:',
  '{"data":"yyyy-mm-dd","litros":number,"precoLitro":number,"valorPago":number,"cashback":number,"tipo":string,"posto":string}',
  'valorPago = valor do combustível depois dos descontos (posto, Shell Box), SEM abater "Créditos Shell" — créditos são dinheiro já pago. Se houver só "Valor total" sem descontos, use-o.',
  'cashback = valor de cashback anunciado, ou 0.',
  'tipo = nome do combustível como aparece (ex.: "Shell V-Power Gasolina", "Gasolina Comum").',
].join('\n');

function props() {
  return PropertiesService.getScriptProperties();
}

// ───────────────────────── Webhook ─────────────────────────

function doPost(e) {
  const ok = ContentService.createTextOutput('ok');
  try {
    const p = props();
    if (!e || !e.parameter || e.parameter.s !== p.getProperty('WEBHOOK_SECRET')) return ok;
    const update = JSON.parse(e.postData.contents);

    const lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) return ok;
    try {
      // Telegram reenvia quando o Apps Script responde com redirect: ignora update repetido.
      const ultimo = Number(p.getProperty('ULTIMO_UPDATE') || 0);
      if (update.update_id <= ultimo) return ok;
      p.setProperty('ULTIMO_UPDATE', String(update.update_id));
    } finally {
      lock.releaseLock();
    }

    const msg = update.message;
    if (!msg) return ok;
    const chatId = String(msg.chat.id);
    const dono = p.getProperty('CHAT_ID');
    if (!dono) {
      // Só antes de configurar: ajuda a descobrir o chat_id.
      enviar(chatId, `Seu chat_id é ${chatId}. Coloque em CHAT_ID nas Script Properties.`);
      return ok;
    }
    if (chatId !== dono) return ok;

    try {
      enviar(chatId, processarMensagem(msg, new Date()));
    } catch (err) {
      enviar(chatId, 'Deu ruim aqui, chefe: ' + err.message);
    }
  } catch (err) {
    console.error(err);
  }
  return ok;
}

/** Decide o que fazer com a mensagem e devolve o texto da resposta. */
function processarMensagem(msg, agora) {
  const imagem = idDaImagem(msg);
  if (imagem) return processarPrint(imagem, msg.caption, agora);

  const m = parseMensagem(msg.text, agora);
  switch (m.tipo) {
    case 'abastecimento':
      return registrarAbastecimento({
        data: inicioDoDia(agora), valorPago: m.valor, cashback: 0,
        litros: m.litros, km: m.km, combustivel: m.combustivel, posto: '',
      });
    case 'km': {
      const pendente = props().getProperty('PENDENTE');
      if (!pendente) return AJUDA;
      const a = JSON.parse(pendente);
      a.data = new Date(a.data);
      a.km = m.km;
      const resposta = registrarAbastecimento(a);
      props().deleteProperty('PENDENTE');
      return resposta;
    }
    case 'despesa':
      return gravarERetornar(montarDespesa(m), null, null);
    case 'comando':
      if (m.nome === 'resumo') return resumoTexto(agora);
      if (m.nome === 'desfazer') {
        const linha = desfazer();
        return linha ? '↩️ Apaguei: ' + formatarConfirmacao(linha, null, null).replace(/^\S+ Anotado, chefe! /, '') : 'Não tem nada pra apagar, chefe.';
      }
      return AJUDA;
    default:
      return AJUDA;
  }
}

function idDaImagem(msg) {
  if (msg.photo && msg.photo.length) return msg.photo[msg.photo.length - 1].file_id; // maior resolução
  if (msg.document && /^image\//.test(msg.document.mime_type || '')) return msg.document.file_id;
  return null;
}

function processarPrint(fileId, legenda, agora) {
  const a = normalizarGemini(lerPrint(fileId), agora);
  if (!a) {
    return 'Não consegui ler esse print, chefe. Manda digitado: valor litros km tipo (ex.: 72,40 11,20 48250 a)';
  }
  a.km = parseKm(legenda);
  if (!a.km) {
    props().setProperty('PENDENTE', JSON.stringify(a));
    return `Li aqui: ${a.litros.toFixed(2).replace('.', ',')} L por R$ ${(a.valorPago - a.cashback).toFixed(2).replace('.', ',')}. Qual o km, chefe?`;
  }
  props().deleteProperty('PENDENTE');
  return registrarAbastecimento(a);
}

function registrarAbastecimento(a) {
  const r = montarAbastecimento(a, kmAnterior());
  if (r.erro) return r.erro;
  return gravarERetornar(r.linha, r.kmRodado, r.aviso);
}

function gravarERetornar(linha, kmRodado, aviso) {
  gravarLinha(linha);
  return formatarConfirmacao(linha, kmRodado, aviso);
}

// ───────────────────────── Telegram e Gemini ─────────────────────────

function telegram(metodo, payload) {
  const token = props().getProperty('TELEGRAM_TOKEN');
  const res = UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/${metodo}`, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true,
  });
  return JSON.parse(res.getContentText());
}

function enviar(chatId, texto) {
  telegram('sendMessage', { chat_id: chatId, text: texto });
}

/** Baixa a imagem do Telegram e pede ao Gemini os dados do comprovante. null se falhar. */
function lerPrint(fileId) {
  const token = props().getProperty('TELEGRAM_TOKEN');
  const arquivo = telegram('getFile', { file_id: fileId });
  if (!arquivo.ok) return null;
  const blob = UrlFetchApp.fetch(`https://api.telegram.org/file/bot${token}/${arquivo.result.file_path}`).getBlob();

  const res = UrlFetchApp.fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODELO}:generateContent`, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': props().getProperty('GEMINI_API_KEY') },
      muteHttpExceptions: true,
      payload: JSON.stringify({
        contents: [{ parts: [
          { text: PROMPT_GEMINI },
          { inline_data: { mime_type: blob.getContentType() || 'image/jpeg', data: Utilities.base64Encode(blob.getBytes()) } },
        ] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
    });
  if (res.getResponseCode() !== 200) {
    console.error('Gemini', res.getResponseCode(), res.getContentText());
    return null;
  }
  try {
    return JSON.parse(JSON.parse(res.getContentText()).candidates[0].content.parts[0].text);
  } catch (err) {
    console.error('Gemini JSON', err);
    return null;
  }
}

/** Rodar uma vez no editor, depois do deploy. Usa WEBAPP_URL (a URL /exec do deploy). */
function configurarWebhook() {
  const p = props();
  const url = p.getProperty('WEBAPP_URL') + '?s=' + encodeURIComponent(p.getProperty('WEBHOOK_SECRET'));
  console.log(JSON.stringify(telegram('setWebhook', { url, drop_pending_updates: true, allowed_updates: ['message'] })));
}

// ───────────────────────── Planilha ─────────────────────────

function aba() {
  return SpreadsheetApp.getActive().getSheetByName(ABA);
}

/** Rodar uma vez no editor: cria as abas, cabeçalho, formatos e fórmulas do Resumo. */
function configurarPlanilha() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(ABA);
  if (!sh) {
    sh = ss.getSheets().length === 1 && ss.getSheets()[0].getLastRow() === 0
      ? ss.getSheets()[0].setName(ABA)
      : ss.insertSheet(ABA);
  }
  sh.getRange(1, 1, 1, COLUNAS.length).setValues([COLUNAS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange('A2:A').setNumberFormat('dd/MM/yyyy');
  ['C2:C', 'G2:G', 'I2:I'].forEach(r => sh.getRange(r).setNumberFormat('R$ #,##0.00'));
  sh.getRange('D2:D').setNumberFormat('0.00');
  sh.getRange('H2:H').setNumberFormat('0.00');

  const rs = ss.getSheetByName(ABA_RESUMO) || ss.insertSheet(ABA_RESUMO);
  rs.clear();
  const L = `'${ABA}'!`;
  const noAno = c => `${L}A:A,">="&DATE(${c}$1,1,1),${L}A:A,"<"&DATE(${c}$1+1,1,1)`;
  const anoArr = c => `(YEAR(${L}A2:A)=${c}$1)*(${L}H2:H<>"")`;
  const linhas = [
    ['Gasto total', c => `SUMIFS(${L}C:C,${noAno(c)})`],
    ['Combustível', c => `SUMIFS(${L}C:C,${noAno(c)},${L}B:B,"Combustível")`],
    ['Manutenção', c => `SUMIFS(${L}C:C,${noAno(c)},${L}B:B,"Manutenção")`],
    ['Imposto', c => `SUMIFS(${L}C:C,${noAno(c)},${L}B:B,"Imposto")`],
    ['Seguro', c => `SUMIFS(${L}C:C,${noAno(c)},${L}B:B,"Seguro")`],
    ['Km rodado', c => `IFERROR(MAXIFS(${L}E:E,${noAno(c)},${L}B:B,"Combustível")-MINIFS(${L}E:E,${noAno(c)},${L}B:B,"Combustível"),"")`],
    ['Litros', c => `SUMIFS(${L}D:D,${noAno(c)})`],
    // Km/L × Litros = km do intervalo; só linhas com Km/L (exclui o 1º abastecimento)
    ['Km/L médio', c => `IFERROR(SUMPRODUCT(${anoArr(c)}*${L}H2:H*${L}D2:D)/SUMPRODUCT(${anoArr(c)}*${L}D2:D),"")`],
    ['R$/L médio', c => `IFERROR(SUMIFS(${L}C:C,${noAno(c)},${L}B:B,"Combustível")/SUMIFS(${L}D:D,${noAno(c)}),"")`],
    ['Km/L Comum', c => `IFERROR(SUMPRODUCT(${anoArr(c)}*(${L}F2:F="C")*${L}H2:H*${L}D2:D)/SUMPRODUCT(${anoArr(c)}*(${L}F2:F="C")*${L}D2:D),"")`],
    ['Km/L Aditivada', c => `IFERROR(SUMPRODUCT(${anoArr(c)}*(${L}F2:F="A")*${L}H2:H*${L}D2:D)/SUMPRODUCT(${anoArr(c)}*(${L}F2:F="A")*${L}D2:D),"")`],
    ['R$/L Comum', c => `IFERROR(SUMIFS(${L}C:C,${noAno(c)},${L}F:F,"C")/SUMIFS(${L}D:D,${noAno(c)},${L}F:F,"C"),"")`],
    ['R$/L Aditivada', c => `IFERROR(SUMIFS(${L}C:C,${noAno(c)},${L}F:F,"A")/SUMIFS(${L}D:D,${noAno(c)},${L}F:F,"A"),"")`],
    ['Cashback', c => `SUMIFS(${L}I:I,${noAno(c)})`],
  ];
  const cols = ANOS.map((_, i) => String.fromCharCode(66 + i)); // B..F
  rs.getRange(1, 1, 1, ANOS.length + 1).setValues([[''].concat(ANOS)]).setFontWeight('bold');
  linhas.forEach(([rotulo, f], i) => {
    rs.getRange(i + 2, 1).setValue(rotulo).setFontWeight('bold');
    rs.getRange(i + 2, 2, 1, cols.length).setFormulas([cols.map(c => '=' + f(c))]);
  });
  rs.getRange(2, 2, linhas.length, cols.length).setNumberFormat('R$ #,##0.00');
  [7, 8, 9, 11, 12].forEach(r => rs.getRange(r, 2, 1, cols.length).setNumberFormat('#,##0.00'));
  rs.getRange(7, 2, 1, cols.length).setNumberFormat('#,##0');
  rs.setFrozenRows(1);
  rs.setFrozenColumns(1);
}

/** Maior km entre os abastecimentos; null se não houver nenhum. */
function kmAnterior() {
  const sh = aba();
  if (sh.getLastRow() < 2) return null;
  const v = sh.getRange(2, 2, sh.getLastRow() - 1, 4).getValues(); // B..E
  const kms = v.filter(r => r[0] === 'Combustível' && typeof r[3] === 'number').map(r => r[3]);
  return kms.length ? Math.max.apply(null, kms) : null;
}

function gravarLinha(linha) {
  aba().appendRow(linha);
}

/** Apaga a última linha de dados (nunca o cabeçalho). Devolve a linha apagada ou null. */
function desfazer() {
  const sh = aba();
  const n = sh.getLastRow();
  if (n < 2) return null;
  const linha = sh.getRange(n, 1, 1, COLUNAS.length).getValues()[0];
  sh.deleteRow(n);
  return linha;
}

function resumoTexto(agora) {
  SpreadsheetApp.flush();
  const rs = SpreadsheetApp.getActive().getSheetByName(ABA_RESUMO);
  const col = ANOS.indexOf(agora.getFullYear());
  if (col < 0) return 'Ano fora do Resumo, chefe. Adiciona a coluna na aba Resumo.';
  const v = rs.getRange(2, 1, 14, ANOS.length + 1).getValues();
  const val = rotulo => v.find(r => r[0] === rotulo)[col + 1];
  const rs$ = n => typeof n === 'number' ? 'R$ ' + n.toFixed(2).replace('.', ',') : '—';
  const num = n => typeof n === 'number' ? n.toFixed(2).replace('.', ',') : '—';
  const linhas = [
    `📊 ${agora.getFullYear()}`,
    `Total: ${rs$(val('Gasto total'))}`,
    `⛽ Combustível: ${rs$(val('Combustível'))}`,
    `🔧 Manutenção: ${rs$(val('Manutenção'))}`,
    `🏛️ Impostos: ${rs$(val('Imposto'))}`,
    `🛡️ Seguro: ${rs$(val('Seguro'))}`,
    `🛣️ ${typeof val('Km rodado') === 'number' ? val('Km rodado') : '—'} km · ${num(val('Km/L médio'))} km/L · ${rs$(val('R$/L médio'))}/L`,
    `Comum: ${num(val('Km/L Comum'))} km/L · Aditivada: ${num(val('Km/L Aditivada'))} km/L`,
    `💸 Cashback: ${rs$(val('Cashback'))}`,
  ];
  const sh = aba();
  const dados = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, COLUNAS.length).getValues() : [];
  const ultimo = dados.filter(r => r[1] === 'Combustível').pop();
  if (ultimo) linhas.push('Último: ' + formatarConfirmacao(ultimo, null, null).replace(/^\S+ Anotado, chefe! /, ''));
  return linhas.join('\n');
}
