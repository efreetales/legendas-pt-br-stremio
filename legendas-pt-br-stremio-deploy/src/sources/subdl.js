const axios = require('axios');
const AdmZip = require('adm-zip');
const { similarity, decodeSubtitleBuffer, parseEpisode } = require('./match');

/**
 * SubDL (subdl.com) — segunda fonte de legendas, consultada quando a
 * OpenSubtitles não tem nada. Precisa de uma API key gratuita em
 * https://subdl.com/panel/api (variável SUBDL_API_KEY). Sem a chave, essa
 * fonte simplesmente fica desligada e o addon continua funcionando só com
 * a OpenSubtitles.
 *
 * As legendas da SubDL vêm dentro de arquivos .zip, então este módulo
 * também baixa o zip e extrai o .srt.
 */

const API_URL = 'https://api.subdl.com/api/v1/subtitles';
const DOWNLOAD_BASE = 'https://dl.subdl.com';

// Códigos de idioma da SubDL → como reconhecer cada idioma no campo "lang"
// da resposta (ex: "english", "Brazillian Portuguese").
const LANGS = {
  BR_PT: (lang) => /brazil/i.test(lang),
  EN: (lang) => /^english/i.test(lang),
  ES: (lang) => /^spanish/i.test(lang),
};

let warnedMissingKey = false;

function isEnabled() {
  if (process.env.SUBDL_API_KEY) return true;
  if (!warnedMissingKey) {
    console.log('[subdl] SUBDL_API_KEY não configurada — fonte SubDL desligada.');
    warnedMissingKey = true;
  }
  return false;
}

/**
 * Busca legendas na SubDL. `languages` são códigos da SubDL (BR_PT, EN, ES).
 * Devolve uma lista de { url, langCode, release } já ordenada pela mais
 * parecida com o arquivo que está tocando.
 */
async function search({ type, id, extra = {} }, languages) {
  if (!isEnabled()) return [];

  const [imdbId, season, episode] = id.split(':');
  const params = {
    api_key: process.env.SUBDL_API_KEY,
    imdb_id: imdbId,
    languages: languages.join(','),
    subs_per_page: 30,
  };
  if (type === 'series' && season && episode) {
    params.type = 'tv';
    params.season_number = season;
    params.episode_number = episode;
  } else {
    params.type = 'movie';
  }

  let res;
  try {
    res = await axios.get(API_URL, { params, timeout: 20000 });
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[subdl] Falha na busca (idiomas: ${languages.join(',')}): ${detail}`);
    return [];
  }

  if (!res.data?.status) {
    console.log(`[subdl] Busca (idiomas: ${languages.join(',')}) não encontrou nada.`);
    return [];
  }

  const results = [];
  for (const sub of res.data.subtitles || []) {
    if (!sub.url || !sub.url.startsWith('/subtitle/')) continue;
    // Em séries, a SubDL também devolve PACOTES (ex: "E01–E10", vários
    // episódios num zip só). O nome e o número de episódio do cadastro se
    // referem ao primeiro arquivo do pacote, então não dá para filtrar por
    // eles aqui: quem confere se o episódio pedido está mesmo lá dentro é
    // downloadSrtText, ao abrir o zip.
    const langCode = languages.find((code) => LANGS[code]?.(sub.lang || sub.language || ''));
    if (!langCode) continue;
    // A SubDL devolve o link com "?api_key=..." no final. Guardamos só o
    // caminho, para a chave nunca aparecer nos links enviados ao Stremio;
    // ela é recolocada no servidor, na hora do download.
    const cleanPath = sub.url.split('?')[0];
    results.push({ url: cleanPath, langCode, release: sub.release_name || sub.name || '' });
  }

  results.sort((a, b) => similarity(b.release, extra.filename) - similarity(a.release, extra.filename));
  console.log(`[subdl] Busca (idiomas: ${languages.join(',')}) encontrou ${results.length} resultado(s)`);
  return results;
}

/**
 * Baixa o .zip de uma legenda da SubDL e devolve o texto do .srt de dentro.
 * Se o zip tiver vários .srt (pacote de temporada), tenta achar o do
 * episódio certo pelo padrão S01E02 no nome.
 */
async function downloadSrtText(subdlPath, { season, episode } = {}) {
  // Aceita só caminhos simples tipo "/subtitle/123-456.zip" (sem "?", "..",
  // etc.) — links antigos que ainda tenham "?api_key=" no final são limpos.
  const cleanPath = String(subdlPath || '').split('?')[0];
  if (!/^\/subtitle\/[\w.-]+$/.test(cleanPath) || cleanPath.includes('..')) {
    throw new Error('Caminho de legenda SubDL inválido');
  }

  const res = await axios.get(`${DOWNLOAD_BASE}${cleanPath}`, {
    params: process.env.SUBDL_API_KEY ? { api_key: process.env.SUBDL_API_KEY } : undefined,
    responseType: 'arraybuffer',
    timeout: 30000,
  });

  const zip = new AdmZip(Buffer.from(res.data));
  const srtEntries = zip.getEntries().filter((e) => !e.isDirectory && /\.srt$/i.test(e.entryName));
  if (srtEntries.length === 0) throw new Error('Zip da SubDL sem arquivo .srt');

  let entry = srtEntries[0];
  if (season && episode) {
    // Procura dentro do zip o arquivo do episódio pedido (pelo "S22E03" no nome)
    const wanted = srtEntries.find((x) => {
      const ep = parseEpisode(x.entryName.split('/').pop());
      return ep && ep.season === Number(season) && ep.episode === Number(episode);
    });
    if (wanted) {
      entry = wanted;
    } else {
      const named = srtEntries.filter((x) => parseEpisode(x.entryName.split('/').pop()));
      // Arquivos com episódio no nome, mas nenhum é o pedido -> legenda de outro episódio
      // Vários arquivos sem episódio no nome -> não dá para saber qual é o certo
      if (named.length > 0 || srtEntries.length > 1) {
        throw new Error(`Zip da SubDL não contém o episódio S${season}E${episode}`);
      }
    }
  }

  return decodeSubtitleBuffer(entry.getData());
}

/**
 * Diagnóstico: roda a mesma busca de algumas formas diferentes e devolve um
 * resumo do que a SubDL respondeu em cada uma (sem a chave). Usado pela
 * rota /debug/subdl para entender por que uma legenda não foi encontrada.
 */
async function debugSearch(id, languages, fileName) {
  const [imdbId, season, episode] = id.split(':');
  const base = { api_key: process.env.SUBDL_API_KEY, imdb_id: imdbId, languages: languages.join(','), subs_per_page: 30 };
  const variants = season
    ? {
        episodio: { ...base, type: 'tv', season_number: season, episode_number: episode },
        temporada: { ...base, type: 'tv', season_number: season },
        temporada_completa: { ...base, type: 'tv', season_number: season, full_season: 1 },
        sem_temporada: { ...base, type: 'tv' },
        ...(fileName ? { nome_do_arquivo: { ...base, type: 'tv', file_name: fileName } } : {}),
        ...(fileName ? { nome_do_arquivo_sem_imdb: { api_key: base.api_key, languages: base.languages, subs_per_page: 30, file_name: fileName } } : {}),
      }
    : { filme: { ...base, type: 'movie' } };

  const out = { chaveConfigurada: Boolean(process.env.SUBDL_API_KEY) };
  for (const [name, params] of Object.entries(variants)) {
    try {
      const res = await axios.get(API_URL, { params, timeout: 20000 });
      out[name] = {
        status: res.data?.status,
        erro: res.data?.error,
        titulos: (res.data?.results || []).map((r) => `${r.name} (${r.imdb_id}, ${r.type}, sd_id ${r.sd_id})`),
        legendas: (res.data?.subtitles || []).map((s) => ({
          release: s.release_name,
          lang: s.lang,
          season: s.season,
          episode: s.episode,
          full_season: s.full_season,
          url: String(s.url || '').split('?')[0],
        })),
      };
    } catch (err) {
      out[name] = { falha: err.response?.status || err.message, resposta: err.response?.data };
    }
  }
  return out;
}

module.exports = { search, downloadSrtText, debugSearch };
