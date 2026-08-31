const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', 'cache');

function keyToFile(id) {
  // Windows não aceita ":" em nomes de arquivo — trocamos por "_"
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(CACHE_DIR, `${safe}.srt`);
}

function statusFile(id) {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(CACHE_DIR, `${safe}.status.json`);
}

function getCachedSrtPath(id) {
  const file = keyToFile(id);
  return fs.existsSync(file) ? file : null;
}

function saveSrt(id, srtContent) {
  fs.writeFileSync(keyToFile(id), srtContent, 'utf-8');
}

function getStatus(id) {
  const file = statusFile(id);
  if (!fs.existsSync(file)) return 'idle'; // idle | processing | done | error
  return JSON.parse(fs.readFileSync(file, 'utf-8')).status;
}

function setStatus(id, status, extra = {}) {
  fs.writeFileSync(statusFile(id), JSON.stringify({ status, ...extra }), 'utf-8');
}

/**
 * Ao ligar o servidor, qualquer status "processing" salvo em disco é lixo de
 * uma execução anterior que foi interrompida (ex: Ctrl+C no meio de uma
 * geração) — nesse momento, com certeza NADA está processando de verdade
 * ainda. Reseta esses status para "idle" pra não ficar travado esperando
 * um processo que já morreu.
 */
function resetStaleProcessing() {
  if (!fs.existsSync(CACHE_DIR)) return 0;

  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.status.json'));
  let resetCount = 0;

  for (const file of files) {
    const filePath = path.join(CACHE_DIR, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (data.status === 'processing') {
        fs.writeFileSync(filePath, JSON.stringify({ status: 'idle' }), 'utf-8');
        resetCount++;
      }
    } catch {
      // arquivo de status corrompido/ilegível — ignora e segue
    }
  }

  return resetCount;
}

module.exports = { getCachedSrtPath, saveSrt, getStatus, setStatus, resetStaleProcessing, CACHE_DIR };
