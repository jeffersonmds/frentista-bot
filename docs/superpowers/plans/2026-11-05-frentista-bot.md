# frentista-bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bot de Telegram em Apps Script que lê prints do Shell Box com Gemini e grava despesas do carro numa Planilha Google.

**Architecture:** `logica.js` (funções puras, testadas no Node) + `Code.js` (Telegram, Gemini, SpreadsheetApp), ambos no mesmo projeto Apps Script vinculado à planilha, publicado com `clasp`.

**Tech Stack:** Google Apps Script (V8), clasp, Telegram Bot API, Gemini API (`gemini-2.5-flash`, `generateContent` com `responseMimeType: application/json`), Node (só para `node test.js`).

**Spec:** `docs/superpowers/specs/2026-11-05-frentista-bot-design.md`

## Global Constraints

- Repo público: nenhum token, chat_id, scriptId, dado financeiro real, placa ou print no git. Exemplos e testes com valores fictícios.
- Segredos só em Script Properties: `TELEGRAM_TOKEN`, `GEMINI_API_KEY`, `WEBHOOK_SECRET`, `CHAT_ID`.
- `.gitignore`: `.clasp.json`, `migracao.local.js`, `*.xlsx`, `*.png`, `*.jpg`, `node_modules/`.
- `.claspignore`: tudo exceto `appsscript.json`, `Code.js`, `logica.js`, `migracao.local.js`.
- Colunas de `Lançamentos`, nesta ordem: `Data, Categoria, Valor, Litros, Km, Tipo, R$/L, Km/L, Cashback, Descrição`.
- Categorias: `Combustível`, `Manutenção`, `Imposto`, `Seguro`. Tipo: `C` ou `A`.
- Valor = valorPago − cashback. Km/L = (km − km anterior) ÷ litros; vazio sem anterior. Aviso se Km/L fora de 5–25.
- Textos do bot em PT-BR, tom de frentista ("chefe").
- Sem dependências npm. `logica.js` termina com `if (typeof module !== 'undefined') module.exports = {...}`.

## Review Focus

1. Print pago com créditos mostra "Total R$ 0,00" → Gemini pode devolver 0; `normalizarGemini` deve rejeitar `valorPago <= 0` (bot pede formato texto).
2. Legenda de km escrita `48.250` ou `48250 km` → deve virar 48250.
3. Primeiro abastecimento da planilha (sem anterior) → grava com Km/L vazio, sem erro nem aviso.
4. Gemini devolve data fora de `yyyy-mm-dd` ou ausente → usa hoje.
5. Valores com prefixo `R$` ou espaço (`R$ 72,40`) vindos do Gemini como string → número correto.

Testes desses cinco estão nas Tasks 1 e 2.

---

### Task 1: Scaffold + parse de números, datas e mensagens

**Files:**
- Create: `logica.js`, `test.js`, `appsscript.json`, `.gitignore`, `.claspignore`, `.clasp.json.example`, `LICENSE` (MIT, "Jefferson Morais")

**Interfaces:**
- Produces (em `logica.js`):
  - `COLUNAS: string[]` (as 10 da Global Constraints)
  - `parseNumero(s: string|number): number|null` — aceita `72,40`, `72.4`, `R$ 72,40`; `null` se inválido
  - `parseKm(s: string): number|null` — remove tudo que não é dígito; `null` se vazio
  - `parseData(s: string, hoje: Date): Date|null` — `dd/mm` (ano de `hoje`) ou `dd/mm/yyyy`
  - `parseMensagem(texto: string, hoje: Date)` retorna um de:
    - `{tipo:'abastecimento', valor, litros, km, combustivel:'C'|'A'}` para `72,40 11,20 48250 a`
    - `{tipo:'despesa', categoria, valor, descricao, data}` para `/manut|/imposto|/seguro <valor> [descrição] [data]` (data = último token se `parseData` aceitar; senão hoje)
    - `{tipo:'comando', nome:'resumo'|'desfazer'|'start'}`
    - `{tipo:'km', km}` para mensagem só com número
    - `{tipo:'invalido'}`

`appsscript.json`: `{"timeZone":"America/Sao_Paulo","runtimeVersion":"V8","exceptionLogging":"STACKDRIVER","webapp":{"executeAs":"USER_DEPLOYING","access":"ANYONE_ANONYMOUS"}}`

- [ ] **Step 1: Escrever testes em `test.js`** (`const assert = require('assert'); const L = require('./logica.js');`, `hoje = new Date(2026, 10, 5)`):
  - `parseNumero('72,40') === 72.4`, `parseNumero('R$ 72,40') === 72.4`, `parseNumero('11.2') === 11.2`, `parseNumero('abc') === null`
  - `parseKm('48.250') === 48250`, `parseKm('48250 km') === 48250`, `parseKm('') === null`
  - `parseData('26/12', hoje)` → 2026-12-26; `parseData('26/12/2025', hoje)` → 2025-12-26; `parseData('xx', hoje) === null`
  - `parseMensagem('72,40 11,20 48250 a', hoje)` deepEqual `{tipo:'abastecimento', valor:72.4, litros:11.2, km:48250, combustivel:'A'}`
  - `parseMensagem('/manut 380 troca de óleo', hoje)` → `categoria:'Manutenção', valor:380, descricao:'troca de óleo'`, data = hoje
  - `parseMensagem('/seguro 3000 26/12/2025', hoje)` → `categoria:'Seguro', descricao:'', data` 2025-12-26
  - `parseMensagem('/imposto 1200 IPVA', hoje).categoria === 'Imposto'`
  - `parseMensagem('/resumo', hoje)` → `{tipo:'comando', nome:'resumo'}`; idem `/desfazer`, `/start`
  - `parseMensagem('48250', hoje)` → `{tipo:'km', km:48250}`
  - `parseMensagem('oi', hoje).tipo === 'invalido'`; `parseMensagem('/manut abc', hoje).tipo === 'invalido'`
  - termina com `console.log('ok')`
- [ ] **Step 2:** `node test.js` → falha (`Cannot find module` ou função indefinida).
- [ ] **Step 3:** Implementar as funções em `logica.js` e criar os arquivos de config.
- [ ] **Step 4:** `node test.js` → `ok`.
- [ ] **Step 5:** `git add -A && git commit -m "feat: parse de mensagens e scaffold"`

### Task 2: Cálculos, validações e normalização do Gemini

**Files:**
- Modify: `logica.js`, `test.js`

**Interfaces:**
- Consumes: `parseNumero`, `COLUNAS` (Task 1)
- Produces:
  - `normalizarGemini(obj, hoje: Date): {data: Date, litros, valorPago, cashback, combustivel:'C'|'A', posto: string}|null` — números via `parseNumero`; `cashback` ausente → 0; `data` só aceita `yyyy-mm-dd`, senão `hoje`; `tipo` contendo "v-power" ou "aditivad" (case-insensitive) → `A`, senão `C`; `null` se `litros` ou `valorPago` ≤ 0/ausentes
  - `montarAbastecimento(a: {data, valorPago, cashback, litros, km, combustivel, posto}, kmAnterior: number|null): {erro: string} | {linha: any[], kmRodado: number|null, kmPorLitro: number|null, aviso: string|null}`
    - `erro` se `kmAnterior !== null && km <= kmAnterior` (texto contém "hodômetro")
    - `linha` na ordem de `COLUNAS`; Categoria `Combustível`; R$/L e Km/L arredondados a 2 casas; Km/L `''` sem anterior; Cashback `''` se 0
    - `aviso` se Km/L < 5 ou > 25
  - `montarDespesa(d: {categoria, valor, descricao, data}): any[]` — linha em `COLUNAS`, campos de combustível `''`
  - `formatarConfirmacao(linha: any[], kmRodado: number|null, aviso: string|null): string` — ex. `⛽ Anotado, chefe! 04/11 · Aditivada · 11,20 L · R$ 72,40 (R$ 6,46/L) · 150 km → 13,39 km/L` (vírgula decimal; partes de km omitidas se null; aviso em nova linha). Para despesas: `🧾 Anotado, chefe! 05/11 · Manutenção · R$ 380,00 · troca de óleo`.

- [ ] **Step 1: Testes:**
  - `normalizarGemini({data:'2026-11-04', litros:'10,5', valorPago:'R$ 70,00', tipo:'Shell V-Power Gasolina', posto:'Posto X'}, hoje)` → `litros:10.5, valorPago:70, cashback:0, combustivel:'A'`, data 2026-11-04
  - `normalizarGemini({data:'04/11/2026', litros:23.4, valorPago:150, cashback:7.5, tipo:'Gasolina Comum'}, hoje)` → data = hoje, `combustivel:'C'`, `cashback:7.5`
  - `normalizarGemini({litros:10, valorPago:0}, hoje) === null`
  - `montarAbastecimento({data:hoje, valorPago:150, cashback:7.5, litros:23.4, km:10000, combustivel:'C', posto:'P'}, 9700)` → `linha[2] === 142.5`, `linha[6] === 6.09`, `kmRodado === 300`, `linha[7] === 12.82`, `linha[8] === 7.5`, `aviso === null`
  - `montarAbastecimento({... km:500 ...}, null)` → `linha[7] === ''`, `kmRodado === null`, `aviso === null`
  - `montarAbastecimento({... km:9000 ...}, 9700).erro` contém `'hodômetro'`
  - km 10600 com anterior 9700 e 10 L → `aviso` não nulo (90 km/L)
  - `montarDespesa({categoria:'Seguro', valor:3000, descricao:'', data:hoje})[3] === ''` e `[2] === 3000`
  - `formatarConfirmacao(linhaDo142_5, 300, null)` contém `'R$ 142,50'` e `'12,82 km/L'`
- [ ] **Step 2:** `node test.js` → falha.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `node test.js` → `ok`.
- [ ] **Step 5:** `git commit -am "feat: cálculos, validações e normalização do Gemini"`

### Task 3: Planilha (abas, gravação, resumo)

**Files:**
- Create: `Code.js` (seção planilha)

**Interfaces:**
- Consumes: `COLUNAS`
- Produces:
  - `configurarPlanilha(): void` — cria/renomeia aba `Lançamentos` com cabeçalho `COLUNAS` congelado e formatos (data `dd/MM/yyyy`, moeda em Valor/R$/L/Cashback); cria aba `Resumo` com anos 2026–2030 nas colunas B..F e linhas: Gasto total, Combustível, Manutenção, Imposto, Seguro, Km rodado, Litros, Km/L médio, R$/L médio, Km/L Comum, Km/L Aditivada, R$/L Comum, R$/L Aditivada, Cashback. Fórmulas com `SUMPRODUCT((YEAR(Lançamentos!A2:A)=B$1)*...)`; Km rodado = MAX−MIN de Km de combustível no ano. Km/L médio = SUMPRODUCT(Km/L × Litros) ÷ SUMPRODUCT(Litros) só nas linhas com Km/L preenchido (Km/L × Litros = km do intervalo, então isso é km total ÷ litros total sem o 1º abastecimento); por tipo, o mesmo filtrando Tipo. Usar `IFERROR(...;"")`.
  - `kmAnterior(): number|null` — maior Km entre linhas `Combustível`
  - `gravarLinha(linha: any[]): void` — `appendRow`
  - `desfazer(): any[]|null` — apaga a última linha se houver dados (nunca o cabeçalho); retorna a linha apagada
  - `resumoTexto(hoje: Date): string` — lê a coluna do ano atual em `Resumo` + último abastecimento

- [ ] **Step 1:** `clasp create --type sheets --title "Despesas Carro" --rootDir .` (cria `.clasp.json`, ignorado pelo git). Confirmar `git status` sem `.clasp.json`.
- [ ] **Step 2:** Implementar e `clasp push`.
- [ ] **Step 3:** No editor, executar `configurarPlanilha()` e uma função temporária que grava 2 abastecimentos e 1 despesa fictícios; conferir no Resumo os valores esperados à mão; executar `desfazer()` 4 vezes → só o cabeçalho sobra.
- [ ] **Step 4:** `git add Code.js && git commit -m "feat: planilha, gravação e resumo"`

### Task 4: Telegram, Gemini e roteamento

**Files:**
- Modify: `Code.js`

**Interfaces:**
- Consumes: Tasks 1–3
- Produces:
  - `doPost(e)` — retorna `ContentService.createTextOutput('ok')` sempre; descarta se `e.parameter.s !== WEBHOOK_SECRET`; parse do body; ignora `chat.id != CHAT_ID`; ignora `update_id <= ULTIMO_UPDATE` (Script Property, atualizada antes de processar); `try/catch` em volta de tudo, erro → `enviar('Deu ruim aqui, chefe: ' + msg)`
  - `enviar(texto: string): void` — `sendMessage`
  - `lerPrint(fileId: string): object|null` — `getFile` → baixa → base64 → Gemini com o prompt abaixo
  - `configurarWebhook(): void` — `setWebhook` com `ScriptApp.getService().getUrl() + '?s=' + WEBHOOK_SECRET`, `drop_pending_updates: true`; loga a resposta
  - Pendente: Script Property `PENDENTE` = JSON do resultado de `normalizarGemini` (datas como ISO)

Prompt do Gemini (texto exato):
```
Este é um comprovante de abastecimento do app Shell Box. Responda só JSON:
{"data":"yyyy-mm-dd","litros":number,"precoLitro":number,"valorPago":number,"cashback":number,"tipo":string,"posto":string}
valorPago = valor do combustível depois dos descontos (posto, Shell Box), SEM abater "Créditos Shell" — créditos são dinheiro já pago. Se houver só "Valor total" sem descontos, use-o.
cashback = valor de cashback anunciado, ou 0.
tipo = nome do combustível como aparece (ex.: "Shell V-Power Gasolina", "Gasolina Comum").
```

Roteamento:
- foto (maior `photo[]`): `normalizarGemini(lerPrint(...))`; `null` → pede formato texto. Legenda com `parseKm` → `montarAbastecimento` com `kmAnterior()`; sem km → salva `PENDENTE`, pergunta "Qual o km, chefe?"
- `km` com `PENDENTE` → completa e limpa; sem pendente → `invalido`
- `abastecimento` → `montarAbastecimento({...m, data: hoje, valorPago: m.valor, cashback: 0, posto: ''}, kmAnterior())`
- `despesa` → `montarDespesa`; `comando` → resumo/desfazer/ajuda; `invalido` → ajuda curta
- `erro` → envia o erro sem gravar

- [ ] **Step 1:** Implementar; `clasp push`.
- [ ] **Step 2:** Usuário preenche Script Properties. No editor, executar uma função temporária que chama `lerPrint` com o `file_id` de cada print real enviado ao bot (obter via `getUpdates` antes do webhook) e loga o resultado: conferir contra os valores visíveis em cada print (V-Power pago com créditos → `valorPago` = subtotal − descontos, `A`; Comum → `valorPago` = valor total, `cashback` anunciado, `C`). Ajustar o prompt se divergir. Apagar a função.
- [ ] **Step 3:** `clasp deploy -d "v1"`; executar `configurarWebhook()` → resposta `"ok":true`.
- [ ] **Step 4:** No Telegram: `/start`, `/manut 1 teste`, `/desfazer`, print sem legenda + km, print com legenda, `/resumo`. Mensagem repetida não duplica (conferir planilha).
- [ ] **Step 5:** `git commit -am "feat: bot do Telegram com leitura de prints"`

### Task 5: Migração do xlsx

**Files:**
- Create: `exportar-xlsx.ps1`; gera `migracao.local.js` (ignorado)

**Interfaces:**
- `exportar-xlsx.ps1 -Caminho <xlsx>` — abre via Excel COM (somente leitura), lê combustível (colunas D–H: data, litros, custo, km, tipo), manutenções (N–Q: data, item, custo, km) e impostos/seguro (T–V: data, item, custo; item contendo "seguro" → `Seguro`, senão `Imposto`); pula linhas sem data ou custo; escreve `migracao.local.js` com `const MIGRACAO = [[...linha em COLUNAS...]]` (datas como `new Date(y,m-1,d)`) e `function migrar(){ ... }` que recalcula R$/L e Km/L em ordem cronológica (Km/L só quando há km atual e anterior) e grava tudo com `setValues`.
- Nenhum caminho pessoal hardcoded no script: o caminho é parâmetro.

- [ ] **Step 1:** Rodar o script com o xlsx do usuário; conferir no arquivo gerado: contagem de linhas e 3 lançamentos por amostragem batem com o xlsx; lançamentos de dez/2025 presentes com ano 2025.
- [ ] **Step 2:** `clasp push`; usuário executa `migrar()`; conferir no Resumo: gasto total de 2026 ≈ total da planilha antiga, menos lançamentos de 2025.
- [ ] **Step 3:** Apagar `migracao.local.js`; `clasp push`.
- [ ] **Step 4:** `git add exportar-xlsx.ps1 && git commit -m "feat: migração do xlsx"`

### Task 6: README e publicação

**Files:**
- Create: `README.md`

Seções: nome + uma linha de pitch com persona; exemplo de conversa (bloco de texto, dados fictícios); o que faz; diagrama; instalação passo a passo (BotFather, chat_id via `getUpdates`, AI Studio, `clasp login`, `clasp create --type sheets`, Script Properties com tabela, `configurarPlanilha()`, deploy, `configurarWebhook()`); comandos (tabela da spec); estrutura da planilha; migração opcional; testes (`node test.js`); privacidade (o que fica onde); custo; limitações (só Shell Box, Gemini pode errar → `/desfazer`); licença.

- [ ] **Step 1:** Escrever README.
- [ ] **Step 2:** Varredura: `git log -p | Select-String -Pattern '\d{8,10}:[A-Za-z0-9_-]{35}','AIza[0-9A-Za-z_-]{35}'` → nada; `git ls-files` sem `.clasp.json`, xlsx, imagens ou `migracao.local.js`; grep do histórico pela placa e pelo nome do posto real → nada.
- [ ] **Step 3:** `git commit -m "docs: README"`; usuário cria o repo público e faz push (`gh repo create frentista-bot --public --source . --push`) após confirmar.
