const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');

const GROQ_API_BASE = 'https://api.groq.com/openai/v1';
const MODEL = process.env.GROQ_TRANSCRIBE_MODEL || 'whisper-large-v3-turbo';
// O Whisper é um modelo de reconhecimento de fala dedicado (não estima
// timestamps "raciocinando" como um LLM), então pedaços maiores são seguros.
const CHUNK_SECONDS = 600; // 10 min por pedaço

/**
 * Extrai o áudio do vídeo e quebra em pedaços de CHUNK_SECONDS usando ffmpeg.
 * Requer ffmpeg instalado no servidor (apt install ffmpeg / imagem docker com ffmpeg).
 */
function splitAudio(inputPath, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const pattern = path.join(workDir, 'chunk-%03d.mp3');
  execSync(
    `ffmpeg -y -i "${inputPath}" -vn -ar 16000 -ac 1 -b:a 64k -f segment -segment_time ${CHUNK_SECONDS} "${pattern}"`,
    { stdio: 'ignore' }
  );
  return fs
    .readdirSync(workDir)
    .filter((f) => f.startsWith('chunk-'))
    .sort()
    .map((f) => path.join(workDir, f));
}

async function transcribeChunk(chunkPath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(chunkPath));
  form.append('model', MODEL);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');

  let res;
  try {
    res = await axios.post(`${GROQ_API_BASE}/audio/transcriptions`, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120000, // áudio demora mais que texto — 2 min antes de desistir
    });
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Groq (transcrição) falhou: ${detail}`);
  }

  return res.data.segments || [];
}

/**
 * Transcreve um arquivo de áudio/vídeo inteiro (idioma original).
 * Devolve uma lista de segmentos { start, end, text } com timestamps em segundos.
 */
async function transcribeFile(inputPath) {
  const workDir = path.join(path.dirname(inputPath), '_chunks_' + Date.now());
  const chunks = splitAudio(inputPath, workDir);

  const allSegments = [];
  let offset = 0;

  for (const chunkPath of chunks) {
    console.log(`[gerar] Transcrevendo pedaço de áudio (${chunks.indexOf(chunkPath) + 1} de ${chunks.length})...`);
    const segments = await transcribeChunk(chunkPath);
    for (const seg of segments) {
      allSegments.push({
        start: seg.start + offset,
        end: seg.end + offset,
        text: (seg.text || '').trim(),
      });
    }
    offset += CHUNK_SECONDS;
  }

  fs.rmSync(workDir, { recursive: true, force: true });
  return allSegments;
}

module.exports = { transcribeFile };
