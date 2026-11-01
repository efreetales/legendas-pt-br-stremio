const axios = require('axios');
const { similarity, decodeSubtitleBuffer } = require('./match');

const API_BASE = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = process.env.APP_USER_AGENT || 'legendas-ptbr-addon v1.0';

let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Faz login na OpenSubtitles (necessário para poder baixar arquivos,
 * não só listar resultados). O token dura algumas horas, então
 * guardamos em memória e só refazemos login quando expira.
 */
async function login() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const { OPENSUBTITLES_API_KEY, OPENSUBTITLES_USERNAME, OPENSUBTITLES_PASSWORD } = process.env;

  if (!OPENSUBTITLES_USERNAME || !OPENSUBTITLES_PASSWORD) {
    // Sem login, ainda dá pra buscar (mas não baixar). Retorna null e
    // quem chamar decide o que fazer.
    return null;
  }

  const res = await axios.post(
    `${API_BASE}/login`,
    { username: OPENSUBTITLES_USERNAME, password: OPENSUBTITLES_PASSWORD },
    {
      headers: {
        'Api-Key': OPENSUBTITLES_API_KEY,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
    }
  );

  cachedToken = res.data.token;
  // Token dura horas; renovamos por segurança a cada 6h
  tokenExpiresAt = Date.now() + 6 * 60 * 60 * 1000;
  return cachedToken;
}

/**
 * Consulta bruta à OpenSubtitles para um título (filme ou episódio de série),
 * filtrando por uma lista de idiomas. `id` vem no formato do Stremio:
 * "tt1234567" (filme) ou "tt1234567:1:2" (série S01E02).
 *
 * `extra` é o que o Stremio manda junto: `videoHash` (impressão digital do
 * arquivo que está tocando), `videoSize` e `filename`. Com o hash, a
 * OpenSubtitles acha legendas feitas exatamente para aquela versão do
 * vídeo (que ficam sincronizadas) e põe essas na frente.
 */
async function rawSearch({ type, id, extra = {} }, languages) {
  const [imdbRaw, season, episode] = id.split(':');
  const imdbId = String(Number(imdbRaw.replace('tt', ''))); // sem zeros à esquerda, como a API recomenda

  // Lista de idiomas vazia = sem filtro (a API devolve legendas de todos os idiomas)
  const params = {};
  if (languages.length > 0) params.languages = languages.join(',');

  if (type === 'series' && season && episode) {
    params.parent_imdb_id = imdbId;
    params.season_number = season;
    params.episode_number = episode;
  } else {
    params.imdb_id = imdbId;
  }

  if (extra.videoHash) {
    params.moviehash = String(extra.videoHash).toLowerCase();
  }

  let res;
  try {
    res = await axios.get(`${API_BASE}/subtitles`, {
      params,
      headers: {
        'Api-Key': process.env.OPENSUBTITLES_API_KEY,
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    const status = err.response?.status;
    console.error(
      `[opensubtitles] Falha na busca (idiomas: ${languages.join(',')}) — status ${status || '??'}: ${
        err.response?.data?.message || err.message
      }`
    );
    if (status === 401) {
      console.error('[opensubtitles] Isso costuma indicar OPENSUBTITLES_API_KEY errada ou ausente no .env');
    }
    return [];
  }

  const results = res.data?.data || [];
  const langLabel = languages.length ? languages.join(",") : "todos";
  const hashMatches = results.filter((r) => r.attributes?.moviehash_match).length;
  console.log(
    `[opensubtitles] Busca (idiomas: ${langLabel}) encontrou ${results.length} resultado(s)` +
      (extra.videoHash ? `, ${hashMatches} feita(s) para este arquivo exato` : '')
  );

  // Ordem de preferência:
  // 1. feitas para o arquivo exato (hash bate) — sincronia garantida
  // 2. nome da legenda parecido com o nome do arquivo — mesma versão, provavelmente sincronizada
  // 3. mais baixadas
  const score = (r) => similarity(r.attributes?.release, extra.filename);
  results.sort(
    (a, b) =>
      (b.attributes?.moviehash_match ? 1 : 0) - (a.attributes?.moviehash_match ? 1 : 0) ||
      score(b) - score(a) ||
      (b.attributes?.download_count || 0) - (a.attributes?.download_count || 0)
  );

  return results;
}

/**
 * Busca legendas já prontas em pt-br.
 */
async function searchOpenSubtitles({ type, id, extra }) {
  const results = await rawSearch({ type, id, extra }, ['pt-br']);

  const subtitles = [];
  for (const item of results.slice(0, 5)) {
    const fileId = item.attributes?.files?.[0]?.file_id;
    if (!fileId) continue;

    subtitles.push({
      id: `os-${item.id}`,
      lang: 'por',
      // A URL de download real é resolvida sob demanda em resolveDownloadUrl,
      // porque o link da OpenSubtitles expira. Aqui geramos uma URL do NOSSO
      // servidor que faz esse resgate na hora que o Stremio pedir o arquivo.
      url: `${process.env.PUBLIC_URL || ''}/os-download/${fileId}`,
    });
  }

  return subtitles;
}

/**
 * Busca a melhor legenda disponível numa lista de idiomas de fallback
 * (ex: ['en', 'es']), na ordem de preferência informada. Usada para
 * traduzir uma legenda existente quando não há PT-BR disponível.
 * Devolve { fileId, lang } ou null se não achar nada.
 */
async function searchBestForeignSubtitle({ type, id, extra }, languages) {
  const results = await rawSearch({ type, id, extra }, languages);

  // Tenta manter a ordem de preferência de idiomas, pegando a mais baixada
  // dentro de cada idioma antes de cair pro próximo da lista.
  for (const lang of languages) {
    const inLang = results.filter((item) => item.attributes?.language === lang);
    const withFile = inLang.find((item) => item.attributes?.files?.[0]?.file_id);
    if (withFile) {
      return { fileId: withFile.attributes.files[0].file_id, lang };
    }
  }

  return null;
}

/**
 * Último recurso: pega a melhor legenda disponível em QUALQUER idioma
 * (o Google Translate detecta o idioma de origem sozinho). Ignora pt-br,
 * que já foi procurado no estágio 1.
 * Devolve { fileId, lang } ou null.
 */
async function searchAnyLanguageSubtitle({ type, id, extra }) {
  const results = await rawSearch({ type, id, extra }, []);
  const best = results.find(
    (item) => item.attributes?.language !== 'pt-br' && item.attributes?.files?.[0]?.file_id
  );
  return best ? { fileId: best.attributes.files[0].file_id, lang: best.attributes.language } : null;
}

/**
 * Baixa o conteúdo bruto (texto) de um arquivo .srt da OpenSubtitles,
 * dado o file_id — usado para depois traduzir o texto.
 */
async function downloadSubtitleText(fileId) {
  const link = await resolveDownloadUrl(fileId);
  const res = await axios.get(link, { responseType: 'arraybuffer', timeout: 30000 });
  return decodeSubtitleBuffer(Buffer.from(res.data));
}

/**
 * Troca um file_id da OpenSubtitles por um link de download real (.srt),
 * fazendo login se necessário. Usado pela rota /os-download/:fileId em index.js
 */
async function resolveDownloadUrl(fileId) {
  const token = await login();

  const headers = {
    'Api-Key': process.env.OPENSUBTITLES_API_KEY,
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await axios.post(
    `${API_BASE}/download`,
    { file_id: Number(fileId) },
    { headers }
  );

  return res.data.link;
}

module.exports = {
  searchOpenSubtitles,
  resolveDownloadUrl,
  searchBestForeignSubtitle,
  searchAnyLanguageSubtitle,
  downloadSubtitleText,
};
