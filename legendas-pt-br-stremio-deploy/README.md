# Legendas PT-BR — Addon Stremio (Busca + Geração por IA)

Addon de legendas para o Stremio que:
1. Busca legendas em português do Brasil já existentes na OpenSubtitles.
2. Se não encontrar nenhuma, tenta gerar automaticamente (transcrição + tradução por IA).

## Como funciona (importante ler)

Quando não acha PT-BR pronta, o addon tenta em 3 estágios, na ordem:

1. **Busca PT-BR** na OpenSubtitles.
2. **Traduz legenda existente** em outro idioma (inglês, depois espanhol) —
   rápido, barato, e não precisa de acesso ao vídeo, só ao texto da legenda.
   Cobre a grande maioria dos casos.
3. **Transcreve o áudio do zero** com o Whisper (hospedado na Groq, rápido e com
   timestamps precisos — é um modelo dedicado de reconhecimento de fala, não uma
   estimativa de um LLM generalista), só quando não existe legenda em idioma
   nenhum. Esse estágio é o único que precisa de acesso ao vídeo.

O Stremio, por protocolo, **não envia a URL do vídeo** para addons de legenda
— só o ID do IMDB (e temporada/episódio, se for série). Isso não afeta os
estágios 1 e 2, mas significa que o estágio 3 precisa que você aponte para
uma fonte de áudio/vídeo à qual você já tem acesso (arquivo local, servidor
de mídia próprio, link direto de um serviço que você assina, etc).

Por isso, o único arquivo que você precisa editar para habilitar o estágio 3
é `src/generate/index.js`, na função `resolveMediaSource`. Tudo o resto
(busca, tradução, transcrição, geração do .srt, cache) já funciona pronto.

Se você não configurar essa função, o addon continua funcionando normalmente
nos estágios 1 e 2 — só não gera nada do zero quando nenhuma legenda existe
em nenhum idioma (caso raro).

## 1. Pré-requisitos

- Node.js 20+
- [ffmpeg](https://ffmpeg.org/) instalado no servidor (usado para extrair o áudio)
- Conta na [OpenSubtitles](https://www.opensubtitles.com/pt/consumers) (API Key gratuita)
- Conta na [Groq](https://console.groq.com/keys) (API Key gratuita, sem cartão de crédito) —
  usada tanto para traduzir quanto para transcrever áudio (com o Whisper de verdade,
  hospedado na Groq com inferência bem mais rápida que o normal)

## 2. Instalação local

```bash
npm install
cp .env.example .env
# edite o .env com suas chaves
npm start
```

O addon vai subir em `http://localhost:7000/manifest.json`. Para testar
rapidamente no computador, cole essa URL no Stremio (ícone de quebra-cabeça
→ colar link do addon).

## 3. Colocando no ar para TV Samsung e celular

Como a TV e o celular (fora de casa) precisam acessar o addon por uma URL
pública, rode em algum destes:

- **Render** ou **Railway** (planos gratuitos/baratos, deploy direto do GitHub)
- Um VPS pequeno (ex: Contabo, DigitalOcean) com Docker
- Um Raspberry Pi / computador de casa + túnel (ex: Cloudflare Tunnel), se
  preferir manter os arquivos de mídia localmente

Depois do deploy:
1. Defina a variável de ambiente `PUBLIC_URL` com a URL pública (ex:
   `https://seu-addon.onrender.com`) — ela é usada para montar os links de
   download das legendas.
2. Instale no Stremio colando `https://seu-addon.onrender.com/manifest.json`.

> Nota: hospedar em nuvem gratuita costuma ter CPU limitada — a transcrição
> de filmes inteiros pode ser lenta. Para uso pesado, um VPS pago compensa.

## 4. Estrutura do projeto

```
index.js                     servidor (rotas + handler de legendas)
src/sources/opensubtitles.js busca, download e listagem por idioma na OpenSubtitles
src/generate/srtParser.js    lê um .srt existente e devolve segmentos com timestamps
src/generate/transcribe.js   extrai áudio (ffmpeg) e transcreve com Whisper (Groq) — estágio 3
src/generate/translate.js    traduz os trechos para PT-BR com um modelo da Groq
src/generate/srt.js          monta o arquivo .srt final
src/generate/index.js        orquestra os 3 estágios + PONTO DE EXTENSÃO da fonte de mídia
src/cache.js                 cache em disco (evita gerar a mesma legenda 2x)
cache/                       onde os .srt gerados ficam salvos
```

## 5. Limitações conhecidas

- Geração é assíncrona: na primeira tentativa o Stremio pode não mostrar
  nada; espere alguns instantes (a Groq costuma ser rápida) e abra o menu
  de legendas de novo — ela deve aparecer.
- A Groq tem limites de uso na camada gratuita (pedidos por minuto/dia) —
  se aparecer erro de limite excedido, o addon tenta de novo sozinho na
  próxima consulta; se for muito frequente, vale considerar o plano pago.
- A qualidade da tradução depende do modelo escolhido em
  `GROQ_TRANSLATE_MODEL`; o padrão (`llama-3.3-70b-versatile`) é um bom
  equilíbrio custo/qualidade/velocidade. Modelos disponíveis podem mudar
  com o tempo — confira em [console.groq.com/docs/models](https://console.groq.com/docs/models).
