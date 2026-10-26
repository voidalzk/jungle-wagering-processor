import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { createHash } from 'node:crypto';
import { config } from '../config';

export class Queues {
  readonly client = new SQSClient({
    endpoint: config.sqsEndpoint,
    region: config.region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
    maxAttempts: 2,
    requestHandler: { requestTimeout: 5000, connectionTimeout: 2000 },
  });
  private urls = new Map<string, string>();
  async url(name: string): Promise<string> {
    const cached = this.urls.get(name);
    if (cached) return cached;
    const response = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!response.QueueUrl) throw new Error('Queue URL not found');
    this.urls.set(name, response.QueueUrl);
    return response.QueueUrl;
  }
  async send(name: string, body: string, group: string, deduplication: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.url(name),
        MessageBody: body,
        MessageGroupId: createHash('sha256').update(group).digest('hex'),
        MessageDeduplicationId: createHash('sha256').update(deduplication).digest('hex'),
      }),
    );
  }
  async receive(name: string): Promise<Message[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.url(name),
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
        VisibilityTimeout: config.visibility,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    return response.Messages ?? [];
  }
  async ack(name: string, message: Message): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: await this.url(name),
        ReceiptHandle: message.ReceiptHandle!,
      }),
    );
  }
  async visibility(name: string, message: Message, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.url(name),
        ReceiptHandle: message.ReceiptHandle!,
        VisibilityTimeout: seconds,
      }),
    );
  }
  async ready(): Promise<void> {
    await Promise.all(
      [config.queue, config.events, config.dlq].map(async (name) =>
        this.client.send(
          new GetQueueAttributesCommand({
            QueueUrl: await this.url(name),
            AttributeNames: ['QueueArn'],
          }),
        ),
      ),
    );
  }
  close() {
    this.client.destroy();
  }
}
