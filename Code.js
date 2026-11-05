// frentista-bot: Telegram + Gemini + Planilha Google.
// Segredos ficam em Script Properties (Configurações do projeto → Propriedades do script):
//   TELEGRAM_TOKEN, GEMINI_API_KEY, CHAT_ID

const ABA = 'Lançamentos';
const ABA_RESUMO = 'Resumo';
const ABA_GRAFICOS = 'Gráficos';
const GEMINI_MODELO = 'gemini-2.5-flash';

const AJUDA = [
  'Fala, chefe! Sou o frentista. Me manda:',
  '📷 Print do Shell Box com o km na legenda (ex.: 48250), ou sem legenda e depois uma foto do painel',
  '⛽ Ou digitado: valor litros km tipo, ex.: 72,40 11,20 48250 a (c = comum, a = aditivada)',
  '🔧 /manut 380 troca de óleo',
  '🏛️ /imposto 1200 IPVA',
  '🛡️ /seguro 3000',
  '   (data opcional no fim: 26/12 ou 26/12/2025)',
  '📊 /resumo · ↩️ /desfazer',
].join('\n');

const PROMPT_GEMINI = [
  'A imagem é um comprovante de abastecimento do app Shell Box OU uma foto do painel do carro. Responda só JSON:',
  '{"imagem":"comprovante"|"painel"|"outra","data":"yyyy-mm-dd","litros":number,"precoLitro":number,"valorPago":number,"cashback":number,"tipo":string,"posto":string,"km":number}',
  'Se for comprovante: valorPago = valor do combustível depois dos descontos (posto, Shell Box), SEM abater "Créditos Shell" — créditos são dinheiro já pago. Se houver só "Valor total" sem descontos, use-o. cashback = valor de cashback anunciado, ou 0. tipo = nome do combustível como aparece (ex.: "Shell V-Power Gasolina", "Gasolina Comum"). km = null.',
  'Se for painel: km = hodômetro total (ODO), nunca o parcial (TRIP); se não der pra ler com certeza, km = null. Os outros campos = null.',
].join('\n');

function props() {
  return PropertiesService.getScriptProperties();
}

// ───────────────────────── Polling ─────────────────────────
// ponytail: polling de 1 em 1 minuto em vez de webhook. O web app do Apps Script responde todo POST
// com 302; o Telegram trata isso como erro, reenvia o mesmo update com backoff e trava a fila.

/** Gatilho de 1 minuto (criado por configurarGatilho): busca mensagens novas e responde. */
function verificar() {
  // Uma execução por vez: leitura do km anterior, gravação, pendente e /desfazer não se cruzam.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // a execução anterior ainda está rodando; o próximo minuto pega
  try {
    const p = props();
    const r = telegram('getUpdates', { offset: Number(p.getProperty('OFFSET') || 0), allowed_updates: ['message'] });
    if (!r.ok) return console.error('getUpdates', JSON.stringify(r));
    for (const update of r.result) {
      // Confirma antes de processar: um update que quebra não fica repetindo a cada minuto.
      p.setProperty('OFFSET', String(update.update_id + 1));
      if (update.message) atender(update.message);
    }
  } finally {
    lock.releaseLock();
  }
}

function atender(msg) {
  const chatId = String(msg.chat.id);
  const dono = props().getProperty('CHAT_ID');
  if (!dono) {
    // Só antes de configurar: ajuda a descobrir o chat_id.
    return enviar(chatId, `Seu chat_id é ${chatId}. Coloque em CHAT_ID nas Script Properties.`);
  }
  if (chatId !== dono) return;
  try {
    enviar(chatId, processarMensagem(msg, new Date()));
  } catch (err) {
    console.error(err);
    enviar(chatId, 'Deu ruim aqui, chefe: ' + err.message + '\nManda de novo.');
  }
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
      }).texto;
    case 'km':
      return props().getProperty('PENDENTE') ? usarKm(m.km) : AJUDA;
    case 'despesa':
      return gravarERetornar(montarDespesa(m), null, null);
    case 'comando':
      if (m.nome === 'resumo') return resumoTexto(agora);
      if (m.nome === 'desfazer') {
        const linha = desfazer();
        return linha ? '↩️ Apaguei: ' + descreverLinha(linha) : 'Não tem nada pra apagar, chefe.';
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

/** Foto: comprovante do Shell Box (abastecimento novo) ou painel (km do abastecimento pendente). */
function processarPrint(fileId, legenda, agora) {
  const lido = lerPrint(fileId);
  if (lido && lido.imagem === 'painel') {
    const km = kmDoPainel(lido);
    if (!km) return 'Não consegui ler o hodômetro nessa foto, chefe. Manda o km digitado.';
    if (!props().getProperty('PENDENTE')) {
      return `Li ${km} km no painel, mas não tem abastecimento esperando km. Manda o print do Shell Box primeiro.`;
    }
    return usarKm(km);
  }

  // Falha de leitura não mexe no PENDENTE: o km ainda pode completar o abastecimento anterior.
  if (lido && lido.imagem === 'outra') return 'Essa foto não é comprovante do Shell Box nem painel, chefe.';
  const a = normalizarGemini(lido, agora);
  if (!a) {
    return 'Não consegui ler esse print, chefe. Manda digitado: valor litros km tipo (ex.: 72,40 11,20 48250 a)';
  }
  props().deleteProperty('PENDENTE'); // comprovante novo e válido substitui o anterior
  const dup = acharDuplicado(dados(), a);
  if (dup) return 'Esse já tá anotado, chefe: ' + descreverLinha(dup);
  a.km = parseKm(legenda);
  if (a.km) {
    const r = registrarAbastecimento(a);
    if (r.ok) return r.texto;
    props().setProperty('PENDENTE', JSON.stringify(a));
    return r.texto + '\nManda o km certo, chefe.';
  }
  props().setProperty('PENDENTE', JSON.stringify(a));
  return `Li aqui: ${fmtNum(a.litros)} L por R$ ${fmtNum(a.valorPago - a.cashback)}. Qual o km, chefe? (número ou foto do painel)`;
}

/** Completa o abastecimento pendente com o km (digitado ou lido do painel). */
function usarKm(km) {
  const a = JSON.parse(props().getProperty('PENDENTE'));
  a.data = new Date(a.data);
  a.km = km;
  const r = registrarAbastecimento(a);
  if (r.ok) props().deleteProperty('PENDENTE'); // km recusado: o print continua esperando
  return r.ok ? r.texto : r.texto + '\nManda o km certo, chefe.';
}

/** Valida, grava e devolve {ok, texto}. Um duplicado conta como ok: nada a gravar. */
function registrarAbastecimento(a) {
  const linhas = dados();
  const dup = acharDuplicado(linhas, a);
  if (dup) return { ok: true, texto: 'Esse já tá anotado, chefe: ' + descreverLinha(dup) };
  const r = montarAbastecimento(a, kmAnteriorDe(linhas));
  if (r.erro) return { ok: false, texto: r.erro };
  const aviso = [r.aviso, avisoPreco(linhas, a.combustivel, r.linha[6])].filter(Boolean).join('\n') || null;
  return { ok: true, texto: gravarERetornar(r.linha, r.kmRodado, aviso) };
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
  const r = telegram('sendMessage', { chat_id: chatId, text: texto });
  if (!r.ok) console.error('sendMessage', JSON.stringify(r)); // ponytail: sem retry; o lançamento já está na planilha
}

/** Baixa a imagem do Telegram e pede ao Gemini os dados do comprovante. null se falhar. */
function lerPrint(fileId) {
  const token = props().getProperty('TELEGRAM_TOKEN');
  const arquivo = telegram('getFile', { file_id: fileId });
  if (!arquivo.ok) return null;
  const caminho = arquivo.result.file_path;
  const blob = UrlFetchApp.fetch(`https://api.telegram.org/file/bot${token}/${caminho}`).getBlob();
  // O Telegram serve como application/octet-stream, que o Gemini recusa; o tipo vem da extensão.
  const ext = (/\.(\w+)$/.exec(caminho) || [])[1] || '';
  const mime = { png: 'image/png', webp: 'image/webp', heic: 'image/heic' }[ext.toLowerCase()] || 'image/jpeg';

  const pedido = () => UrlFetchApp.fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODELO}:generateContent`, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': props().getProperty('GEMINI_API_KEY') },
      muteHttpExceptions: true,
      payload: JSON.stringify({
        contents: [{ parts: [
          { text: PROMPT_GEMINI },
          { inline_data: { mime_type: mime, data: Utilities.base64Encode(blob.getBytes()) } },
        ] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
    });
  // Erro passageiro (cota, sobrecarga): espera e tenta de novo, até 3 vezes no total.
  let res = pedido();
  for (const espera of [3000, 8000]) {
    if (![429, 500, 503].includes(res.getResponseCode())) break;
    console.warn('Gemini', res.getResponseCode(), 'tentando de novo');
    Utilities.sleep(espera);
    res = pedido();
  }
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

/** Rodar uma vez no editor: desliga um webhook antigo, se houver, e (re)cria os gatilhos. */
function configurarGatilho() {
  console.log(JSON.stringify(telegram('deleteWebhook', {})));
  ScriptApp.getProjectTriggers()
    .filter(t => ['verificar', 'resumoMensal'].includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('verificar').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('resumoMensal').timeBased().onMonthDay(1).atHour(9).create();
}

/** Gatilho mensal (dia 1, ~9h): manda o resumo do mês anterior. */
function resumoMensal() {
  const p = mesAnterior(new Date());
  const antes = mesAnterior(p.inicio);
  const linhas = dados();
  const atual = resumoPeriodo(linhas, p.inicio, p.fim);
  const comp = comparacao(atual, resumoPeriodo(linhas, antes.inicio, antes.fim), MESES[antes.inicio.getMonth()]);
  enviar(props().getProperty('CHAT_ID'), formatarResumo(p.titulo, atual) + (comp ? '\n' + comp : ''));
}

// ───────────────────────── Planilha ─────────────────────────

/** Planilha pelo ID salvo em configurarPlanilha: no gatilho não há planilha "ativa". */
function planilha() {
  return SpreadsheetApp.openById(props().getProperty('SHEET_ID'));
}

function aba() {
  return planilha().getSheetByName(ABA);
}

/** 2026 até o ano que vem (mínimo 2030). Rodar configurarPlanilha() de novo estende o Resumo. */
function anosDoResumo() {
  const ate = Math.max(2030, new Date().getFullYear() + 1);
  return Array.from({ length: ate - 2026 + 1 }, (_, i) => 2026 + i);
}

/** Rodar uma vez no editor: cria as abas, cabeçalho, formatos e fórmulas do Resumo. */
function configurarPlanilha() {
  const ss = SpreadsheetApp.getActive();
  props().setProperty('SHEET_ID', ss.getId());
  ss.setSpreadsheetTimeZone('America/Sao_Paulo');
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
  // Linhas do ano com Km/L e litros: a base de km rodado, km/L e R$/km
  const anoArr = c => `(YEAR(${L}A2:A)=${c}$1)*(${L}H2:H<>"")*(${L}D2:D>0)`;
  const linhas = [
    ['Gasto total', c => `SUMIFS(${L}C:C,${noAno(c)})`],
    ['Combustível', c => `SUMIFS(${L}C:C,${noAno(c)},${L}B:B,"Combustível")`],
    ['Manutenção', c => `SUMIFS(${L}C:C,${noAno(c)},${L}B:B,"Manutenção")`],
    ['Imposto', c => `SUMIFS(${L}C:C,${noAno(c)},${L}B:B,"Imposto")`],
    ['Seguro', c => `SUMIFS(${L}C:C,${noAno(c)},${L}B:B,"Seguro")`],
    // Km/L × Litros = km do intervalo; mesma população do Km/L médio (só linhas com Km/L)
    ['Km rodado', c => `ROUND(SUMPRODUCT(${anoArr(c)}*${L}H2:H*${L}D2:D),0)`],
    ['Litros', c => `SUMIFS(${L}D:D,${noAno(c)})`],
    ['Km/L médio', c => `IFERROR(SUMPRODUCT(${anoArr(c)}*${L}H2:H*${L}D2:D)/SUMPRODUCT(${anoArr(c)}*${L}D2:D),"")`],
    // R$/L só com linhas que têm litros (registros antigos podem ter só o valor)
    ['R$/L médio', c => `IFERROR(SUMIFS(${L}C:C,${noAno(c)},${L}D:D,">0")/SUMIFS(${L}D:D,${noAno(c)}),"")`],
    ['Km/L Comum', c => `IFERROR(SUMPRODUCT(${anoArr(c)}*(${L}F2:F="C")*${L}H2:H*${L}D2:D)/SUMPRODUCT(${anoArr(c)}*(${L}F2:F="C")*${L}D2:D),"")`],
    ['Km/L Aditivada', c => `IFERROR(SUMPRODUCT(${anoArr(c)}*(${L}F2:F="A")*${L}H2:H*${L}D2:D)/SUMPRODUCT(${anoArr(c)}*(${L}F2:F="A")*${L}D2:D),"")`],
    ['R$/L Comum', c => `IFERROR(SUMIFS(${L}C:C,${noAno(c)},${L}F:F,"C",${L}D:D,">0")/SUMIFS(${L}D:D,${noAno(c)},${L}F:F,"C"),"")`],
    ['R$/L Aditivada', c => `IFERROR(SUMIFS(${L}C:C,${noAno(c)},${L}F:F,"A",${L}D:D,">0")/SUMIFS(${L}D:D,${noAno(c)},${L}F:F,"A"),"")`],
    ['Cashback', c => `SUMIFS(${L}I:I,${noAno(c)})`],
    // R$/km: combustível só dos intervalos com Km/L (mesma base do Km rodado); total = gasto total ÷ km
    ['R$/km combustível', c => `IFERROR(SUMPRODUCT(${anoArr(c)}*${L}C2:C)/SUMPRODUCT(${anoArr(c)}*${L}H2:H*${L}D2:D),"")`],
    ['R$/km total', c => `IFERROR(${c}2/${c}7,"")`],
  ];
  // As fórmulas usam vírgula; em locale pt_BR o Sheets esperaria ";" e dá erro de análise.
  // Grava em en_US e volta: o Sheets converte as fórmulas para o locale original.
  const locale = ss.getSpreadsheetLocale();
  ss.setSpreadsheetLocale('en_US');
  const anos = anosDoResumo();
  const cols = anos.map((_, i) => String.fromCharCode(66 + i)); // B, C, ... (até 25 anos)
  rs.getRange(1, 1, 1, anos.length + 1).setValues([[''].concat(anos)]).setFontWeight('bold');
  linhas.forEach(([rotulo, f], i) => {
    rs.getRange(i + 2, 1).setValue(rotulo).setFontWeight('bold');
    rs.getRange(i + 2, 2, 1, cols.length).setFormulas([cols.map(c => '=' + f(c))]);
  });
  rs.getRange(2, 2, linhas.length, cols.length).setNumberFormat('R$ #,##0.00');
  [7, 8, 9, 11, 12].forEach(r => rs.getRange(r, 2, 1, cols.length).setNumberFormat('#,##0.00'));
  rs.getRange(7, 2, 1, cols.length).setNumberFormat('#,##0');
  rs.setFrozenRows(1);
  rs.setFrozenColumns(1);
  configurarGraficos(ss, L);
  SpreadsheetApp.flush();
  ss.setSpreadsheetLocale(locale);
}

/**
 * Aba Gráficos: tabelas auxiliares por fórmula (A:C R$/L, E:G Km/L, I:J gasto por mês) e três gráficos.
 * Recriada do zero a cada configurarPlanilha. As tabelas ficam visíveis: gráfico ignora coluna oculta.
 */
function configurarGraficos(ss, L) {
  const g = ss.getSheetByName(ABA_GRAFICOS) || ss.insertSheet(ABA_GRAFICOS);
  g.getCharts().forEach(c => g.removeChart(c));
  g.clear();
  // Comum e Aditivada em colunas separadas; NA() vira buraco no gráfico (interpolateNulls liga os pontos).
  const serie = col => `=ARRAYFORMULA(FILTER({${L}A2:A,IF(${L}F2:F="C",${L}${col}2:${col},NA()),` +
    `IF(${L}F2:F="A",${L}${col}2:${col},NA())},${L}B2:B="Combustível",${L}${col}2:${col}<>""))`;
  g.getRange('A1:C1').setValues([['Data', 'R$/L Comum', 'R$/L Aditivada']]);
  g.getRange('A2').setFormula(serie('G'));
  g.getRange('E1:G1').setValues([['Data', 'Km/L Comum', 'Km/L Aditivada']]);
  g.getRange('E2').setFormula(serie('H'));
  const temData = `${L}A2:A<>""`;
  g.getRange('I1').setFormula(`=QUERY({ARRAYFORMULA(EOMONTH(FILTER(${L}A2:A,${temData}),-1)+1),FILTER(${L}C2:C,${temData})},` +
    `"select Col1, sum(Col2) group by Col1 label Col1 'Mês', sum(Col2) 'Gasto'",0)`);
  ['A2:A', 'E2:E'].forEach(r => g.getRange(r).setNumberFormat('dd/MM/yyyy'));
  g.getRange('I2:I').setNumberFormat('MM/yyyy');
  ['B2:C', 'J2:J'].forEach(r => g.getRange(r).setNumberFormat('R$ #,##0.00'));
  g.getRange('F2:G').setNumberFormat('0.00');
  g.getRange('A1:J1').setFontWeight('bold');
  g.setFrozenRows(1);

  const linha = (faixa, titulo, linhaPos) => g.newChart().asLineChart()
    .addRange(g.getRange(faixa)).setNumHeaders(1)
    .setOption('title', titulo).setOption('interpolateNulls', true).setOption('pointSize', 4)
    .setPosition(linhaPos, 12, 0, 0).build();
  g.insertChart(linha('A1:C', 'R$/L: Comum x Aditivada', 1));
  g.insertChart(linha('E1:G', 'Km/L: Comum x Aditivada', 21));
  g.insertChart(g.newChart().asColumnChart().addRange(g.getRange('I1:J')).setNumHeaders(1)
    .setOption('title', 'Gasto por mês').setOption('legend', { position: 'none' })
    .setPosition(41, 12, 0, 0).build());
}

const COLUNAS_NUMERICAS = [2, 3, 4, 6, 7, 8]; // Valor, Litros, Km, R$/L, Km/L, Cashback

/** Linhas de dados da aba Lançamentos, sem o cabeçalho. Número digitado como texto vira número. */
function dados() {
  const sh = aba();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, COLUNAS.length).getValues().map(l => l.map((v, i) =>
    typeof v === 'string' && v.trim() && COLUNAS_NUMERICAS.includes(i) ? (parseNumero(v) ?? v) : v));
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

/** /resumo: o ano corrente, calculado das linhas (mesmas contas da aba Resumo). */
function resumoTexto(agora) {
  const ano = agora.getFullYear();
  const linhas = dados();
  const texto = formatarResumo(String(ano), resumoPeriodo(linhas, new Date(ano, 0, 1), new Date(ano + 1, 0, 1)));
  const ultimo = combustiveis(linhas).pop();
  return ultimo ? texto + '\nÚltimo: ' + descreverLinha(ultimo) : texto;
}
