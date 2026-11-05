// node test.js — testes da lógica pura (dados fictícios)
const assert = require('assert');
const L = require('./logica.js');

const hoje = new Date(2026, 10, 5);
const ymd = d => d && [d.getFullYear(), d.getMonth() + 1, d.getDate()].join('-');

// parseNumero
assert.strictEqual(L.parseNumero('72,40'), 72.4);
assert.strictEqual(L.parseNumero('R$ 72,40'), 72.4);
assert.strictEqual(L.parseNumero('11.2'), 11.2);
assert.strictEqual(L.parseNumero(12.5), 12.5);
assert.strictEqual(L.parseNumero('abc'), null);

// parseKm
assert.strictEqual(L.parseKm('48.250'), 48250);
assert.strictEqual(L.parseKm('48250 km'), 48250);
assert.strictEqual(L.parseKm(''), null);
assert.strictEqual(L.parseKm(undefined), null);

// parseData
assert.strictEqual(ymd(L.parseData('26/12', hoje)), '2026-12-26');
assert.strictEqual(ymd(L.parseData('26/12/2025', hoje)), '2025-12-26');
assert.strictEqual(L.parseData('xx', hoje), null);
assert.strictEqual(L.parseData('31/02/2026', hoje), null);

// parseMensagem
assert.deepStrictEqual(L.parseMensagem('72,40 11,20 48250 a', hoje),
  { tipo: 'abastecimento', valor: 72.4, litros: 11.2, km: 48250, combustivel: 'A' });
let m = L.parseMensagem('/manut 380 troca de óleo', hoje);
assert.strictEqual(m.tipo, 'despesa');
assert.strictEqual(m.categoria, 'Manutenção');
assert.strictEqual(m.valor, 380);
assert.strictEqual(m.descricao, 'troca de óleo');
assert.strictEqual(ymd(m.data), '2026-11-5');
m = L.parseMensagem('/seguro 3000 26/12/2025', hoje);
assert.strictEqual(m.categoria, 'Seguro');
assert.strictEqual(m.descricao, '');
assert.strictEqual(ymd(m.data), '2025-12-26');
assert.strictEqual(L.parseMensagem('/imposto 1200 IPVA', hoje).categoria, 'Imposto');
assert.deepStrictEqual(L.parseMensagem('/resumo', hoje), { tipo: 'comando', nome: 'resumo' });
assert.deepStrictEqual(L.parseMensagem('/desfazer', hoje), { tipo: 'comando', nome: 'desfazer' });
assert.deepStrictEqual(L.parseMensagem('/start', hoje), { tipo: 'comando', nome: 'start' });
assert.deepStrictEqual(L.parseMensagem('48250', hoje), { tipo: 'km', km: 48250 });
assert.strictEqual(L.parseMensagem('oi', hoje).tipo, 'invalido');
assert.strictEqual(L.parseMensagem('/manut abc', hoje).tipo, 'invalido');

// normalizarGemini
let g = L.normalizarGemini({ data: '2026-11-04', litros: '10,5', valorPago: 'R$ 70,00', tipo: 'Shell V-Power Gasolina', posto: 'Posto X' }, hoje);
assert.strictEqual(g.litros, 10.5);
assert.strictEqual(g.valorPago, 70);
assert.strictEqual(g.cashback, 0);
assert.strictEqual(g.combustivel, 'A');
assert.strictEqual(g.posto, 'Posto X');
assert.strictEqual(ymd(g.data), '2026-11-4');
g = L.normalizarGemini({ data: '04/11/2026', litros: 23.4, valorPago: 150, cashback: 7.5, tipo: 'Gasolina Comum' }, hoje);
assert.strictEqual(ymd(g.data), '2026-11-5');
assert.strictEqual(g.combustivel, 'C');
assert.strictEqual(g.cashback, 7.5);
assert.strictEqual(g.posto, '');
assert.strictEqual(L.normalizarGemini({ litros: 10, valorPago: 0 }, hoje), null);
assert.strictEqual(L.normalizarGemini(null, hoje), null);

// montarAbastecimento
const base = { data: hoje, valorPago: 150, cashback: 7.5, litros: 23.4, km: 10000, combustivel: 'C', posto: 'P' };
let r = L.montarAbastecimento(base, 9700);
assert.strictEqual(r.linha.length, L.COLUNAS.length);
assert.strictEqual(r.linha[1], 'Combustível');
assert.strictEqual(r.linha[2], 142.5);
assert.strictEqual(r.linha[6], 6.09);
assert.strictEqual(r.kmRodado, 300);
assert.strictEqual(r.linha[7], 12.82);
assert.strictEqual(r.linha[8], 7.5);
assert.strictEqual(r.aviso, null);
const r142 = r;
r = L.montarAbastecimento({ ...base, km: 500 }, null);
assert.strictEqual(r.linha[7], '');
assert.strictEqual(r.kmRodado, null);
assert.strictEqual(r.aviso, null);
assert.ok(L.montarAbastecimento({ ...base, km: 9000 }, 9700).erro.includes('hodômetro'));
assert.ok(L.montarAbastecimento({ ...base, km: 9700 }, 9700).erro);
assert.ok(L.montarAbastecimento({ ...base, km: 10600, litros: 10 }, 9700).aviso);
assert.strictEqual(L.montarAbastecimento({ ...base, cashback: 0 }, 9700).linha[8], '');

// montarDespesa
const d = L.montarDespesa({ categoria: 'Seguro', valor: 3000, descricao: '', data: hoje });
assert.strictEqual(d.length, L.COLUNAS.length);
assert.strictEqual(d[2], 3000);
assert.strictEqual(d[3], '');

// formatarConfirmacao
let txt = L.formatarConfirmacao(r142.linha, 300, null);
assert.ok(txt.includes('R$ 142,50'), txt);
assert.ok(txt.includes('12,82 km/L'), txt);
assert.ok(txt.includes('05/11'), txt);
txt = L.formatarConfirmacao(L.montarDespesa({ categoria: 'Manutenção', valor: 380, descricao: 'troca de óleo', data: hoje }), null, null);
assert.ok(txt.includes('R$ 380,00') && txt.includes('troca de óleo'), txt);
assert.ok(L.formatarConfirmacao(r142.linha, 300, 'confere').includes('\n'));
// linha migrada sem litros não quebra
assert.ok(L.formatarConfirmacao([hoje, 'Combustível', 100, '', '', 'C', '', '', '', ''], null, null).includes('R$ 100,00'));

// revisão do Codex
assert.strictEqual(L.parseKm('48250.5'), null);
assert.strictEqual(L.parseKm('-48250'), null);
assert.strictEqual(L.parseKm('48250 04/11'), null);
assert.strictEqual(L.parseKm('48.25'), null);
assert.strictEqual(L.parseKm(' 48250 KM '), 48250);
assert.strictEqual(L.parseMensagem('72,40 11,20 48250 km a', hoje).km, 48250);
assert.strictEqual(L.parseMensagem('/manut 380 óleo 31/02/2026', hoje).tipo, 'invalido');
assert.strictEqual(ymd(L.normalizarGemini({ data: '2026-02-31', litros: 10, valorPago: 70 }, hoje).data), '2026-11-5');
assert.strictEqual(L.normalizarGemini({ litros: 10, valorPago: 70, cashback: 100 }, hoje), null);
assert.strictEqual(L.normalizarGemini({ litros: 10, valorPago: 70, cashback: -1 }, hoje), null);
assert.strictEqual(L.normalizarGemini({ litros: 10, valorPago: 70, posto: '=IMPORTXML("x")' }, hoje).posto, "'=IMPORTXML(\"x\")");
assert.strictEqual(L.parseMensagem('/manut 50 =1+1', hoje).descricao, "'=1+1");

// melhorias: linhas fictícias da aba Lançamentos
const dia = (m, d) => new Date(2026, m - 1, d);
const ab = (data, valor, litros, km, tipo, kmL) => [data, 'Combustível', valor, litros, km, tipo, L.parseNumero((valor / litros).toFixed(2)), kmL, '', ''];
const linhas = [
  ab(dia(9, 1), 60, 10, 1000, 'C', ''),
  ab(dia(9, 15), 62, 10, 1120, 'C', 12),
  [dia(9, 20), 'Manutenção', 300, '', '', '', '', '', '', 'óleo'],
  ab(dia(10, 1), 61, 10, 1260, 'A', 14),
  ab(dia(10, 10), 60, 10, 1400, 'C', 14),
  [dia(10, 12), 'Imposto', 100, '', '', '', '', '', 5, 'licenciamento'],
];

// kmAnteriorDe: último abastecimento, ignorando outras categorias
assert.strictEqual(L.kmAnteriorDe(linhas), 1400);
assert.strictEqual(L.kmAnteriorDe([]), null);
assert.strictEqual(L.kmAnteriorDe([ab(dia(9, 1), 60, 10, '', 'C', '')]), null);

// acharDuplicado: mesma data, litros e valor líquido
const dup = { data: dia(10, 10), valorPago: 62, cashback: 2, litros: 10 };
assert.ok(L.acharDuplicado(linhas, dup));
assert.strictEqual(L.acharDuplicado(linhas, { ...dup, litros: 11 }), null);
assert.strictEqual(L.acharDuplicado(linhas, { ...dup, data: dia(10, 11) }), null);
assert.strictEqual(L.acharDuplicado(linhas, { ...dup, cashback: 0 }), null);
assert.ok(L.descreverLinha(linhas[4]).startsWith('10/10'));

// avisoPreco: média dos últimos do mesmo tipo, mínimo 3
assert.strictEqual(L.avisoPreco(linhas, 'C', 6.1), null);
assert.ok(L.avisoPreco(linhas, 'C', 7.5));
assert.ok(L.avisoPreco(linhas, 'C', 5));
assert.strictEqual(L.avisoPreco(linhas, 'A', 9), null); // só 1 aditivada no histórico

// resumoPeriodo: outubro
let rp = L.resumoPeriodo(linhas, dia(10, 1), dia(11, 1));
assert.strictEqual(rp.total, 221);
assert.strictEqual(rp.porCategoria['Combustível'], 121);
assert.strictEqual(rp.porCategoria['Imposto'], 100);
assert.strictEqual(rp.litros, 20);
assert.strictEqual(rp.km, 280);
assert.strictEqual(rp.kmL, 14);
assert.strictEqual(rp.rsL, 6.05);
assert.strictEqual(rp.kmLComum, 14);
assert.strictEqual(rp.kmLAditivada, 14);
assert.strictEqual(rp.rsKmCombustivel, 121 / 280);
assert.strictEqual(rp.rsKmTotal, 221 / 280);
assert.strictEqual(rp.cashback, 5);
// setembro: o primeiro abastecimento não tem Km/L e fica fora do km e do R$/km
rp = L.resumoPeriodo(linhas, dia(9, 1), dia(10, 1));
assert.strictEqual(rp.km, 120);
assert.strictEqual(rp.litros, 20);
assert.strictEqual(rp.rsKmCombustivel, 62 / 120);
assert.strictEqual(rp.kmLAditivada, null);
// linha com Km/L mas sem litros não entra no R$/km (revisão do Codex)
rp = L.resumoPeriodo([linhas[1], [dia(9, 16), 'Combustível', 60, '', 1200, 'C', '', 12, '', '']], dia(9, 1), dia(10, 1));
assert.strictEqual(rp.rsKmCombustivel, 62 / 120);
// período vazio não quebra
rp = L.resumoPeriodo(linhas, dia(1, 1), dia(2, 1));
assert.strictEqual(rp.total, 0);
assert.strictEqual(rp.kmL, null);
txt = L.formatarResumo('janeiro de 2026', rp);
assert.ok(txt.includes('janeiro de 2026') && txt.includes('—'), txt);
txt = L.formatarResumo('2026', L.resumoPeriodo(linhas, dia(1, 1), new Date(2027, 0, 1)));
assert.ok(txt.includes('/km só combustível') && txt.includes('400 km'), txt);

// separador de milhar
txt = L.formatarResumo('2026', { ...L.resumoPeriodo([], dia(1, 1), dia(2, 1)), total: 8678.22, km: 10035 });
assert.ok(txt.includes('R$ 8.678,22') && txt.includes('10.035 km'), txt);
assert.ok(L.formatarConfirmacao([hoje, 'Seguro', 3684.03, '', '', '', '', '', '', ''], null, null).includes('R$ 3.684,03'));

// mesAnterior: inclusive virada de ano
let ma = L.mesAnterior(new Date(2026, 0, 1, 9));
assert.strictEqual(ymd(ma.inicio), '2025-12-1');
assert.strictEqual(ymd(ma.fim), '2026-1-1');
assert.strictEqual(ma.titulo, 'dezembro de 2025');
assert.strictEqual(L.mesAnterior(hoje).titulo, 'outubro de 2026');

// kmDoPainel
assert.strictEqual(L.kmDoPainel({ imagem: 'painel', km: 48250 }), 48250);
assert.strictEqual(L.kmDoPainel({ imagem: 'painel', km: '48.250' }), 48250);
assert.strictEqual(L.kmDoPainel({ imagem: 'painel', km: null }), null);
assert.strictEqual(L.kmDoPainel({ imagem: 'comprovante', km: 48250 }), null);
assert.strictEqual(L.kmDoPainel(null), null);

// comparacao com o mês anterior
assert.strictEqual(L.comparacao({ total: 672, kmL: 14.1 }, { total: 600, kmL: 14.5 }, 'outubro'),
  '📈 Gasto 12% a mais que outubro (R$ 600,00) · km/L era 14,50');
assert.strictEqual(L.comparacao({ total: 300, kmL: null }, { total: 600, kmL: 14.5 }, 'outubro'),
  '📈 Gasto 50% a menos que outubro (R$ 600,00)');
assert.strictEqual(L.comparacao({ total: 600, kmL: 14 }, { total: 600, kmL: null }, 'outubro'),
  '📈 Gasto igual a outubro (R$ 600,00)');
assert.strictEqual(L.comparacao({ total: 600 }, { total: 0 }, 'outubro'), '');

console.log('ok');
