const axios = require('axios');
const { decodeSubtitleBuffer } = require('./match');

/**
 * OpenSubtitles v3 — o addon de legendas oficial do Stremio. Ele é público
 * e às vezes tem legendas que a API da OpenSubtitles.com não devolve (usa
 * outra base de dados). Usamos como fonte de legendas em outros idiomas
 * para traduzir. Não precisa de chave.
 *
 * Os idiomas vêm em código de 3 letras: eng, spa, spl (espanhol latino),
 * pob (português BR), por (português PT), fre, ita...
 */

const BASE = 'https://opensubtitles-v3.strem.io';

// Ordem de preferência para traduzir; depois disso, qualquer outro idioma
const PREFERRED = ['eng', 'spa', 'spl', 'spn'];
const SKIP = new Set(['pob', 'por', 'pt', 'pt-br', 'ptb']);

async function search({ type, id, extra = {} }) {
  // O Stremio passa hash/tamanho/nome do arquivo como parte da URL
  const qs = new URLSearchParams();
  if (extra.videoHash) qs.set('videoHash', extra.videoHash);
  if (extra.videoSize) qs.set('videoSize', extra.videoSize);
  if (extra.filename) qs.set('filename', extra.filename);
  const extraPart = qs.toString() ? `/${qs.toString()}` : '';
  // IDs do Stremio têm só letras, números e ":" (ex: tt0437741:22:1) — vão na URL como estão
  if (!/^tt\d+(:\d+:\d+)?$/.test(id) || !['movie', 'series'].includes(type)) return [];
  const url = `${BASE}/subtitles/${type}/${id}${extraPart}.json`;

  try {
    const res = await axios.get(url, { timeout: 20000 });
    const subs = (res.data?.subtitles || []).filter((s) => s.url && s.lang);
    console.log(
      `[osv3] OpenSubtitles v3 encontrou ${subs.length} legenda(s)` +
        (subs.length ? ` (idiomas: ${[...new Set(subs.map((s) => s.lang))].join(', ')})` : '')
    );
    return subs;
  } catch (err) {
    console.error(`[osv3] Falha ao consultar OpenSubtitles v3: ${err.message}`);
    return [];
  }
}

/**
 * Escolhe a melhor legenda para traduzir: inglês/espanhol primeiro,
 * depois qualquer idioma que não seja português.
 */
function pickForTranslation(subs) {
  for (const lang of PREFERRED) {
    const found = subs.find((s) => s.lang === lang);
    if (found) return found;
  }
  return subs.find((s) => !SKIP.has(String(s.lang).toLowerCase())) || null;
}

async function downloadText(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !/(^|\.)strem\.io$/.test(parsed.hostname)) {
    throw new Error(`Link de legenda inesperado: ${parsed.hostname}`);
  }
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return decodeSubtitleBuffer(Buffer.from(res.data));
}

/**
 * Entre as legendas nos idiomas indicados, devolve uma marcada como feita
 * para o arquivo exato (hash). O OpenSubtitles v3 não documenta esse campo;
 * nas respostas observadas, "m" vale "i" quando a legenda foi associada só
 * pelo título — tratamos "h" como associação pelo hash do arquivo.
 */
function pickHashMatch(subs, languages) {
  for (const lang of languages) {
    const found = subs.find((s) => s.lang === lang && s.m === 'h');
    if (found) return found;
  }
  return null;
}

module.exports = { search, pickForTranslation, pickHashMatch, downloadText };
