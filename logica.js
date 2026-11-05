// Lógica pura do frentista-bot: sem APIs do Apps Script, roda no Node (test.js) e no Apps Script.

const COLUNAS = ['Data', 'Categoria', 'Valor', 'Litros', 'Km', 'Tipo', 'R$/L', 'Km/L', 'Cashback', 'Descrição'];

const CATEGORIAS_COMANDO = { '/manut': 'Manutenção', '/imposto': 'Imposto', '/seguro': 'Seguro' };

/** "72,40" | "R$ 72,40" | "11.2" | 12.5 → número; null se inválido. */
function parseNumero(s) {
  if (typeof s === 'number') return isFinite(s) ? s : null;
  if (typeof s !== 'string') return null;
  let t = s.replace(/R\$|\s/g, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.'); // 1.234,56 → 1234.56
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

/** "48250" | "48.250" | "48250 km" → 48250; null para qualquer outra coisa (fração, sinal, texto). */
function parseKm(s) {
  const m = /^\s*(\d{1,3}(?:\.\d{3})+|\d+)\s*(?:km)?\s*$/i.exec(String(s == null ? '' : s));
  return m ? Number(m[1].replace(/\./g, '')) : null;
}

/** Texto que o Sheets interpretaria como fórmula vira texto literal. */
function textoSeguro(s) {
  const t = String(s == null ? '' : s);
  return /^[=+\-@]/.test(t) ? "'" + t : t;
}

/** "dd/mm" (ano de hoje) ou "dd/mm/yyyy" → Date; null se inválida. */
function parseData(s, hoje) {
  const m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(String(s || '').trim());
  if (!m) return null;
  const ano = m[3] ? Number(m[3]) : hoje.getFullYear();
  const d = new Date(ano, Number(m[2]) - 1, Number(m[1]));
  return d.getDate() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 ? d : null;
}

function inicioDoDia(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Interpreta uma mensagem de texto do usuário. */
function parseMensagem(texto, hoje) {
  const t = String(texto || '').trim();
  const invalido = { tipo: 'invalido' };

  if (t.startsWith('/')) {
    const partes = t.split(/\s+/);
    const cmd = partes[0].toLowerCase().replace(/@.*/, ''); // /resumo@MeuBot → /resumo
    if (['/resumo', '/mes', '/desfazer', '/start'].includes(cmd)) {
      return { tipo: 'comando', nome: cmd.slice(1), arg: partes.slice(1).join(' ') };
    }
    const categoria = CATEGORIAS_COMANDO[cmd];
    if (!categoria) return invalido;
    const valor = parseNumero(partes[1] || '');
    if (valor === null || valor <= 0) return invalido;
    let resto = partes.slice(2);
    let data = inicioDoDia(hoje);
    const ultimo = resto[resto.length - 1] || '';
    if (/^\d{1,2}\/\d{1,2}(\/\d{4})?$/.test(ultimo)) { // parece data: tem que ser válida
      data = parseData(ultimo, hoje);
      if (!data) return invalido;
      resto = resto.slice(0, -1);
    }
    return { tipo: 'despesa', categoria, valor, descricao: textoSeguro(resto.join(' ')), data };
  }

  const ab = /^(\S+)\s+(\S+)\s+(\S+(?:\s+km)?)\s+([ac])$/i.exec(t);
  if (ab) {
    const valor = parseNumero(ab[1]), litros = parseNumero(ab[2]), km = parseKm(ab[3]);
    if (valor > 0 && litros > 0 && km) {
      return { tipo: 'abastecimento', valor, litros, km, combustivel: ab[4].toUpperCase() };
    }
    return invalido;
  }

  const km = parseKm(t);
  return km ? { tipo: 'km', km } : invalido;
}

const KML_MIN = 5;
const KML_MAX = 25;

function arred2(n) {
  return Math.round(n * 100) / 100;
}

/** "yyyy-mm-dd" do Gemini → Date; hoje se faltar ou for inválida. */
function dataDoGemini(s, hoje) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return (iso && parseData(`${iso[3]}/${iso[2]}/${iso[1]}`, hoje)) || inicioDoDia(hoje);
}

/** Nota de oficina ou boleto lido pelo Gemini → {categoria, valor, data, descricao}; null se não dá. */
function despesaDoGemini(obj, hoje, legenda) {
  if (!obj || obj.imagem !== 'despesa') return null;
  const categoria = Object.values(CATEGORIAS_COMANDO).find(c => c === obj.categoria);
  const valor = parseNumero(obj.valor);
  if (!categoria || !(valor > 0)) return null;
  const descricao = String(legenda || '').trim() || String(obj.descricao || '').trim();
  return { categoria, valor: arred2(valor), data: dataDoGemini(obj.data, hoje), descricao: textoSeguro(descricao) };
}

/** Limpa o JSON devolvido pelo Gemini; null se não dá pra confiar nele. */
function normalizarGemini(obj, hoje) {
  if (!obj || typeof obj !== 'object') return null;
  const litros = parseNumero(obj.litros);
  const valorPago = parseNumero(obj.valorPago);
  if (!(litros > 0) || !(valorPago > 0)) return null; // ex.: "Total R$ 0,00" quando pago com créditos
  const cashback = obj.cashback == null ? 0 : parseNumero(obj.cashback);
  if (cashback === null || cashback < 0 || cashback >= valorPago) return null;
  const data = dataDoGemini(obj.data, hoje);
  const tipo = String(obj.tipo || '').toLowerCase();
  return {
    data,
    litros,
    valorPago,
    cashback,
    combustivel: /v-?power|aditivad/.test(tipo) ? 'A' : 'C', // ponytail: só gasolina; etanol vira C
    posto: textoSeguro(obj.posto),
  };
}

/** Monta a linha de abastecimento (ordem de COLUNAS) ou devolve {erro}. */
function montarAbastecimento(a, kmAnterior) {
  if (kmAnterior !== null && a.km <= kmAnterior) {
    return { erro: `Opa, chefe: o km ${a.km} é menor ou igual ao último (${kmAnterior}). O hodômetro andou pra trás?` };
  }
  const valor = arred2(a.valorPago - (a.cashback || 0));
  const kmRodado = kmAnterior === null ? null : a.km - kmAnterior;
  const kmPorLitro = kmRodado === null ? null : arred2(kmRodado / a.litros);
  const aviso = kmPorLitro !== null && (kmPorLitro < KML_MIN || kmPorLitro > KML_MAX)
    ? `⚠️ ${fmtNum(kmPorLitro)} km/L tá estranho. Confere o km e os litros (/desfazer se precisar).`
    : null;
  const linha = [a.data, 'Combustível', valor, a.litros, a.km, a.combustivel,
    arred2(valor / a.litros), kmPorLitro === null ? '' : kmPorLitro, a.cashback || '', a.posto || ''];
  return { linha, kmRodado, kmPorLitro, aviso };
}

/** Linha de despesa sem combustível (ordem de COLUNAS). */
function montarDespesa(d) {
  return [d.data, d.categoria, d.valor, '', '', '', '', '', '', d.descricao || ''];
}

const milhar = s => s.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** 8678.2 → "8.678,20"; não-número → "—" (linhas migradas podem não ter litros). */
function fmtNum(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  const [inteiro, dec] = n.toFixed(2).split('.');
  return milhar(inteiro) + ',' + dec;
}

function fmtData(d) {
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
}

/** Mensagem de confirmação no tom de frentista. */
function formatarConfirmacao(linha, kmRodado, aviso) {
  const [data, categoria, valor, litros, , tipo, precoLitro, kmL, , descricao] = linha;
  let partes;
  if (categoria === 'Combustível') {
    partes = ['⛽ Anotado, chefe! ' + fmtData(data), tipo === 'A' ? 'Aditivada' : 'Comum',
      fmtNum(litros) + ' L', `R$ ${fmtNum(valor)} (R$ ${fmtNum(precoLitro)}/L)`];
    if (kmRodado !== null) partes.push(`${kmRodado} km → ${fmtNum(kmL)} km/L`);
  } else {
    partes = ['🧾 Anotado, chefe! ' + fmtData(data), categoria, 'R$ ' + fmtNum(valor)];
    if (descricao) partes.push(descricao);
  }
  return partes.join(' · ') + (aviso ? '\n' + aviso : '');
}

/** Linha sem o prefixo "Anotado, chefe!" (pra /desfazer, duplicado e último abastecimento). */
function descreverLinha(linha) {
  return formatarConfirmacao(linha, null, null).replace(/^\S+ Anotado, chefe! /, '');
}

// ───────── Funções sobre as linhas da aba Lançamentos (ordem de COLUNAS) ─────────

const combustiveis = linhas => linhas.filter(l => l[1] === 'Combustível');
const ehNumero = v => typeof v === 'number' && isFinite(v);
const mesmoDia = (a, b) => a instanceof Date && b instanceof Date &&
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Km do último abastecimento; null se não houver ou se ele não tiver km. */
function kmAnteriorDe(linhas) {
  const ultimo = combustiveis(linhas).pop();
  return ultimo && ehNumero(ultimo[4]) ? ultimo[4] : null;
}

/** Abastecimento já lançado com mesma data, litros e valor líquido; senão null. */
function acharDuplicado(linhas, a) {
  const valor = arred2(a.valorPago - (a.cashback || 0));
  return combustiveis(linhas).find(l => mesmoDia(l[0], a.data) &&
    ehNumero(l[3]) && Math.abs(l[3] - a.litros) < 0.005 &&
    ehNumero(l[2]) && Math.abs(l[2] - valor) < 0.005) || null;
}

/** Despesa já lançada com mesmo dia, categoria e valor (nota mandada duas vezes); senão null. */
function acharDespesa(linhas, d) {
  return linhas.find(l => mesmoDia(l[0], d.data) && l[1] === d.categoria &&
    ehNumero(l[2]) && Math.abs(l[2] - d.valor) < 0.005) || null;
}

const PRECO_DESVIO = 0.15;

/** Avisa se o R$/L foge mais de 15% da média dos últimos 10 do mesmo tipo (mínimo 3). */
function avisoPreco(linhas, combustivel, precoLitro) {
  const precos = combustiveis(linhas).filter(l => l[5] === combustivel && ehNumero(l[6])).map(l => l[6]).slice(-10);
  if (precos.length < 3 || !ehNumero(precoLitro)) return null;
  const media = precos.reduce((s, p) => s + p, 0) / precos.length;
  return Math.abs(precoLitro - media) / media > PRECO_DESVIO
    ? `⚠️ R$ ${fmtNum(precoLitro)}/L tá bem fora da sua média (R$ ${fmtNum(media)}/L). Confere o print.`
    : null;
}

/**
 * Números de um período [inicio, fim). Km rodado = Σ Km/L × Litros (só linhas com Km/L),
 * igual às fórmulas da aba Resumo. Divisões sem base viram null.
 */
function resumoPeriodo(linhas, inicio, fim) {
  const no = linhas.filter(l => l[0] instanceof Date && l[0] >= inicio && l[0] < fim);
  const soma = (ls, f) => ls.reduce((s, l) => s + f(l), 0);
  const div = (a, b) => (b > 0 ? a / b : null);
  const valor = l => (ehNumero(l[2]) ? l[2] : 0);
  const litros = l => (ehNumero(l[3]) ? l[3] : 0);
  const comb = combustiveis(no);
  const comKmL = comb.filter(l => ehNumero(l[7]) && litros(l) > 0); // mesma base no numerador e no denominador
  const kmDe = ls => soma(ls, l => l[7] * litros(l));
  const kmLDe = ls => div(kmDe(ls), soma(ls, litros));
  const porCategoria = {};
  no.forEach(l => { porCategoria[l[1]] = (porCategoria[l[1]] || 0) + valor(l); });
  const total = soma(no, valor);
  const km = Math.round(kmDe(comKmL));
  const comLitros = comb.filter(l => litros(l) > 0);
  return {
    total,
    porCategoria,
    litros: soma(comb, litros),
    km,
    kmL: kmLDe(comKmL),
    rsL: div(soma(comLitros, valor), soma(comLitros, litros)),
    kmLComum: kmLDe(comKmL.filter(l => l[5] === 'C')),
    kmLAditivada: kmLDe(comKmL.filter(l => l[5] === 'A')),
    rsKmCombustivel: div(soma(comKmL, valor), kmDe(comKmL)),
    rsKmTotal: div(total, km),
    cashback: soma(no, l => (ehNumero(l[8]) ? l[8] : 0)),
  };
}

function formatarResumo(titulo, r) {
  const rs = n => (ehNumero(n) ? 'R$ ' + fmtNum(n) : '—');
  const cat = c => rs(r.porCategoria[c] || 0);
  return [
    `📊 ${titulo}`,
    `Total: ${rs(r.total)}`,
    `⛽ Combustível: ${cat('Combustível')}`,
    `🔧 Manutenção: ${cat('Manutenção')}`,
    `🏛️ Impostos: ${cat('Imposto')}`,
    `🛡️ Seguro: ${cat('Seguro')}`,
    `🛣️ ${milhar(String(r.km))} km · ${fmtNum(r.kmL)} km/L · ${rs(r.rsL)}/L`,
    `💰 ${rs(r.rsKmCombustivel)}/km só combustível · ${rs(r.rsKmTotal)}/km com tudo`,
    `Comum: ${fmtNum(r.kmLComum)} km/L · Aditivada: ${fmtNum(r.kmLAditivada)} km/L`,
    `💸 Cashback: ${rs(r.cashback)}`,
  ].join('\n');
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho',
  'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** {inicio, fim, titulo} do mês anterior a `agora`. */
function mesAnterior(agora) {
  const inicio = new Date(agora.getFullYear(), agora.getMonth() - 1, 1);
  return { inicio, fim: new Date(agora.getFullYear(), agora.getMonth(), 1), titulo: `${MESES[inicio.getMonth()]} de ${inicio.getFullYear()}` };
}

/** Linha "vs mês anterior" do resumo mensal; '' se o mês anterior não teve gasto. */
function comparacao(atual, anterior, mes) {
  if (!(anterior.total > 0)) return '';
  const d = Math.round((atual.total - anterior.total) / anterior.total * 100);
  const gasto = d === 0 ? `igual a ${mes}` : `${Math.abs(d)}% a ${d > 0 ? 'mais' : 'menos'} que ${mes}`;
  const kmL = ehNumero(atual.kmL) && ehNumero(anterior.kmL) ? ` · km/L era ${fmtNum(anterior.kmL)}` : '';
  return `📈 Gasto ${gasto} (R$ ${fmtNum(anterior.total)})${kmL}`;
}

const CONSUMO_QUEDA = 0.10;

/**
 * Avisa quando os 3 últimos km/L (contando o novo) ficaram todos 10% abaixo da média
 * dos 10 anteriores (mínimo 3). Pneu murcho, filtro, vela: algo mudou.
 */
function avisoConsumo(linhas, novoKmL) {
  if (!ehNumero(novoKmL)) return null;
  const kmLs = combustiveis(linhas).filter(l => ehNumero(l[7])).map(l => l[7]).concat(novoKmL);
  const recentes = kmLs.slice(-3);
  const base = kmLs.slice(-13, -3);
  if (recentes.length < 3 || base.length < 3) return null;
  const media = base.reduce((s, k) => s + k, 0) / base.length;
  return recentes.every(k => k < media * (1 - CONSUMO_QUEDA))
    ? `⚠️ Consumo caiu: os 3 últimos ficaram abaixo de ${fmtNum(media * (1 - CONSUMO_QUEDA))} km/L (sua média é ${fmtNum(media)}). Vale olhar pneu e manutenção.`
    : null;
}

const semAcento = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * "/resumo <arg>": "" (ano corrente), "2025", "outubro", "out", "10/2026" ou "mes" (mês corrente)
 * → {inicio, fim, titulo}; null se não entendeu. Mês sem ano depois do atual = ano passado.
 */
function periodoDe(arg, agora) {
  const t = semAcento(String(arg || '').trim());
  const mes = (ano, m) => ({ inicio: new Date(ano, m, 1), fim: new Date(ano, m + 1, 1), titulo: `${MESES[m]} de ${ano}` });
  const ano = a => ({ inicio: new Date(a, 0, 1), fim: new Date(a + 1, 0, 1), titulo: String(a) });
  if (!t) return ano(agora.getFullYear());
  if (t === 'mes') return mes(agora.getFullYear(), agora.getMonth());
  let m = /^(20\d\d)$/.exec(t);
  if (m) return ano(Number(m[1]));
  m = /^(\d{1,2})\/(20\d\d)$/.exec(t);
  if (m && m[1] >= 1 && m[1] <= 12) return mes(Number(m[2]), m[1] - 1);
  m = /^([a-z]{3,})(?:\s+(?:de\s+)?(20\d\d))?$/.exec(t);
  const i = m ? MESES.findIndex(n => semAcento(n).startsWith(m[1])) : -1;
  if (i < 0) return null;
  if (m[2]) return mes(Number(m[2]), i);
  return mes(i > agora.getMonth() ? agora.getFullYear() - 1 : agora.getFullYear(), i);
}

/**
 * Projeção do ano: Combustível e Manutenção no ritmo diário desde o 1º lançamento do ano;
 * Imposto e Seguro como já pagos (são anuais). null com menos de 30 dias de dados.
 */
function previsaoAno(linhas, agora) {
  const ano = agora.getFullYear();
  const doAno = linhas.filter(l => l[0] instanceof Date && l[0].getFullYear() === ano && l[0] <= agora && ehNumero(l[2]));
  if (!doAno.length) return null;
  const inicio = doAno.reduce((m, l) => (l[0] < m ? l[0] : m), doAno[0][0]);
  const dia = 86400000;
  const passados = (inicioDoDia(agora) - inicioDoDia(inicio)) / dia + 1;
  if (passados < 30) return null;
  const totalDias = (new Date(ano + 1, 0, 1) - inicioDoDia(inicio)) / dia;
  const soma = f => doAno.filter(f).reduce((s, l) => s + l[2], 0);
  const ritmo = soma(l => ['Combustível', 'Manutenção'].includes(l[1]));
  return ritmo * totalDias / passados + soma(l => !['Combustível', 'Manutenção'].includes(l[1]));
}

/** Prompt da pergunta livre: os lançamentos vão como CSV. */
function promptPergunta(pergunta, linhas, hoje) {
  const iso = d => (d instanceof Date ? [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-') : '');
  const csv = linhas.map(l => [iso(l[0])].concat(l.slice(1).map(v => String(v).replace(/[;\n]/g, ' '))).join(';'));
  return [
    'Você é o frentista-bot, que anota os gastos do carro do usuário. Responda em português do Brasil,',
    'curto (até 5 linhas), texto puro sem markdown, valores como R$ 1.234,56, tom simpático de frentista ("chefe").',
    `Hoje é ${iso(hoje)}. Use só os dados abaixo; se eles não respondem, diga isso. Não invente.`,
    'Colunas: Data;Categoria;Valor (R$ pago, já sem cashback);Litros;Km (hodômetro);Tipo (C comum, A aditivada);',
    'R$/L;Km/L (km rodados desde o abastecimento anterior ÷ litros deste);Cashback;Descrição (posto ou detalhe).',
    'Se a mensagem não for uma pergunta sobre os gastos do carro, responda numa linha que pode mandar /start pra ver os comandos.',
    '',
    COLUNAS.join(';'),
    ...csv,
    '',
    'Mensagem do usuário: ' + pergunta,
  ].join('\n');
}

/** Km do hodômetro lido pelo Gemini numa foto do painel; null se não deu. */
function kmDoPainel(obj) {
  if (!obj || obj.imagem !== 'painel') return null;
  const km = ehNumero(obj.km) ? Math.round(obj.km) : parseKm(obj.km);
  return km > 0 ? km : null;
}

if (typeof module !== 'undefined') {
  module.exports = {
    COLUNAS, parseNumero, parseKm, parseData, parseMensagem, textoSeguro,
    normalizarGemini, montarAbastecimento, montarDespesa, formatarConfirmacao,
    descreverLinha, kmAnteriorDe, acharDuplicado, avisoPreco, resumoPeriodo, formatarResumo,
    mesAnterior, kmDoPainel, comparacao, despesaDoGemini, acharDespesa, avisoConsumo, periodoDe,
    previsaoAno, promptPergunta,
  };
}
