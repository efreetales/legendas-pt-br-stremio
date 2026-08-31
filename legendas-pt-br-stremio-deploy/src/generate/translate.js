const axios = require('axios');

const API_URL = 'https://translation.googleapis.com/language/translate/v2';
const API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY;
const BATCH_SIZE = 100; // segmentos por chamada — API de tradução dedicada, sem o limite de "tokens/minuto" das IAs de chat

async function translateBatch(texts) {
  let res;
  try {
    res = await axios.post(
      API_URL,
      {
        q: texts,
        target: 'pt-BR',
        format: 'text',
      },
      {
        params: { key: API_KEY },
        timeout: 30000,
      }
    );
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Google Translate falhou: ${detail}`);
  }

  return res.data.data.translations.map((t) => t.translatedText);
}

/**
 * Traduz uma lista de segmentos { start, end, text } para PT-BR,
 * preservando os timestamps originais. Usada tanto para traduzir uma
 * legenda existente em outro idioma (estágio 2) quanto o texto transcrito
 * do áudio (estágio 3).
 *
 * Diferente das IAs de chat (Gemini/Groq), a API de tradução do Google
 * aceita uma lista inteira de frases numa única chamada e não tem aquele
 * limite apertado de "tokens por minuto" — por isso não precisamos mais de
 * paralelismo nem de espera entre tentativas.
 */
async function translateSegments(segments) {
  const translated = [];
  const totalBatches = Math.ceil(segments.length / BATCH_SIZE);

  for (let i = 0; i < segments.length; i += BATCH_SIZE) {
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
    const batch = segments.slice(i, i + BATCH_SIZE);
    const translations = await translateBatch(batch.map((s) => s.text));
    batch.forEach((seg, idx) => {
      translated.push({ ...seg, text: translations[idx] || seg.text });
    });
    console.log(`[gerar] Traduzido lote ${batchNumber} de ${totalBatches}...`);
  }

  return translated;
}

module.exports = { translateSegments };