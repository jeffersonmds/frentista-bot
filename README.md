# ⛽ frentista-bot

Um bot de Telegram que anota as despesas do carro pra você. Abasteceu pelo **Shell Box**? Manda o print do comprovante com o km na legenda e o frentista lança tudo numa Planilha Google: litros, valor, preço por litro, consumo e cashback.

Nasceu do tédio de preencher planilha à mão no posto.

```
você   📷 [print do Shell Box]  48250

bot    ⛽ Anotado, chefe! 04/11 · Aditivada · 10,50 L · R$ 70,00 (R$ 6,67/L) · 132 km → 12,57 km/L

você   /manut 380 troca de óleo
bot    🧾 Anotado, chefe! 05/11 · Manutenção · R$ 380,00 · troca de óleo

você   /resumo
bot    📊 2026
       Total: R$ 5.230,00
       ⛽ Combustível: R$ 3.900,00
       🔧 Manutenção: R$ 380,00
       ...
       Comum: 14,10 km/L · Aditivada: 13,90 km/L
```

*(valores de exemplo)*

## O que ele faz

- **Lê o print do Shell Box** com o Gemini: data, litros, valor, cashback e se foi gasolina comum ou aditivada (V-Power).
- **Grava o custo real**: o valor que saiu do bolso menos o cashback. Créditos Shell Box contam como dinheiro, porque você já pagou por eles.
- **Calcula o consumo** de cada abastecimento: (km atual − km anterior) ÷ litros. E reclama se o número sair absurdo.
- **Anota o resto**: manutenção, impostos e seguro, por comando de texto.
- **Resume o ano** na própria planilha e no `/resumo`, separando comum de aditivada, pra você descobrir se a aditivada compensa mesmo.
- **Uma planilha pra sempre**: todos os anos na mesma aba, com o resumo em colunas por ano.

## Como funciona

```
iPhone ──print + km──▶ Telegram ──webhook──▶ Google Apps Script
                                            ├─▶ Gemini Flash (lê o print)
                                            └─▶ Planilha Google (Lançamentos + Resumo)
```

Não tem servidor. O código roda no Apps Script, vinculado à planilha, de graça e sempre no ar. O Gemini Flash tem cota gratuita mais do que suficiente para alguns abastecimentos por mês.

## Comandos

| Mensagem | O que faz |
|---|---|
| 📷 print + legenda `48250` | Abastecimento lido do print |
| 📷 print sem legenda | O bot pergunta o km, e você responde só o número |
| `72,40 11,20 48250 a` | Abastecimento digitado: valor, litros, km, tipo (`c` comum, `a` aditivada) |
| `/manut 380 troca de óleo` | Manutenção |
| `/imposto 1200 IPVA` | Imposto (IPVA, licenciamento, multa...) |
| `/seguro 3000` | Seguro |
| `... 26/12` ou `... 26/12/2025` no fim | Data diferente de hoje (nos três comandos acima) |
| `/resumo` | Gastos do ano, km rodado, consumo médio, último abastecimento |
| `/desfazer` | Apaga o último lançamento |
| `/start` | Ajuda |

Números aceitam vírgula ou ponto. O km aceita `48250`, `48.250` ou `48250 km`.

## A planilha

**Lançamentos**: uma linha por despesa.

| Data | Categoria | Valor | Litros | Km | Tipo | R$/L | Km/L | Cashback | Descrição |
|---|---|---|---|---|---|---|---|---|---|
| 04/11/2026 | Combustível | 70,00 | 10,50 | 48250 | A | 6,67 | 12,57 | | Posto Exemplo |
| 05/11/2026 | Manutenção | 380,00 | | | | | | | troca de óleo |

**Resumo**: só fórmulas, uma coluna por ano (2026–2030): gasto total e por categoria, km rodado, litros, km/L médio, R$/L médio, comum vs. aditivada e cashback acumulado.

O km/L médio é ponderado (km total ÷ litros total), não a média simples das linhas, que distorce quando aparece um abastecimento esquisito.

## Instalação

Leva uns 15 minutos. Você vai precisar de uma conta Google, do Telegram e do [Node.js](https://nodejs.org).

### 1. Crie o bot no Telegram

Fale com o [@BotFather](https://t.me/BotFather), mande `/newbot` e escolha nome e username. Guarde o **token**.

### 2. Pegue uma chave do Gemini

Em [aistudio.google.com/apikey](https://aistudio.google.com/apikey), clique em *Create API key*. Guarde a **chave**.

### 3. Crie a planilha e o script

```bash
git clone https://github.com/<seu-usuario>/frentista-bot.git
cd frentista-bot
npm i -g @google/clasp
clasp login
clasp create --type sheets --title "Despesas Carro" --rootDir .
clasp push
```

O `clasp create` cria a planilha no seu Drive com o script vinculado e grava o `.clasp.json` (que está no `.gitignore`).

> Se o `clasp push` reclamar da API, ative a **Google Apps Script API** em [script.google.com/home/usersettings](https://script.google.com/home/usersettings).

### 4. Configure os segredos

Rode `clasp open-script` e vá em **Configurações do projeto → Propriedades do script**:

| Propriedade | Valor |
|---|---|
| `TELEGRAM_TOKEN` | token do BotFather |
| `GEMINI_API_KEY` | chave do AI Studio |
| `WEBHOOK_SECRET` | uma senha aleatória qualquer (ex.: saída de `openssl rand -hex 16`) |
| `CHAT_ID` | deixe vazio por enquanto |
| `WEBAPP_URL` | preenchido no passo 6 |

Nenhum segredo fica no código nem no git.

### 5. Monte a planilha

No editor, escolha a função `configurarPlanilha` e clique em **Executar**. Na primeira vez o Google pede autorização: aceite, porque é o seu próprio script. Isso cria as abas `Lançamentos` e `Resumo`.

### 6. Publique e ligue o webhook

```bash
clasp deploy -d "v1"
```

Copie a URL que termina em `/exec` (ou pegue em **Implantar → Gerenciar implantações**) e coloque em `WEBAPP_URL`. Depois, no editor, execute `configurarWebhook`. O log deve mostrar `"ok":true`.

### 7. Diga ao bot quem é o dono

Mande qualquer mensagem pro seu bot. Como `CHAT_ID` ainda está vazio, ele responde com o seu chat_id. Cole o número em `CHAT_ID`. A partir daí ele só responde a você.

Pronto: mande um print.

### Atualizando o código

```bash
clasp push
clasp deployments            # pega o deploymentId
clasp redeploy <deploymentId> -d "v2"
```

> O `/exec` sempre roda a versão publicada no deploy. Um `clasp push` sozinho não muda o bot no ar.

Use o `redeploy`. Um `deploy` novo gera outra URL, e aí você teria que reconfigurar o webhook.

## Importando uma planilha antiga (opcional)

O `exportar-xlsx.ps1` lê uma planilha Excel no layout *Registro de Combustível | Manutenções | Impostos/Seguro* e gera um `migracao.local.js` (ignorado pelo git). No Windows:

```powershell
.\exportar-xlsx.ps1 -Caminho "C:\caminho\Despesas carro 2026.xlsx"
clasp push
```

No editor, execute `migrar`. Depois apague o `migracao.local.js` e rode `clasp push` de novo. A função se recusa a rodar se a aba já tiver lançamentos.

Se o seu layout for outro, ajuste os números das colunas no começo do loop do script.

## Testes

A lógica (interpretar mensagens, calcular, validar) fica em `logica.js`, sem dependência das APIs do Google:

```bash
node test.js   # → ok
```

## Estrutura

```
Code.js            webhook, Telegram, Gemini, planilha
logica.js          funções puras (rodam no Node e no Apps Script)
test.js            testes da lógica
exportar-xlsx.ps1  migração de planilha antiga
appsscript.json    manifesto do Apps Script
```

## Privacidade

- A planilha fica no **seu** Drive, e o script roda na **sua** conta Google.
- Os prints passam pelo Telegram e pela API do Gemini pra serem lidos. Na cota gratuita, o Google pode usar o conteúdo enviado pra melhorar os modelos. É um comprovante de posto, mas vale saber.
- O bot ignora qualquer chat que não seja o `CHAT_ID`, e o webhook exige o `WEBHOOK_SECRET` na URL.

## Limitações

- Só entende comprovantes do **Shell Box**. Outros apps provavelmente funcionam, porque o Gemini é esperto, mas não foram testados.
- O Gemini pode ler errado. Confira a resposta e use `/desfazer` quando precisar.
- Feito para um carro só.
- O Apps Script responde ao Telegram com um redirect, e o Telegram às vezes reenvia a mensagem. O bot guarda o último `update_id` e ignora repetidas.

## Licença

[MIT](LICENSE)
