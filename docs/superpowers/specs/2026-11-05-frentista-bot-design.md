# frentista-bot — design

Data: 2026-11-05

## Problema

Despesas do carro são lançadas à mão numa planilha xlsx (uma por ano). O abastecimento é feito pelo app Shell Box, que gera um print de comprovante. Digitar data, litros, valor e km a cada abastecimento é chato e gera erros (km esquecido → km/L distorcido).

## Solução

Bot de Telegram em Google Apps Script. O usuário manda o print do Shell Box com o km na legenda; o Gemini Flash extrai os dados; o bot grava numa Planilha Google única (todos os anos a partir de 2026) e responde no tom de um frentista.

```
iPhone ──print + legenda "48250"──▶ Telegram ◀──getUpdates (gatilho 1 min)── Apps Script
                                                        ├─▶ Gemini Flash (lê o print)
                                                        └─▶ Planilha Google (vinculada ao script)
```

Repositório público no GitHub: nenhum segredo nem dado pessoal versionado.

## Planilha

Criada com `clasp create --type sheets` (script vinculado à planilha). `configurarPlanilha()` salva o ID em `SHEET_ID` (Script Property) e fixa o fuso em America/Sao_Paulo; o gatilho abre a planilha por esse ID, porque não tem planilha "ativa".

### Aba `Lançamentos`

| Coluna | Tipo | Observação |
|---|---|---|
| Data | data | do print; texto: hoje ou data informada |
| Categoria | texto | `Combustível` · `Manutenção` · `Imposto` · `Seguro` |
| Valor | número | **líquido**: pago − cashback |
| Litros | número | só combustível |
| Km | número | hodômetro; obrigatório em combustível, opcional em manutenção |
| Tipo | texto | `C` (Comum) ou `A` (Aditivada / V-Power) |
| R$/L | número | Valor ÷ Litros, gravado pelo bot |
| Km/L | número | (Km − Km do abastecimento anterior) ÷ Litros, gravado pelo bot; vazio se não houver anterior |
| Cashback | número | informativo |
| Descrição | texto | nome do posto ou item da despesa |

### Aba `Resumo`

Só fórmulas, uma coluna por ano: gasto total, gasto por categoria, km rodado, cashback acumulado, km/L médio real (km total ÷ litros total do ano), e km/L e R$/L médios separados por Comum e Aditivada.

### Migração

Script local (PowerShell + Excel COM) lê o xlsx de 2026 e gera `migracao.local.js` com as linhas no formato novo. Esse arquivo está no `.gitignore` (não no `.claspignore`): sobe via `clasp push`, roda uma vez pelo editor e é apagado. Lançamentos com data de 2025 entram como 2025.

## Bot

### Abastecimento por print

1. Mensagem com foto; legenda = km (inteiro).
2. Baixa a imagem via `getFile`, envia em base64 ao Gemini Flash com prompt que exige JSON: `{data, litros, precoLitro, valorPago, cashback, tipo, posto}`.
   - `valorPago`: valor após descontos do posto/Shell Box, antes de abater créditos Shell Box (créditos são dinheiro já carregado).
   - `tipo`: "V-Power" ou "Aditivada" → `A`; "Comum" → `C`.
3. Valor = valorPago − cashback; calcula R$/L e Km/L; grava; responde:
   `⛽ Anotado, chefe! 04/11 · V-Power · 11,20 L · R$ 72,40 (R$ 6,46/L) · 150 km → 13,4 km/L`

### Fluxos de exceção

- **Sem km na legenda**: guarda o lançamento pendente (PropertiesService) e pergunta "Qual o km, chefe?"; a próxima mensagem numérica completa. Um novo print substitui o pendente.
- **Gemini falhou ou JSON inválido**: avisa e pede o formato texto.
- **Km ≤ km do último abastecimento**: recusa e explica.
- **Km/L fora de 5–25**: grava e avisa para conferir.

### Comandos de texto

| Entrada | Efeito |
|---|---|
| `72,40 11,20 48250 a` | abastecimento manual: valor, litros, km, tipo (`c`/`a`) |
| `/manut 380 troca de óleo` | Manutenção |
| `/imposto 1200 IPVA` | Imposto |
| `/seguro 3000` | Seguro |
| data opcional no fim (`26/12` ou `26/12/2025`) | sobrescreve a data de hoje nos três comandos acima |
| `/resumo` | gasto do ano por categoria, km/L médio, último abastecimento |
| `/desfazer` | apaga a última linha de `Lançamentos` |
| `/start` | ajuda curta com os comandos |

Números aceitam vírgula ou ponto decimal.

### Segurança e robustez

- Segredos em Script Properties: `TELEGRAM_TOKEN`, `GEMINI_API_KEY`, `CHAT_ID`. Nunca no código.
- Entrada por polling: gatilho de 1 minuto chama `getUpdates` com `offset` salvo em PropertiesService. Webhook foi descartado: o web app do Apps Script responde POST com 302, o Telegram trata como erro e reenvia o mesmo update com backoff, travando a fila (visto em produção em 2026-11-05).
- Mensagens de outro `chat.id` são ignoradas.
- Deduplicação: o `offset` é gravado antes de processar cada update, então nada é processado duas vezes e um update que quebra não repete.
- Uma execução por vez: `LockService.tryLock` no `verificar`; se a anterior ainda roda, a do minuto seguinte pega.
- Erros no processamento de uma mensagem viram resposta ao usuário ("Deu ruim aqui, chefe").

## Código

```
frentista-bot/
  appsscript.json
  Code.js            # polling, Telegram API, Gemini, leitura/escrita da planilha
  logica.js          # funções puras: parse de comandos/datas/números, cálculos, validações, normalização do JSON do Gemini
  test.js            # node test.js — asserts sobre logica.js com dados fictícios
  exportar-xlsx.ps1  # gera migracao.local.js a partir do xlsx
  .clasp.json.example
  .claspignore       # exclui test.js, exportar-xlsx.ps1, docs/, README etc. do push
  .gitignore         # .clasp.json, migracao.local.js, *.xlsx, prints
  README.md
  LICENSE            # MIT
  docs/
```

`logica.js` não depende de APIs do Apps Script, então roda no Node e no Apps Script. Ao final de `logica.js`, `if (typeof module !== 'undefined') module.exports = {...}` permite o `require` no teste sem quebrar no Apps Script.

## Testes

- `node test.js`: parse dos comandos e do abastecimento manual, datas opcionais, vírgula decimal, líquido = pago − cashback, km/L, validações de km e faixa de km/L, mapeamento V-Power/Comum → A/C.
- Extração do Gemini: validada manualmente com dois prints reais (V-Power pago com créditos; Comum com cashback) antes de ligar o gatilho. Prints não são versionados.

## Repositório público

- Nenhum token, chat_id, scriptId, dado financeiro, placa ou print real no git.
- Exemplos no README e nos testes usam valores fictícios.
- Antes do primeiro push: varredura do histórico por padrões de token (`\d{8,10}:[A-Za-z0-9_-]{35}`, `AIza[0-9A-Za-z_-]{35}`).

## README (PT-BR)

Capricho: nome e persona do bot, GIF/print de conversa com dados fictícios, o que faz, diagrama da arquitetura, passo a passo de instalação (BotFather, AI Studio, clasp, Script Properties, gatilho), comandos, estrutura da planilha, como rodar os testes, privacidade (o que fica onde), custo (zero no free tier do Gemini e do Apps Script), limitações e licença.

## Implantação

1. Usuário: cria bot no @BotFather, chave no Google AI Studio, `npm i -g @google/clasp` e `clasp login`.
2. `clasp create --type sheets --title "Despesas Carro"`.
3. Migração: `exportar-xlsx.ps1` → `clasp push` → usuário executa `migrar()` no editor → apagar `migracao.local.js` e `clasp push`.
4. Usuário preenche as Script Properties.
5. Usuário executa `configurarGatilho()` no editor (cria o gatilho de 1 minuto).
6. Teste ponta a ponta com um print real.

## Fora do escopo

Lembretes (calibragem, IPVA, revisão), gráficos, múltiplos carros, leitura de nota fiscal de oficina, outros apps de pagamento.
