/**
 * Utilitários compartilhados entre as fontes de legenda.
 */

const STOPWORDS = new Set(['the', 'and', 'mkv', 'mp4', 'avi', 'web', 'srt']);

function tokens(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
}

/**
 * Dá uma nota de 0 a N para o quanto o nome de uma legenda ("release")
 * se parece com o nome do arquivo de vídeo que está tocando. Legendas da
 * mesma versão (ex: mesmo grupo "WEB-DL.NTb") costumam ficar sincronizadas.
 */
function similarity(releaseName, filename) {
  if (!releaseName || !filename) return 0;
  const a = tokens(releaseName);
  const b = tokens(filename);
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared;
}

/**
 * Converte o conteúdo bruto (Buffer) de uma legenda em texto. Muitas
 * legendas antigas vêm em Latin-1/Windows-1252 em vez de UTF-8 — se o
 * UTF-8 gerar caracteres inválidos, tenta de novo como Latin-1 para os
 * acentos não virarem "�".
 */
function decodeSubtitleBuffer(buffer) {
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('�')) return utf8.replace(/^﻿/, '');
  return buffer.toString('latin1');
}

/**
 * Lê "S22E02" (ou "22x02") do nome de uma legenda. Se o nome indicar um
 * episódio diferente do pedido, devolve true — as bases às vezes catalogam
 * uma legenda no episódio errado, e o nome do arquivo costuma ser mais
 * confiável que o cadastro.
 */
function parseEpisode(name) {
  const m = String(name || '').match(/s(\d{1,2})[ ._-]?e(\d{1,3})/i) || String(name || '').match(/\b(\d{1,2})x(\d{2,3})\b/i);
  return m ? { season: Number(m[1]), episode: Number(m[2]) } : null;
}

function releaseIsOtherEpisode(release, season, episode) {
  if (!release || !season || !episode) return false;
  const found = parseEpisode(release);
  if (!found) return false;
  return found.season !== Number(season) || found.episode !== Number(episode);
}

module.exports = { similarity, decodeSubtitleBuffer, releaseIsOtherEpisode, parseEpisode };
