function parseTimestamp(ts) {
  // formato esperado: HH:MM:SS,mmm
  const match = ts.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!match) return 0;
  const [, h, m, s, ms] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

/**
 * Converte o conteúdo de um arquivo .srt em uma lista de
 * segmentos { start, end, text }, ignorando índices numéricos e
 * juntando linhas de texto multi-linha em uma só string por bloco.
 */
function srtToSegments(srtContent) {
  const blocks = srtContent.replace(/\r/g, '').split(/\n\s*\n/).filter((b) => b.trim());
  const segments = [];

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const timeLineIndex = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIndex === -1) continue;

    const [startStr, endStr] = lines[timeLineIndex].split('-->');
    const text = lines
      .slice(timeLineIndex + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '') // remove tags de formatação (<i>, <b>, etc)
      .trim();

    if (!text) continue;

    segments.push({
      start: parseTimestamp(startStr),
      end: parseTimestamp(endStr),
      text,
    });
  }

  return segments;
}

module.exports = { srtToSegments };
