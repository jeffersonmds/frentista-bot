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
    if (cmd === '/resumo' || cmd === '/desfazer' || cmd === '/start') {
      return { tipo: 'comando', nome: cmd.slice(1) };
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

/** Limpa o JSON devolvido pelo Gemini; null se não dá pra confiar nele. */
function normalizarGemini(obj, hoje) {
  if (!obj || typeof obj !== 'object') return null;
  const litros = parseNumero(obj.litros);
  const valorPago = parseNumero(obj.valorPago);
  if (!(litros > 0) || !(valorPago > 0)) return null; // ex.: "Total R$ 0,00" quando pago com créditos
  const cashback = obj.cashback == null ? 0 : parseNumero(obj.cashback);
  if (cashback === null || cashback < 0 || cashback >= valorPago) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(obj.data || ''));
  const data = iso ? parseData(`${iso[3]}/${iso[2]}/${iso[1]}`, hoje) || inicioDoDia(hoje) : inicioDoDia(hoje);
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

function fmtNum(n) {
  return typeof n === 'number' ? n.toFixed(2).replace('.', ',') : '—'; // linhas migradas podem não ter litros
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
    `🛣️ ${r.km} km · ${fmtNum(r.kmL)} km/L · ${rs(r.rsL)}/L`,
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
    mesAnterior, kmDoPainel,
  };
}
