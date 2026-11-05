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

console.log('ok');
