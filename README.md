<div align="center">

<img src="logo.png" alt="FinisBoy" width="160">

# FinisBoy

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
| **Controla o dinheiro** | Ganho por entrega, fixo ou misto, gastos do dia e custo por km da moto. |
| **Guarda o histórico** | Rotas finalizadas com ganho, km e custo, filtradas por período. |
| **Funciona sem internet** | Baixe a cidade uma vez e use ruas, endereços e mapa offline. |

Todos os dados ficam **no próprio celular** (IndexedDB). Não há cadastro nem conta.

---

## 🚀 Como usar

```text
 ＋ Nova rota  →  ▶ Iniciar  →  ✓ Entregue (a cada parada)  →  ⏹ Finalizar rota
```

1. **＋ Nova rota**: cole o texto do WhatsApp. Cada colagem vira uma rota, com poucas ou muitas paradas.
2. O app localiza os endereços ([Nominatim/OpenStreetMap](https://nominatim.org/)) e define a ordem mais rápida ([OSRM](https://project-osrm.org/)). As rotas ficam na tela principal e ainda não começaram.
3. **▶ Iniciar**: o mapa vira a tela principal, o cronômetro começa e o GPS passa a medir os km rodados.
4. **✓ Entregue** em cada parada.
5. **⏹ Finalizar rota**: a rota vai para o histórico.

### Telas

| Aba | Para que serve |
|---|---|
| 🏍️ **Rotas** | Mapa, rotas atuais, próxima parada, recalcular rota, baixar cidade offline. |
| 📅 **Dia** | Resumo do dia (entregas, km, ganho, gastos, líquido, ganho/km, custo/km) e lançamento de gastos. |
| 📜 **Histórico** | Rotas finalizadas por período: hoje, semana, mês ou tudo. |
| ⚙ **Configurações** | Meta de tempo, cidade padrão, modelo de ganho e custo da moto. |

### Configurações

- **Meta de tempo por entrega**: o cronômetro fica verde, amarelo (80% da meta) e vermelho (estourou). Use `0` para desligar.
- **Como eu ganho**: *por entrega*, *fixo por dia* ou *fixo + por entrega*.
- **Custo por km da moto**: calculado a partir de gasolina (R$/L), consumo (km/L), troca de óleo (R$ e a cada quantos km) e outros custos por km, como pneus e corrente.
- **Cidade/UF padrão**: ajuda a achar endereços colados sem cidade.

---

## 📲 Instalar no celular

GPS e instalação como app exigem **HTTPS** (ou `localhost`).

**Opção mais simples (sem programar)**
1. Arraste esta pasta em [app.netlify.com/drop](https://app.netlify.com/drop).
2. Abra o link gerado no celular.
3. No menu do Chrome, toque em **Adicionar à tela inicial** (ou em *📲 Instalar o app* nas configurações).

**Testar no computador**

```bash
python -m http.server 8080
```

Depois abra <http://localhost:8080>.

> O projeto é só HTML, CSS e JavaScript. Não tem `npm install` nem etapa de build.

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
  Geocodificação:  cache → Nominatim (online) → pacote offline
        │
        ▼
  Rota:  OSRM (online)  ou  Dijkstra + Held-Karp (offline)
        │
        ▼
  app.js → mapa (Leaflet), cronômetro, GPS, ganhos, histórico
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
├── app.js          Lógica principal: rotas, mapa, GPS, ganhos, histórico
├── parse.js        Leitura do texto do WhatsApp e geocodificação
├── offline.js      Pacote offline: download, busca de endereço e rota
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
- **Servidores públicos gratuitos** (Nominatim limitado a 1 req/s e OSRM demo): bons para uso pessoal, não para volume alto.
- **Perfil de carro:** o OSRM público não tem perfil de moto.
- **Km rodados:** medidos por GPS. Se o GPS registrar menos de 200 m, usa o km planejado (marcado com `~` no histórico).
- **Offline:**
  - ruas sem cadastro no OpenStreetMap não são achadas (o app marca em vermelho para você corrigir);
  - o roteamento ignora restrições de conversão;
  - Google Maps e Waze dependem dos próprios apps.

---

<div align="center">

Dados de mapa © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors

</div>
