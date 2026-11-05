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

if (typeof module !== 'undefined') {
  module.exports = { COLUNAS, parseNumero, parseKm, parseData, parseMensagem };
}
