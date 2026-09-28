// CLI: `npm run migrate` – wendet Migrationen an und synchronisiert die Event-Konfiguration.
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { loadEventConfig, syncEvent } from './event.js';

const config = loadConfig();
const pool = createPool(config);
try {
  await migrate(pool);
  const event = await loadEventConfig(config.eventConfigPath);
  await syncEvent(pool, event);
  console.info(`[db] Event „${event.slug}“ synchronisiert.`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
