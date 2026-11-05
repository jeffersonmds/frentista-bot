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

/** "48.250" | "48250 km" → 48250; null se não tem dígito. */
function parseKm(s) {
  const d = String(s == null ? '' : s).replace(/\D/g, '');
  return d ? Number(d) : null;
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
    const dataNoFim = resto.length ? parseData(resto[resto.length - 1], hoje) : null;
    if (dataNoFim) { data = dataNoFim; resto = resto.slice(0, -1); }
    return { tipo: 'despesa', categoria, valor, descricao: resto.join(' '), data };
  }

  const ab = /^(\S+)\s+(\S+)\s+(\S+)\s+([ac])$/i.exec(t);
  if (ab) {
    const valor = parseNumero(ab[1]), litros = parseNumero(ab[2]), km = parseKm(ab[3]);
    if (valor > 0 && litros > 0 && km) {
      return { tipo: 'abastecimento', valor, litros, km, combustivel: ab[4].toUpperCase() };
    }
    return invalido;
  }

  if (/^[\d.]+(\s*km)?$/i.test(t)) return { tipo: 'km', km: parseKm(t) };
  return invalido;
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
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(obj.data || ''));
  const data = iso ? new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) : inicioDoDia(hoje);
  const tipo = String(obj.tipo || '').toLowerCase();
  return {
    data,
    litros,
    valorPago,
    cashback: parseNumero(obj.cashback) || 0,
    combustivel: /v-?power|aditivad/.test(tipo) ? 'A' : 'C',
    posto: String(obj.posto || ''),
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

if (typeof module !== 'undefined') {
  module.exports = {
    COLUNAS, parseNumero, parseKm, parseData, parseMensagem,
    normalizarGemini, montarAbastecimento, montarDespesa, formatarConfirmacao,
  };
}
