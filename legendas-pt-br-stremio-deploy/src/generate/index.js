const cache = require('../cache');
const { transcribeFile } = require('./transcribe');
const { translateSegments } = require('./translate');
const { segmentsToSrt } = require('./srt');
const { srtToSegments } = require('./srtParser');
const { searchBestForeignSubtitle, downloadSubtitleText } = require('../sources/opensubtitles');

// Ordem de preferência dos idiomas a tentar traduzir quando não há PT-BR.
// Inglês costuma ter a maior cobertura e melhor qualidade de tradução.
const FALLBACK_LANGUAGES = ['en', 'es'];

/**
 * >>> ÚNICO PONTO QUE VOCÊ PRECISA CONFIGURAR <<<
 *
 * O Stremio não envia a URL do vídeo para addons de legenda (só o id do
 * IMDB + temporada/episódio). Por isso, para gerar legenda, este addon
 * precisa de alguma forma de conseguir um arquivo de áudio/vídeo a partir
 * de uma fonte que VOCÊ já tenha acesso legal — por exemplo:
 *
 *   - um servidor de mídia próprio (Jellyfin/Plex/arquivo local) onde você
 *     já guarda os arquivos que baixou/comprou;
 *   - um link direto HTTP de um serviço de debrid/streaming que você assina
 *     e que hospeda conteúdo que você tem direito de acessar.
 *
 * Implemente a função abaixo devolvendo o CAMINHO LOCAL de um arquivo
 * (baixe-o para /tmp se vier de uma URL) e o resto do pipeline
 * (transcrição, tradução, .srt) já funciona sozinho.
 */
async function resolveMediaSource({ type, id, extra }) {
  throw new Error(
    'resolveMediaSource não configurado — implemente sua fonte de áudio/vídeo em src/generate/index.js'
  );
}

/**
 * Estágio 2: tenta achar uma legenda pronta em outro idioma (inglês,
 * espanhol...) e traduzir o texto para PT-BR. Muito mais rápido e barato
 * que transcrever áudio, e não precisa de acesso ao vídeo.
 * Devolve o conteúdo .srt traduzido, ou null se não achar nada.
 */
async function tryTranslateForeignSubtitle({ type, id }) {
  console.log(`[gerar] Estágio 2: procurando legenda em inglês/espanhol para "${id}"...`);
  const found = await searchBestForeignSubtitle({ type, id }, FALLBACK_LANGUAGES);
  if (!found) {
    console.log('[gerar] Estágio 2: nenhuma legenda em outro idioma encontrada.');
    return null;
  }

  console.log(`[gerar] Estágio 2: achou legenda em "${found.lang}", baixando e traduzindo...`);
  const srtContent = await downloadSubtitleText(found.fileId);
  const segments = srtToSegments(srtContent);
  if (segments.length === 0) {
    console.log('[gerar] Estágio 2: a legenda baixada veio vazia/ilegível.');
    return null;
  }

  const translated = await translateSegments(segments);
  console.log('[gerar] Estágio 2: tradução concluída.');
  return segmentsToSrt(translated);
}

async function runGeneration(key, sourceParams) {
  cache.setStatus(key, 'processing');
  try {
    // Estágio 2: traduzir legenda existente em outro idioma (rápido, sem vídeo)
    const translatedSrt = await tryTranslateForeignSubtitle(sourceParams);
    if (translatedSrt) {
      cache.saveSrt(key, translatedSrt);
      cache.setStatus(key, 'done');
      console.log(`[gerar] Pronto! Legenda salva para "${key}".`);
      return;
    }

    // Estágio 3: nenhuma legenda em idioma nenhum — transcreve o áudio
    console.log('[gerar] Estágio 3: nenhuma legenda existe em idioma nenhum, tentando transcrever o áudio...');
    const mediaPath = await resolveMediaSource(sourceParams);
    const segments = await transcribeFile(mediaPath);
    const translated = await translateSegments(segments);
    const srt = segmentsToSrt(translated);
    cache.saveSrt(key, srt);
    cache.setStatus(key, 'done');
    console.log(`[gerar] Pronto! Legenda transcrita e salva para "${key}".`);
  } catch (err) {
    console.error(`[gerar] ERRO ao gerar legenda para "${key}":`, err.message);
    cache.setStatus(key, 'error', { message: err.message });
  }
}

/**
 * Chamado pelo handler de legendas quando a busca não encontrou nada em PT-BR.
 * Se já tiver legenda gerada em cache, devolve na hora. Senão, dispara a
 * geração em segundo plano (sem travar a resposta ao Stremio) e devolve
 * null — como o Stremio costuma reconsultar as legendas, na próxima vez
 * (ou no próximo episódio) ela já pode estar pronta.
 */
async function getOrGenerate({ type, id, extra }) {
  const key = id;
  const existing = cache.getCachedSrtPath(key);
  if (existing) {
    console.log(`[gerar] Já existe legenda pronta em cache para "${key}".`);
    return {
      id: `gen-${key}`,
      lang: 'por',
      url: `${process.env.PUBLIC_URL || ''}/generated/${encodeURIComponent(key)}.srt`,
    };
  }

  const status = cache.getStatus(key);
  console.log(`[gerar] Status atual para "${key}": ${status}`);
  if (status === 'idle' || status === 'error') {
    console.log(`[gerar] Disparando geração em segundo plano para "${key}"...`);
    runGeneration(key, { type, id, extra }).catch((err) => {
      console.error(`[gerar] ERRO inesperado ao iniciar geração para "${key}":`, err.message);
    });
  }

  return null;
}

module.exports = { getOrGenerate };
