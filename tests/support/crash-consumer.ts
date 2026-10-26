import { createDatabase } from '../../src/persistence/database';
import { WageringService } from '../../src/application/wagering';
import { Queues } from '../../src/messaging/sqs';
import { Workers } from '../../src/messaging/workers';

async function main() {
  const db = await createDatabase().initialize();
  const queues = new Queues();
  const worker = new Workers(new WageringService(db), queues);
  try {
    if (process.env.TEST_CRASH_AFTER_PUBLISH) await worker.publish();
    else for (let attempt = 0; attempt < 30; attempt++) await worker.consume();
  } finally {
    queues.close();
    await db.destroy();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
