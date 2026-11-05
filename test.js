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

console.log('ok');
