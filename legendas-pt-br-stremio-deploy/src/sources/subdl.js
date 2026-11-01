const axios = require('axios');
const AdmZip = require('adm-zip');
const { similarity, decodeSubtitleBuffer } = require('./match');

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
    // Em séries, a SubDL às vezes devolve pacotes da temporada inteira;
    // descarta legendas que dizem ser de outro episódio.
    if (type === 'series' && episode && sub.episode && Number(sub.episode) !== Number(episode)) continue;
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
  if (srtEntries.length > 1 && season && episode) {
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');
    const pattern = new RegExp(`s${s}e${e}|${Number(season)}x${e}`, 'i');
    entry = srtEntries.find((x) => pattern.test(x.entryName)) || entry;
  }

  return decodeSubtitleBuffer(entry.getData());
}

module.exports = { search, downloadSrtText };
