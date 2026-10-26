# Wagering Processor

API para processar operações de apostas, manter o saldo de carteiras e registrar cada movimentação em um ledger. HTTP e SQS usam o mesmo serviço de aplicação.

Stack: Bun 1.x, TypeScript estrito, NestJS, TypeORM, PostgreSQL e LocalStack/SQS. As decisões e limitações estão em `ARCHITECTURE.md`.

## Executar com Docker

Pré-requisitos: Docker com engine Linux e Docker Compose. No Windows, Docker Desktop precisa de WSL 2 funcionando.

```sh
docker compose up --build -d
docker compose logs -f app-1
```

O serviço `setup` executa as migrations e cria as filas antes de iniciar três instâncias:

- API 1: http://localhost:3000
- API 2: http://localhost:3001
- API 3: http://localhost:3002
- PostgreSQL: localhost:55432
- LocalStack: http://localhost:4566

As portas são expostas somente no loopback. Não há autenticação ativa; esta configuração é para desenvolvimento e avaliação local.

```sh
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
curl http://localhost:3000/metrics
```

Para parar preservando os dados:

```sh
docker compose down
```

## Executar a API fora do container

Com Bun 1.x instalado:

```sh
bun install --frozen-lockfile
docker compose up -d postgres localstack
bun run migrate
bun run queues
bun run build
bun start
```

Os padrões de configuração são os de `.env.example`. Você pode copiar esse arquivo para `.env` e ajustar as variáveis. As credenciais incluídas são exclusivamente locais. Nunca reutilize esses valores em um ambiente público.

Para executar só a API, sem consumidores ou publishers: `WORKERS_ENABLED=false`. Para desenvolvimento com recarga: `bun run dev`.

## Exemplo HTTP

Os comandos abaixo usam a sintaxe de um shell POSIX. No Windows, use `curl.exe` e adapte as aspas, ou execute os exemplos de `requests.http` em um cliente REST.

Criar uma carteira:

```sh
curl -X POST http://localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

Use o `id` retornado como `walletId`:

```sh
curl -X POST http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-1","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"SUBSTITUA_PELO_ID","roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

Uma resposta processada contém `transactionId`, `status`, `balance` e `idempotentReplay`. Enviar o mesmo comando novamente devolve o saldo observado no processamento original. Alterar os campos de negócio mantendo a chave resulta em conflito.

## Endpoints

| Método | Caminho | Finalidade |
| --- | --- | --- |
| POST | `/wallets` | Abre carteira; saldo inicial positivo gera OPENING e ledger |
| GET | `/wallets/:walletId` | Saldo atual e versão |
| GET | `/wallets/:walletId/ledger?cursor=...&limit=50` | Ledger paginado em ordem de inclusão |
| POST | `/wagering/transactions` | Processa BET, WIN, LOSS, REFUND ou ROLLBACK |
| GET | `/wagering/transactions/:transactionId` | Resultado persistido |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pela identificação externa |
| POST | `/wallets/:walletId/reconciliation` | Compara saldo e ledger, sem corrigir divergências |
| GET | `/health/live` | Processo respondendo |
| GET | `/health/ready` | PostgreSQL e três filas SQS acessíveis |
| GET | `/metrics` | Métricas no formato Prometheus |

HTTP: `201` para criação de carteira, `200` para processamento ou replay concluído, `202` para referência pendente, `400` para contrato inválido, `404` para recurso ausente, `409` para conflito, `422` para rejeição de negócio e `503` para indisponibilidade ou falha de infraestrutura.

`Idempotency-Key` é obrigatório no POST de transações. O header opcional `X-Correlation-Id` permite rastreamento. Valores monetários são strings decimais; a saída sempre possui duas casas. `LOSS` deve ter valor `0.00`; as outras operações recebem valor positivo. `OPENING` é interno.

## Filas

- `wager-transactions.fifo`: comandos de entrada;
- `wager-transactions-dlq.fifo`: mensagens inválidas ou com tentativas esgotadas;
- `wager-events.fifo`: eventos publicados pela outbox.

Exemplo de corpo de mensagem:

```json
{
  "messageId": "message-1",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-26T18:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "bet-1",
    "idempotencyKey": "provider-a:bet-1",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "SUBSTITUA_PELO_ID",
    "roundId": "round-1",
    "gameId": "game-1",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Ao enviar por AWS CLI, informe `--message-group-id` com a carteira e `--message-deduplication-id` com o identificador da mensagem. A proteção financeira continua no PostgreSQL mesmo depois da janela de deduplicação do SQS.

## Testes

Unidade, sem dependências externas:

```sh
bun test tests/unit
bun run typecheck
bun run build
```

Integração de banco com PostgreSQL acessível pela variável `DATABASE_URL`:

```sh
bun test tests/integration/database.test.ts --timeout 120000
bun run test:system
```

O teste de sistema inicia três processos reais em portas 33101–33103 e encerra esses processos ao terminar. Não usa mocks de banco.

Suite completa em containers, incluindo SQS, falhas, reinício e concorrência:

```sh
docker compose stop app-1 app-2 app-3
docker compose --profile test run --build --rm tests
```

Execute em um ambiente dedicado de teste. A suite SQS limpa as três filas para isolar o experimento; não aponte para filas compartilhadas. Os testes criam carteiras e transações com IDs únicos. `TEST_SQS=true` habilita a suite de fila; sem essa variável ela é exibida como ignorada, nunca como aprovada.

A configuração de CI em `.github/workflows/tests.yaml` executa a suite completa em um runner Linux. O resultado local efetivamente obtido está em `VALIDATION.md`.

## Migrations

```sh
bun run migrate
bun run migrate:down
```

`migrate:down` remove as tabelas desta aplicação e seus dados. Use somente para desfazer a instalação em um banco de teste descartável. A aplicação nunca usa `synchronize: true`.

## Organização

- `src/domain`: dinheiro, carteira, transação, ledger e eventos; sem NestJS ou ORM;
- `src/application`: validação de contratos e caso de uso compartilhado;
- `src/persistence`: mapeamento TypeORM, migrations e conexão;
- `src/http`: controllers, filtro de erros e extensão para autenticação;
- `src/messaging`: integração SQS, consumidor e publisher;
- `tests`: unidade, PostgreSQL, SQS e múltiplos processos.
