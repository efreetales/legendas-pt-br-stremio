const cache = require('../cache');
const { transcribeFile } = require('./transcribe');
const { translateSegments } = require('./translate');
const { segmentsToSrt } = require('./srt');
const { srtToSegments } = require('./srtParser');
const {
  searchRaw,
  searchAnyLanguageSubtitle,
  downloadSubtitleText,
} = require('../sources/opensubtitles');
const subdl = require('../sources/subdl');
const osv3 = require('../sources/osv3');

// Ordem de preferência dos idiomas a tentar traduzir quando não há PT-BR.
// Inglês costuma ter a maior cobertura e melhor qualidade de tradução.
// Na OpenSubtitles o espanhol tem 3 códigos: 'es' (genérico), 'ea' (América
// Latina) e 'sp' (Espanha) — os três entram na busca.
const FALLBACK_LANGUAGES = ['en', 'es', 'ea', 'sp'];
const SUBDL_FALLBACK_LANGUAGES = ['EN', 'ES'];

// Idiomas aceitos quando a legenda foi feita para o arquivo exato (hash):
// nesse caso a sincronia vale mais que o idioma, então francês e italiano
// também entram. Códigos da OpenSubtitles.com e do OpenSubtitles v3.
const HASH_LANGUAGES_OS = ['en', 'es', 'ea', 'sp', 'fr', 'it'];
const HASH_LANGUAGES_V3 = ['eng', 'spa', 'spl', 'spn', 'fre', 'fra', 'ita'];

// Primeiro resultado da OpenSubtitles num dos idiomas, respeitando a ordem
function pickOsByLanguage(results, languages) {
  for (const lang of languages) {
    const found = results.find(
      (r) => r.attributes?.language === lang && r.attributes?.files?.[0]?.file_id
    );
    if (found) return { fileId: found.attributes.files[0].file_id, lang };
  }
  return null;
}

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
/**
 * Procura uma legenda em outro idioma para traduzir. Ordem:
 * 1. feita para o arquivo exato (hash) em inglês, espanhol, francês ou italiano
 *    — tende a vir sincronizada, então vale mais que o idioma
 * 2. inglês/espanhol na OpenSubtitles
 * 3. inglês/espanhol na SubDL
 * 4. OpenSubtitles v3 (qualquer idioma menos português)
 * 5. OpenSubtitles em qualquer idioma
 * Devolve o texto do .srt ou null.
 */
async function findForeignSubtitleText({ type, id, extra = {} }) {
  const [osResults, v3Results] = await Promise.all([
    searchRaw({ type, id, extra }, HASH_LANGUAGES_OS),
    osv3.search({ type, id, extra }),
  ]);

  // 1. Feita para o arquivo exato
  const osHash = pickOsByLanguage(
    osResults.filter((r) => r.attributes?.moviehash_match),
    HASH_LANGUAGES_OS
  );
  if (osHash) {
    console.log(`[gerar] Estágio 2: legenda em "${osHash.lang}" feita para este arquivo exato (OpenSubtitles), baixando...`);
    return downloadSubtitleText(osHash.fileId);
  }
  const v3Hash = osv3.pickHashMatch(v3Results, HASH_LANGUAGES_V3);
  if (v3Hash) {
    console.log(`[gerar] Estágio 2: legenda em "${v3Hash.lang}" feita para este arquivo exato (OpenSubtitles v3), baixando...`);
    return osv3.downloadText(v3Hash.url);
  }

  // 2. Inglês/espanhol na OpenSubtitles (já ordenados por nome parecido com o arquivo)
  const fromOs = pickOsByLanguage(osResults, FALLBACK_LANGUAGES);
  if (fromOs) {
    console.log(`[gerar] Estágio 2: achou legenda em "${fromOs.lang}" na OpenSubtitles, baixando...`);
    return downloadSubtitleText(fromOs.fileId);
  }

  const [, season, episode] = id.split(':');
  const fromSubdl = await subdl.search({ type, id, extra }, SUBDL_FALLBACK_LANGUAGES);
  // Respeita a ordem de preferência de idioma (inglês antes de espanhol)
  // Se um zip não tiver o episódio certo, tenta o próximo em vez de desistir
  for (const code of SUBDL_FALLBACK_LANGUAGES) {
    for (const candidate of fromSubdl.filter((r) => r.langCode === code).slice(0, 3)) {
      console.log(`[gerar] Estágio 2: achou legenda em "${code}" na SubDL ("${candidate.release}"), baixando...`);
      try {
        return await subdl.downloadSrtText(candidate.url, { season, episode });
      } catch (err) {
        console.log(`[gerar] Estágio 2: essa não serviu (${err.message}), tentando a próxima...`);
      }
    }
  }

  // OpenSubtitles v3 (addon oficial do Stremio): às vezes tem legendas que a
  // API da OpenSubtitles.com não devolve. Prefere inglês/espanhol, mas aceita
  // qualquer idioma que não seja português.
  const fromV3 = osv3.pickForTranslation(v3Results);
  if (fromV3) {
    console.log(`[gerar] Estágio 2: achou legenda em "${fromV3.lang}" no OpenSubtitles v3, baixando...`);
    return osv3.downloadText(fromV3.url);
  }

  // Último recurso: qualquer idioma (francês, italiano, árabe...) — o
  // Google Translate detecta o idioma de origem automaticamente.
  const anyLang = await searchAnyLanguageSubtitle({ type, id, extra });
  if (anyLang) {
    console.log(`[gerar] Estágio 2: sem inglês/espanhol, usando legenda em "${anyLang.lang}" da OpenSubtitles...`);
    return downloadSubtitleText(anyLang.fileId);
  }

  return null;
}

async function tryTranslateForeignSubtitle({ type, id, extra }) {
  console.log(`[gerar] Estágio 2: procurando legenda em inglês/espanhol para "${id}"...`);
  const srtContent = await findForeignSubtitleText({ type, id, extra });
  if (!srtContent) {
    console.log('[gerar] Estágio 2: nenhuma legenda em outro idioma encontrada (OpenSubtitles, SubDL nem OpenSubtitles v3).');
    return null;
  }

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
// Quanto tempo a primeira resposta ao Stremio espera a tradução terminar.
// O Stremio só pergunta pelas legendas de novo quando o episódio é reaberto,
// então vale esperar um pouco: com o Google Translate, um episódio comum
// fica pronto em poucos segundos e a legenda já aparece na primeira vez.
const WAIT_FOR_GENERATION_MS = Number(process.env.WAIT_FOR_GENERATION_MS || 15000);

// Gerações em andamento neste servidor, para pedidos repetidos esperarem a
// mesma tradução em vez de começar outra
const inFlight = new Map();

function generatedSubtitle(key) {
  return {
    id: `gen-${key}`,
    lang: 'por',
    url: `${process.env.PUBLIC_URL || ''}/generated/${encodeURIComponent(key)}.srt`,
  };
}

async function getOrGenerate({ type, id, extra }) {
  const key = id;
  if (cache.getCachedSrtPath(key)) {
    console.log(`[gerar] Já existe legenda pronta em cache para "${key}".`);
    return generatedSubtitle(key);
  }

  let job = inFlight.get(key);
  if (!job) {
    const status = cache.getStatus(key);
    console.log(`[gerar] Status atual para "${key}": ${status}`);
    if (status === 'processing') return null; // só por segurança; não deveria acontecer
    console.log(`[gerar] Disparando geração para "${key}"...`);
    job = runGeneration(key, { type, id, extra })
      .catch((err) => console.error(`[gerar] ERRO inesperado na geração de "${key}":`, err.message))
      .finally(() => inFlight.delete(key));
    inFlight.set(key, job);
  }

  // Espera um pouco pela tradução antes de responder ao Stremio
  let timer;
  await Promise.race([job, new Promise((resolve) => { timer = setTimeout(resolve, WAIT_FOR_GENERATION_MS); })]);
  clearTimeout(timer);

  if (cache.getCachedSrtPath(key)) {
    console.log(`[gerar] Legenda ficou pronta a tempo de responder ao Stremio.`);
    return generatedSubtitle(key);
  }
  console.log(`[gerar] Ainda processando após ${WAIT_FOR_GENERATION_MS / 1000}s; continua em segundo plano.`);
  return null;
}

module.exports = { getOrGenerate };
