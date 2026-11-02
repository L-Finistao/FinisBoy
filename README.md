<div align="center">

<img src="logo.png" alt="TurboSlug" width="160">

# TurboSlug

**O app do motoboy: cole a lista de endereços do WhatsApp e receba a rota mais rápida, com controle de ganhos, gastos e km rodados.**

PWA · Sem login · Sem servidor próprio · Funciona offline

</div>

---

## Índice

- [O que ele faz](#-o-que-ele-faz)
- [Como usar](#-como-usar)
- [Instalar no celular](#-instalar-no-celular)
- [Modo 100% offline](#-modo-100-offline)
- [Formatos de texto aceitos](#-formatos-de-texto-aceitos)
- [Como funciona por dentro](#-como-funciona-por-dentro)
- [Estrutura do projeto](#-estrutura-do-projeto)
- [Limitações](#-limitações)

---

## 🏍️ O que ele faz

| Recurso | Descrição |
|---|---|
| **Importa do WhatsApp** | Cole a conversa inteira; o app separa os endereços, ignora data, nome, emoji e numeração. |
| **Monta a melhor rota** | Localiza cada endereço no mapa e calcula a ordem de entrega mais rápida. |
| **Acompanha a entrega** | Cronômetro por parada (verde, amarelo, vermelho) e km medidos pelo GPS. |
| **Segue você em tempo real** | Velocidade, quanto falta (km, minutos e hora de chegada), aviso de chegada e **recálculo automático** se você sair do caminho. |
| **Evita trechos lentos** | Aprende pelo GPS onde você anda devagar (buraco, lombada, semáforo, trânsito) e você marca problemas com **⚠**. As próximas rotas fogem desses trechos. |
| **Corrige endereço errado** | Acha o nome oficial da rua e o CEP certo mesmo com erro de digitação ou CEP errado. |
| **Controla o dinheiro** | Ganho por entrega, fixo ou misto, gastos do dia e custo por km da moto. |
| **Vários períodos de trabalho** | Cadastre cada período (ex.: Manhã e Noite) com o local e o modelo de pagamento próprio. Os dados são separados por período. |
| **Visão diária de ganho e gasto** | Dia a dia: ganho, gastos e líquido, com barras e a divisão por período. |
| **Guarda o histórico** | Rotas finalizadas com ganho, km e custo, filtradas por período. |
| **Mostra o trajeto no mapa** | Trajeto feito colorido pela velocidade, horário de cada entrega e comparação **parte a parte** para ver qual trecho foi mais lento. |
| **Funciona sem internet** | Baixe a cidade uma vez e use ruas, endereços e mapa offline. |

Todos os dados ficam **no próprio celular** (IndexedDB). Não há cadastro nem conta.

---

## 🚀 Como usar

```text
 ＋ Nova rota  →  ▶ Iniciar  →  ✓ Entregue (a cada parada)  →  ⏹ Finalizar rota
```

1. **＋ Nova rota**: cole o texto do WhatsApp. Cada colagem vira uma rota, com poucas ou muitas paradas.
2. O app localiza os endereços (veja [Localização dos endereços](#-localização-dos-endereços)) e define a ordem de menor tempo ([OSRM](https://project-osrm.org/)), mostrando quanto você economiza em relação à ordem colada. As rotas ficam na tela principal e ainda não começaram.
3. **▶ Iniciar**: o mapa vira a tela principal, o cronômetro começa e o GPS passa a medir os km rodados e a acompanhar sua posição.
4. **✓ Entregue** em cada parada. A rota é recalculada a partir de onde você está.
5. **⏹ Finalizar rota**: a rota vai para o histórico.

### Durante a rota

- Mostra **velocidade**, **quanto falta** (km, minutos e hora de chegada) e avisa quando você **chega** na parada.
- Se você **sai do caminho** por mais de ~8 segundos, a rota é **recalculada sozinha** a partir da sua posição.
- **⚠ Problema aqui** marca rua esburacada, semáforo, trânsito, depressão transversal/drenagem, lombada ou redutor de velocidade no ponto onde você está. Cada marcação vale para ~200 m da mesma via (aparece em vermelho no mapa com o pacote offline). Ordem para evitar: buraco (evitar ao máximo) > semáforo (~60 s) > trânsito > depressão, lombada e redutor. O app também aprende sozinho onde você anda devagar ou para. Esses trechos aparecem em vermelho no mapa e **custam mais** nas próximas rotas.
- Com internet, a rota vem do OSRM: o app pede até 3 alternativas para cada trecho entre paradas e escolhe a melhor pelo seu histórico (trechos lentos, problemas marcados, vias favoritas). O mapa salvo no aparelho (pacote offline) só entra quando a internet cai ou oscila (mais de 8 s sem resposta), e nesse caso aplica os mesmos custos. Dá para desligar ou apagar o aprendizado em ⚙.

### Períodos de trabalho (manhã, noite…)

Em **⚙ → Períodos de trabalho**, cadastre cada período em que você trabalha. Exemplo:

| Período | Local | Como é pago |
|---|---|---|
| Manhã | Padaria | Fixo R$ 100 por dia |
| Noite | Pizzaria | Fixo R$ 35 + R$ 5 por entrega |

- Cada **rota** pertence a um período. Ao criar a rota, o app escolhe pelo **horário** (se você preencheu "das… até…", inclusive virando a noite) ou usa o último período usado. Dá para trocar no cartão da rota ou depois, no histórico.
- O **fixo** vale uma vez por dia e por período trabalhado (houve entrega ou rota finalizada). Se houver mais de uma rota no mesmo período e dia, o fixo é dividido entre elas, proporcional às entregas.
- Os **gastos** podem ser ligados a um período (ou ficar como "Geral") ao serem apontados.
- Em **📜 Histórico**, o filtro **Período trabalhado** mostra só os dados de um período e, em "Todos", compara os períodos (por dia e por entrega).
- Em **📅 Dia**, veja o dia dividido por período e, mais abaixo, o **ganho e o gasto de cada dia** (7, 14 ou 30 dias) com barras; toque num dia para abri-lo.

### Histórico no mapa

Em **📜 Histórico** (ou 🗺 em **📅 Dia**), toque em **🗺 Ver trajeto e tempos no mapa** numa rota finalizada:

- O **trajeto feito** aparece colorido pela velocidade: vermelho (parado/lento, menos de 5 km/h), laranja (5–15), amarelo (15–30) e verde (mais de 30 km/h).
- Cada entrega vira um pino numerado com o **horário** e o tempo desde a entrega anterior.
- A lista **parte a parte** compara os trechos *saída → 1*, *1 → 2*, *2 → 3*… com distância, tempo, velocidade média, tempo rodando e tempo parado. O trecho mais lento ganha 🐢 e o mais rápido 🐇; a barra mostra os minutos por km. Toque numa parte para destacá-la no mapa.
- **🗺 Ver todas as entregas do período no mapa** mostra todos os pontos entregues e os trajetos de uma vez.

O trajeto é gravado pelo GPS durante a rota (a cada ~12 m ou 15 s) e fica só no celular. Rotas feitas antes dessa versão mostram apenas os pinos e os tempos.

### Telas

| Aba | Para que serve |
|---|---|
| 🏍️ **Rotas** | Mapa, rotas atuais, próxima parada, recalcular rota, baixar cidade offline. |
| 📅 **Dia** | Resumo do dia (entregas, km, ganho, gastos, líquido, ganho/km, custo/km) e lançamento de gastos. |
| 📜 **Histórico** | Rotas finalizadas por período: hoje, semana, mês ou tudo. |
| ⚙ **Configurações** | Meta de tempo, cidade padrão, modelo de ganho e custo da moto. |

### Configurações

- **Meta de tempo por entrega**: o cronômetro fica verde, amarelo (80% da meta) e vermelho (estourou). Use `0` para desligar.
- **Períodos de trabalho**: cadastre quantos precisar. Cada um tem nome, local, horário (opcional) e como é pago: *por entrega*, *fixo por dia* ou *fixo + por entrega*.
- **Custo por km da moto**: calculado a partir de gasolina (R$/L), consumo (km/L), troca de óleo (R$ e a cada quantos km) e outros custos por km, como pneus e corrente.
- **Cidade/UF padrão**: ajuda a achar endereços colados sem cidade.
- **Trechos lentos**: liga ou desliga o uso do que foi aprendido e das suas marcações, e apaga tudo se quiser recomeçar.

## 🔎 Localização dos endereços

Cada endereço passa por estas fontes, na ordem, até ser achado:

| # | Fonte | O que faz |
|---|---|---|
| 1 | Cache do aparelho | Endereço já localizado antes (e repetido na mesma lista) não é buscado de novo. |
| 2 | [ViaCEP](https://viacep.com.br/) | Corrige o nome da rua digitado errado (Luís/Luiz, Moreti/Moretti, Teixrita/Teixeira) e acha o CEP certo. Se a frase inteira não achar, tenta cada palavra do nome. Também confere o CEP informado. |
| 3 | [Nominatim](https://nominatim.org/) | Ponto exato da casa, quando o OpenStreetMap tem o número. |
| 4 | [Photon](https://photon.komoot.io/) | Busca aproximada para nomes parecidos. |
| 5 | CEP ([BrasilAPI](https://brasilapi.com.br/)) | Ponto aproximado da região, só se o CEP combinar com a rua. |
| 6 | Pacote offline | Quando não há internet. |

Se nada achar, a parada fica em **vermelho**: use **✎** para corrigir o texto ou **📍** para marcar o ponto no mapa. Paradas achadas só pela rua aparecem como `~ posição na rua`.

---

## 📲 Instalar no celular

GPS e instalação como app exigem **HTTPS** (ou `localhost`).

**Publicar na Vercel** (HTTPS automático; o `next.config.mjs` já configura service worker, manifesto e cabeçalhos)

*Pelo painel:*
1. Coloque os arquivos na raiz de um repositório do GitHub.
2. Em [vercel.com](https://vercel.com) → **Add New… → Project** → importe o repositório.
3. **Framework Preset: Next.js** (em Settings → Build & Development, desligue qualquer *Override* de Build Command e Output Directory) e clique em **Deploy**.

*Pela linha de comando:*

```bash
npm i -g vercel
vercel          # primeira vez: responda as perguntas (framework Next.js)
vercel --prod   # publica em produção
```

**No celular**
1. Abra o link da Vercel no Chrome, uma vez com internet.
2. Toque em **Adicionar à tela inicial** (ou em *📲 Instalar o app* nas configurações).
3. A cada nova versão publicada, abra o app duas vezes para atualizar.

**Testar no computador**

```bash
npm install
npm run dev      # http://localhost:3000
```

O projeto é Next.js (TypeScript): a API fica em `app/api/*/route.ts`, `lib/` guarda banco e sessão, e o app atual (HTML/JS puro) está em `public/` e abre em `/` enquanto as telas migram para React. Para o login funcionar localmente, ponha `DATABASE_URL` e `JWT_SECRET` no `.env.local`.

---

## 📦 Modo 100% offline

Com internet, **uma vez por cidade**:

1. Na aba **Rotas**, deixe a cidade inteira visível no mapa.
2. Toque em **📦 Baixar cidade (offline)**.

O app salva no aparelho:

| O que é salvo | Para que serve offline |
|---|---|
| 🛣️ **Ruas** | Calcula o caminho e a melhor ordem (Dijkstra nas ruas reais; ordem exata até 13 paradas). |
| 📍 **Endereços e bairros** | Localiza os endereços colados. Usa o número da casa quando existe; senão interpola entre vizinhos ou usa a rua (posição aproximada, marcada com `~`). |
| 🗺️ **Mapa** | Blocos até o zoom 17. |

**Ordem de prioridade na localização:** cache de endereços → internet (mais preciso) → pacote offline.
Com trechos lentos aprendidos ou marcados, a rota passa a ser calculada no próprio aparelho, mesmo com internet.
Quando a internet volta, os endereços aproximados são refinados ao tocar em **🧭 Recalcular rota**.

Para liberar espaço, use **Configurações → Apagar pacote offline**.

---

## 💬 Formatos de texto aceitos

O leitor entende os dois formatos de exportação do WhatsApp e também texto solto, com um endereço por linha:

```text
[29/10, 21:23] +55 18 99764-0397: Rua das Flores, 123 - Centro
29/10/2026 21:23 - João: Av. Brasil, 450 - Birigui - SP Sobrado
1) Rua XV de Novembro, 80, Bairro: Centro | CEP: 16200-000
```

Ele também reconhece:
- prefixos como `Endereço:`, `Entrega:`, `Destino:`;
- `Bairro:`, `CEP:` e `Referência:`;
- observações depois da UF (casa, fundos, apto), que viram nota da parada;
- abreviações (`R.`, `Av.`) e complementos (`apto 12`, `bloco B`), que são removidos para melhorar a busca.

---

## 🔧 Como funciona por dentro

```text
 Texto do WhatsApp
        │  parse.js  → separa mensagens e endereços
        ▼
  Localização:  cache → ViaCEP → Nominatim → Photon → CEP → pacote offline
        │
        ▼
  Rota:  OSRM (online)  ou  Dijkstra + Held-Karp no aparelho
         (o cálculo no aparelho aplica os trechos lentos aprendidos)
        │
        ▼
  app.js → mapa (Leaflet), cronômetro, GPS, ganhos, histórico
  live.js → posição em tempo real, recálculo automático, aprendizado de trechos lentos
```

- **Interface:** HTML + CSS + JavaScript puro, mapa com [Leaflet](https://leafletjs.com/).
- **Dados:** IndexedDB no aparelho.
- **PWA:** `sw.js` guarda a interface (abre sem internet e atualiza em segundo plano) e os blocos do mapa vistos (limite de 8.000).
- **Pacote offline:** ruas e endereços vêm do OpenStreetMap via Overpass API, montados em um grafo compacto (CSR).
- **Ordem de paradas offline:** exata (Held-Karp) até 13 paradas; acima disso, vizinho mais próximo com 2-opt e or-opt.

---

## 📁 Estrutura do projeto

```text
Projeto_Motoboy/
├── index.html      Telas e diálogos
├── style.css       Estilos
├── (os arquivos abaixo estão em public/)
├── app.js          Lógica principal: rotas, mapa, GPS, ganhos, histórico
├── parse.js        Leitura do texto do WhatsApp e localização dos endereços
├── offline.js      Pacote offline: download, busca de endereço e rota
├── live.js         Tempo real: recálculo automático e trechos lentos
├── earnings.js     Períodos de trabalho, ganhos, gastos e telas Dia/Histórico
├── history.js      Trajeto gravado e histórico no mapa (parte a parte)
├── next.config.mjs Cabeçalhos e rota inicial (Next.js)
├── app/api/        API em Next.js: login, register, logout, me, sync
├── lib/            Banco (Neon) e sessão (JWT)
├── sw.js           Service Worker (cache e uso offline)
├── manifest.json   Configuração do PWA
├── logo.png        Logo
├── icon-192.png    Ícones do app
├── icon-512.png
└── vendor/         Leaflet (biblioteca de mapas) e imagens
```

---

## ⚠️ Limitações

- **Online:** precisa de internet para localizar endereços e calcular a rota, a menos que a cidade tenha sido baixada. A interface e os dados salvos abrem sempre offline.
- **Servidores públicos gratuitos** (Nominatim limitado a 1 req/s, Photon, ViaCEP, OSRM demo, Overpass): bons para uso pessoal, não para volume alto. Uma lista grande leva cerca de 2 segundos por endereço.
- **Perfil de carro e sem trânsito ao vivo:** o OSRM público não tem perfil de moto nem dados de trânsito. Os trechos lentos vêm do seu próprio GPS.
- **Posição na rua:** quando o OpenStreetMap não tem o número da casa, o ponto fica na rua (marcado com `~`); use 📍 para ajustar.
- **Km rodados:** medidos por GPS. Se o GPS registrar menos de 200 m, usa o km planejado (marcado com `~` no histórico).
- **Offline:**
  - ruas sem cadastro no OpenStreetMap não são achadas (o app marca em vermelho para você corrigir);
  - o roteamento ignora restrições de conversão;
  - Google Maps e Waze dependem dos próprios apps.

---

<div align="center">

Dados de mapa © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors

</div>

## ☁️ Contas e banco de dados (Neon)

O app exige login. Cada usuário tem a própria conta e só enxerga os próprios dados; tudo continua sendo gravado no aparelho (funciona sem internet) e é sincronizado com o banco quando há conexão.

**Como ligar (uma vez):**
1. No [Neon](https://neon.tech), crie um projeto e rode [db/schema.sql](db/schema.sql) no *SQL Editor*.
2. Vincule o conector (`vercel connect create neon --name fiinsboy`, depois `vercel link` e `vercel env pull`): a conexão vem do Vercel Connect (`getTokenResponse('neon/fiinsboy')` em [lib/db.ts](lib/db.ts)), sem `DATABASE_URL`. Na Vercel (Settings → Environment Variables) crie `JWT_SECRET` (texto longo e aleatório) e, se quiser restringir quem cria conta, `SIGNUP_CODE`. Veja [.env.example](.env.example).
3. Faça o deploy. A Vercel instala as dependências de [package.json](package.json) e publica as rotas de `app/api/`.

**Como funciona:** `/api/register`, `/api/login`, `/api/logout` e `/api/me` cuidam do login (senha com bcrypt, sessão em cookie `HttpOnly` assinado, 30 dias). `api/sync` envia e baixa as mudanças só do usuário do cookie. Rotas, paradas, entregas, gastos, trajetos e configurações vão para a tabela `docs`. Se a mesma coisa mudar em dois aparelhos, vale a alteração mais recente. O pacote offline e o cache de endereços ficam só no aparelho. Ao trocar de conta no mesmo aparelho, os dados locais da conta anterior são apagados (já estão no servidor).
