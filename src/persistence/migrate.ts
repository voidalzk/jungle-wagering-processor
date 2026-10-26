import { createDatabase } from './database';

async function main() {
  const db = await createDatabase().initialize();
  try {
    if (process.argv[2] === 'down') await db.undoLastMigration();
    else await db.runMigrations({ transaction: 'all' });
  } finally {
    await db.destroy();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
