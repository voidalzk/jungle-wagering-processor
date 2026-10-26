# Validação executada

Data: 26/10/2026. Ambiente usado: Windows, Bun 1.4.4, PostgreSQL 18.6 instalado localmente e ElasticMQ 1.7.1 executado em Java para verificar o protocolo SQS. Docker Compose e LocalStack não puderam ser executados neste computador porque o Docker Desktop não inicia com o suporte de virtualização disponível. A atualização do WSL foi tentada e concluída, mas não fez o Docker iniciar.

## Resultado obtido

- `bun run typecheck`: passou com TypeScript estrito;
- `bun run build`: passou;
- `bun audit`: nenhuma vulnerabilidade encontrada após atualizar dependências;
- `bun test` sem emulador SQS: 43 testes passaram, 6 testes SQS ignorados por configuração, nenhum falhou;
- `TEST_SQS=true bun test tests/integration/sqs.test.ts`: os 6 testes SQS passaram com ElasticMQ local;
- `docker compose config --quiet`: configuração Compose válida;
- imagens Docker `oven/bun:1.4.4`, `postgres:18` e `localstack/localstack:4.9.2`: tags encontradas no registro público, mas os containers não foram iniciados aqui.

Os testes PostgreSQL usaram banco real, não um mock. Foram observados:

1. migration executada, revertida e reaplicada em schema de teste;
2. saldo inicial explicado por OPENING e ledger;
3. 50 submissões simultâneas da mesma BET com apenas um débito;
4. duas apostas de 80.00 sobre 100.00: uma aprovada, uma rejeitada;
5. carteiras diferentes processadas em paralelo;
6. replay com o saldo original e conflito de payload/chave;
7. BET, WIN, LOSS, REFUND, ROLLBACK e rejeição de reversão que deixaria saldo negativo;
8. moeda, jogador, rodada, valor e tipo de referência inválidos;
9. REFUND e ROLLBACK recebidos antes da BET;
10. expiração de referência com evento e failureCode;
11. deduplicação pela inbox;
12. falha injetada na outbox provocando rollback de saldo, ledger, transação e inbox;
13. constraints do schema recusando saldo negativo, divergência, mutação de ledger e alteração de estado terminal;
14. reconciliação após nova conexão com o banco.

Os testes de sistema iniciaram três processos da API e verificaram envio concorrente, disputa por saldo, códigos HTTP, reinício do processo e persistência do replay.

Os seis testes SQS executados com o emulador Java verificaram redelivery, inbox, DLQ, retry transitório, dois publishers sobre a outbox, queda após commit antes do ack e queda após envio antes de marcar a outbox. O emulador usa um protocolo compatível, mas não equivale a executar os mesmos testes com LocalStack em containers.

## Validação em containers

O workflow `.github/workflows/tests.yaml` executou a suite em um runner Linux com PostgreSQL e LocalStack em containers. A [execução de 26/10/2026](https://github.com/voidalzk/jungle-wagering-processor/actions/runs/40420503215) passou com TypeScript estrito, build e 49 testes aprovados, sem falhas. Isso valida a integração em containers, embora o Docker não tenha iniciado neste computador Windows.

Não foi realizado teste de carga nem benchmark de throughput. Não há números de desempenho alegados nesta entrega.
