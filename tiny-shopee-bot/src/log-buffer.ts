// In-memory log buffer for displaying sync logs on the dashboard
export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

const MAX_LOGS = 200;
const logs: LogEntry[] = [];

export function getLogs(): LogEntry[] {
  return logs;
}

export function clearLogs(): void {
  logs.length = 0;
}

function addLog(level: LogEntry['level'], message: string) {
  logs.unshift({
    timestamp: new Date().toLocaleString('pt-BR'),
    level,
    message,
  });
  if (logs.length > MAX_LOGS) logs.splice(MAX_LOGS);
}

// Intercept console.log/warn/error to capture bot logs
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

console.log = (...args: any[]) => {
  origLog(...args);
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  if (msg.includes('[BOT]') || msg.includes('[OK]') || msg.includes('[SERVER]') || msg.includes('Iniciando')) {
    addLog('info', msg);
  }
};

console.warn = (...args: any[]) => {
  origWarn(...args);
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  addLog('warn', msg);
};

console.error = (...args: any[]) => {
  origError(...args);
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  if (msg.includes('[ERRO]') || msg.includes('[AVISO]')) {
    addLog('error', msg);
  }
};
