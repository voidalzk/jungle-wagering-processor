import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { Queues } from '../src/messaging/sqs';
import { config } from '../src/config';

async function main() {
  const queues = new Queues();
  try {
    for (const name of [config.dlq, config.queue, config.events]) {
      await queues.client.send(
        new CreateQueueCommand({
          QueueName: name,
          Attributes: {
            FifoQueue: 'true',
            ContentBasedDeduplication: 'false',
            VisibilityTimeout: String(config.visibility),
          },
        }),
      );
    }
    const arn = await queues.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: await queues.url(config.dlq),
        AttributeNames: ['QueueArn'],
      }),
    );
    await queues.client.send(
      new SetQueueAttributesCommand({
        QueueUrl: await queues.url(config.queue),
        Attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: arn.Attributes!.QueueArn,
            maxReceiveCount: String(config.maxReceives),
          }),
        },
      }),
    );
    console.log('Queues ready');
  } finally {
    queues.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
