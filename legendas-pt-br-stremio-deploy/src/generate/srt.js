function toSrtTimestamp(totalSecondsFloat) {
  const totalMs = Math.round(totalSecondsFloat * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/**
 * Converte uma lista de segmentos { start, end, text } (em segundos)
 * para o conteúdo de um arquivo .srt.
 */
function segmentsToSrt(segments) {
  return segments
    .map((seg, i) => {
      return `${i + 1}\n${toSrtTimestamp(seg.start)} --> ${toSrtTimestamp(seg.end)}\n${seg.text}\n`;
    })
    .join('\n');
}

module.exports = { segmentsToSrt };
