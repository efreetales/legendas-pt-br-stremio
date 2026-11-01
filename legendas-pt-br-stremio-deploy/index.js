require('dotenv').config();
const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

const { searchOpenSubtitles, resolveDownloadUrl } = require('./src/sources/opensubtitles');
const subdl = require('./src/sources/subdl');
const { getOrGenerate } = require('./src/generate');
const cache = require('./src/cache');

const PORT = process.env.PORT || 7000;

const manifest = {
  id: 'community.legendasptbr',
  version: '1.1.0',
  name: 'Legendas PT-BR (Busca + IA)',
  description:
    'Busca legendas em português do Brasil (OpenSubtitles e SubDL) e traduz automaticamente de outro idioma quando não encontradas',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  catalogs: [],
  idPrefixes: ['tt'],
};

const builder = new addonBuilder(manifest);

/**
 * Busca legendas PT-BR prontas na SubDL e transforma no formato do Stremio.
 * O link aponta para o NOSSO servidor, que baixa o .zip da SubDL e entrega
 * só o .srt (o Stremio não sabe abrir zip).
 */
async function searchSubdlPtBr({ type, id, extra }) {
  const [, season, episode] = id.split(':');
  const results = await subdl.search({ type, id, extra }, ['BR_PT']);
  return results.slice(0, 5).map((r, i) => {
    const qs = new URLSearchParams({ path: r.url });
    if (season) qs.set('s', season);
    if (episode) qs.set('e', episode);
    return {
      id: `subdl-${id}-${i}`,
      lang: 'por',
      url: `${process.env.PUBLIC_URL || ''}/subdl-download?${qs.toString()}`,
    };
  });
}

builder.defineSubtitlesHandler(async ({ type, id, extra = {} }) => {
  console.log(
    `\n[pedido] Stremio perguntou por legendas: type=${type} id=${id}` +
      (extra.videoHash ? ` hash=${extra.videoHash}` : '') +
      (extra.filename ? ` arquivo="${extra.filename}"` : '')
  );
  try {
    // Estágio 1: legendas PT-BR prontas, nas duas fontes ao mesmo tempo
    const [fromOs, fromSubdl] = await Promise.all([
      searchOpenSubtitles({ type, id, extra }),
      searchSubdlPtBr({ type, id, extra }).catch(() => []),
    ]);
    console.log(
      `[busca] Legendas PT-BR prontas: ${fromOs.length} na OpenSubtitles, ${fromSubdl.length} na SubDL`
    );
    const found = [...fromOs, ...fromSubdl];
    if (found.length > 0) {
      return { subtitles: found };
    }

    const generated = await getOrGenerate({ type, id, extra });
    console.log(`[resultado] ${generated ? 'Legenda traduzida/gerada pronta!' : 'Nada pronto ainda (pode estar processando em segundo plano)'}`);
    return { subtitles: generated ? [generated] : [] };
  } catch (err) {
    console.error('[ERRO] Falha no handler de legendas:', err.message);
    return { subtitles: [] };
  }
});

const app = express();

// Resgata o link real de download da OpenSubtitles (que expira rápido) e redireciona
app.get('/os-download/:fileId', async (req, res) => {
  try {
    const link = await resolveDownloadUrl(req.params.fileId);
    res.redirect(link);
  } catch (err) {
    console.error('Erro ao resolver download OpenSubtitles:', err.message);
    res.status(502).send('Erro ao buscar legenda na OpenSubtitles');
  }
});

// Baixa o .zip de uma legenda da SubDL e entrega só o .srt para o Stremio
app.get('/subdl-download', async (req, res) => {
  try {
    const text = await subdl.downloadSrtText(String(req.query.path || ''), {
      season: req.query.s,
      episode: req.query.e,
    });
    res.type('text/plain; charset=utf-8').send(text);
  } catch (err) {
    console.error('Erro ao baixar legenda da SubDL:', err.message);
    res.status(502).send('Erro ao buscar legenda na SubDL');
  }
});

// Serve as legendas geradas pela IA
app.get('/generated/:key.srt', (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const filePath = cache.getCachedSrtPath(key);
  if (!filePath) return res.status(404).send('Legenda ainda não gerada');
  res.type('text/plain; charset=utf-8').sendFile(filePath);
});

// Consulta simples de status (útil pra acompanhar pelo celular enquanto assiste na TV)
app.get('/status/:key', (req, res) => {
  const key = decodeURIComponent(req.params.key);
  res.json({ ...cache.getStatusInfo(key), legendaPronta: Boolean(cache.getCachedSrtPath(key)) });
});

app.use(getRouter(builder.getInterface()));

const resetCount = cache.resetStaleProcessing();
if (resetCount > 0) {
  console.log(`[cache] ${resetCount} legenda(s) "processing" de uma execução anterior foram resetadas para "idle".`);
}

app.listen(PORT, () => {
  console.log(`Addon rodando em http://localhost:${PORT}/manifest.json`);
  if (!process.env.PUBLIC_URL) {
    console.warn(
      '\n[AVISO] PUBLIC_URL não está configurado no .env — os links das legendas vão ficar quebrados ' +
        'e o Stremio vai descartá-las em silêncio. Para testes locais, use PUBLIC_URL=http://127.0.0.1:' +
        PORT +
        '. Depois do deploy, troque pela URL pública do serviço de hospedagem.\n'
    );
  } else {
    console.log(`Legendas serão servidas a partir de: ${process.env.PUBLIC_URL}`);
  }
});
