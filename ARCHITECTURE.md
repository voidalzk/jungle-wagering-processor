# Decisões de arquitetura

## Estrutura e limites

O domínio é formado por classes sem dependência de NestJS, TypeORM ou SQS. `Money` representa um valor; `Wallet` controla saldo e versão; `WagerTransaction` controla estados e referências; `WalletLedgerEntry` representa uma movimentação imutável. Inbox, outbox e eventos também têm factories e transições explícitas.

`WageringService` é o caso de uso compartilhado entre HTTP e SQS. Ele coordena o domínio dentro de uma transação TypeORM. SQL explícito é usado onde torna locks, conflitos e consultas agregadas mais claros. As consultas simples e o lock pessimista da carteira usam repositórios e QueryBuilder.

Não há camada genérica de repositórios para cada tabela. Neste tamanho de projeto, ela acrescentaria indireção sem trocar a estratégia transacional. A consequência é que o serviço de aplicação conhece `EntityManager`; somente o domínio permanece completamente independente da persistência.

## Dinheiro

`Money` armazena centavos em `bigint`. Não há conversão para `number` na aritmética financeira. A entrada é uma string decimal positiva ou zero, sem notação científica, separador de milhar ou mais de duas casas. A saída sempre tem duas casas. Valores com menos casas são normalizados, não arredondados.

O limite é o de `numeric(20,2)`: 18 dígitos inteiros e dois decimais. Operações que ultrapassem esse limite são rejeitadas. Números negativos só são produzidos internamente, por exemplo na diferença da reconciliação.

Moedas são códigos reconhecidos por `Intl.supportedValuesOf('currency')`. As operações exigem moedas iguais. Não há conversão cambial; todas as moedas usam duas casas neste exercício, inclusive as que possuem outras convenções no mundo real. Os exemplos e testes de negócio usam BRL.

No banco, valores são `numeric(20,2)`, recebidos pelo driver como strings. O mapeamento explícito reconstrói `Money` na leitura. `number` continua adequado para contagens, versão, duração, métricas e tentativas, nunca para saldo, valor ou comissão.

## Transação financeira e concorrência

Cada operação começa bloqueando a linha da carteira com `SELECT ... FOR UPDATE`, através de `setLock('pessimistic_write')`. O lock é mantido até commit ou rollback. Requisições da mesma carteira aguardam a anterior; carteiras diferentes usam locks diferentes.

A ordem é: carteira, transação, ledger/inbox/outbox. O worker de referências segue a mesma ordem e revalida a elegibilidade depois de obter o lock. Isso evita inverter locks entre workers.

Dentro da mesma transação SQL são gravados:

1. registro da operação e resultado;
2. saldo e versão da carteira, quando houver movimentação;
3. lançamento no ledger;
4. inbox, quando a origem for SQS;
5. eventos na outbox.

Uma falha em qualquer passo desfaz todos os outros. Não existe envio SQS dentro dessa transação financeira.

O isolamento é READ COMMITTED com lock por carteira. `lock_timeout` é de cinco segundos. Timeout, deadlock e falha de serialização viram `503 CONCURRENCY_RETRY`. O cliente pode repetir com a mesma chave; o consumidor SQS usa retry com backoff.

Uma aposta e uma reversão de outra carteira não precisam bloquear uma à outra. As referências só podem produzir efeito depois de validadas como pertencentes à mesma carteira; registros de outras carteiras são lidos apenas para rejeitar o contexto.

## Garantias no schema

- UNIQUE de carteira por jogador e moeda;
- CHECK de saldo não negativo;
- UNIQUE da idempotency key;
- UNIQUE da combinação provider e ID externo;
- UNIQUE do lançamento por carteira e transação;
- índice único parcial de reversão processada por referência e tipo;
- chaves estrangeiras entre carteira, transação, ledger e inbox;
- CHECK da aritmética de cada lançamento;
- triggers que recusam UPDATE, DELETE e TRUNCATE no ledger;
- trigger que impede alterar operações terminais ou seus campos de negócio;
- constraints diferidas que conferem saldo, sequência de lançamentos, versão e correspondência com transações antes do commit.

As constraints diferidas permitem inserir o ledger e alterar o saldo em instruções separadas, mas rejeitam a transação SQL inteira se o estado final divergir. A versão é 1 na abertura e aumenta uma vez por movimentação posterior. LOSS e rejeições não alteram a versão.

Trade-off: a validação diferida percorre o histórico da carteira e prioriza integridade sobre throughput. Para volumes grandes, seria necessário particionar o ledger, medir esse custo e projetar checkpoints verificados ou uma função transacional restrita no banco. Não há alegação de capacidade de produção ou resultado de carga nesta entrega.

O usuário da aplicação no Compose é também o dono do schema, por simplicidade de instalação. Em produção, migrations e aplicação precisam de credenciais diferentes; nenhum usuário de aplicação deve poder desativar triggers ou alterar o schema.

## Idempotência e hash

O header HTTP `Idempotency-Key` é obrigatório. Na fila, ele corresponde a `data.idempotencyKey`. A chave é global nesta implementação; o formato recomendado inclui o provider. A mesma operação externa não pode receber uma nova chave para provocar uma segunda movimentação: há também UNIQUE(provider, external ID).

O hash é SHA-256 de JSON canônico dos campos de negócio validados. Chaves são ordenadas recursivamente; campos ausentes são omitidos. Dinheiro e UUIDs são normalizados antes do hash. A chave de idempotência, correlação, horário de transporte e campos extras não participam desse hash.

Chave e payload iguais retornam o resultado salvo. Uma resposta terminal guarda o saldo observado naquele processamento, não o saldo atual da carteira. Payload divergente ou troca de chave para o mesmo ID externo gera conflito.

Enquanto uma referência estiver pendente, consultas e replays podem mostrar o estado mais recente. Depois de terminal, a resposta não muda. `idempotentReplay` é marcado somente no retorno da repetição.

## Ledger e reconciliação

A abertura com valor positivo produz uma operação interna OPENING e um crédito. Abertura zerada não produz ledger. Cada operação financeira processada produz um lançamento; LOSS e operações rejeitadas/falhas não produzem lançamento.

O ledger é append-only. Não é contabilidade de partidas dobradas: há um registro por movimentação da carteira, conforme o escopo solicitado. Correções são novas operações de reversão.

O cursor é um JSON com carteira e sequência, codificado em base64url. Ele é opaco como contrato, mas não é criptografado nem assinado; não carrega segredo. A consulta valida formato, limites e vínculo com a carteira, usando uma sequência monotônica para não depender de timestamps iguais. Base64 não substitui autorização.

Reconciliação bloqueia a carteira, soma os lançamentos e compara com o saldo materializado no mesmo estado consistente. A diferença é `storedBalance - calculatedBalance`. Divergências geram métrica, log e resposta explícita; não existe correção automática.

## Estados e regras adotadas

```text
PENDING -----------> PROCESSED | REJECTED | FAILED
   |
   v
PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED
   |
   +---------------> PENDING_REFERENCE (nova tentativa)
```

Estados terminais não podem transicionar, nem no domínio nem no banco.

- BET exige valor positivo e debita.
- WIN exige valor positivo, credita e pode referenciar uma BET da mesma rodada.
- LOSS exige `0.00`, registra resultado sem ledger e não aceita referência nesta interpretação.
- REFUND exige BET processada, contexto igual e valor integral da referência.
- ROLLBACK aceita BET, WIN ou REFUND processada, com valor integral; inverte sua direção.
- ROLLBACK de crédito pode ser rejeitado se o saldo não comportar o débito.
- OPENING é reservado à criação da carteira e não entra por HTTP/SQS.
- Provider `__internal__` e prefixo de chave `opening:` são reservados.

A unicidade das reversões segue literalmente a regra por referência **e tipo**. Portanto, REFUND e ROLLBACK distintos da mesma BET são permitidos, mas dois REFUND ou dois ROLLBACK não são. Se a regra comercial desejada fosse uma única reversão total, seria necessário mudar a validação e o índice para unicidade apenas da referência. Essa interpretação merece confirmação antes de uso fora do exercício.

`gameId` é preservado para auditoria; a validação de referência compara provider, player, wallet, moeda e rodada. WIN não precisa ter o mesmo valor da BET. Referências a operações rejeitadas ou falhas são rejeitadas imediatamente.

## Referências fora de ordem

Referência ausente ou ainda não terminal gera PENDING_REFERENCE, uma resposta 202 e um evento. O comando é confirmado na inbox e removido do SQS: o trabalho pendente já está durável no banco.

O worker consulta os registros vencidos a cada 500 ms. A espera usa `min(base * 2^tentativa, 60000)`; base padrão de um segundo e limite de 12 esperas. Sem contenção ou indisponibilidade, isso permite cerca de sete minutos para a referência chegar. O tempo de parede pode crescer se o worker estiver indisponível. O estado sobrevive ao reinício.

Ao esgotar o limite, a operação termina como REJECTED com REFERENCE_EXPIRED e evento correspondente. A chegada posterior da referência não reabre esse estado terminal.

## Inbox, SQS e falhas

Inbox é única por `(consumerName, messageId)`. Seu hash cobre o payload de negócio normalizado e a idempotency key. Reusar o mesmo messageId para outro comando gera INBOX_CONFLICT e rollback financeiro.

O consumidor só remove a mensagem após o commit. Se morrer nesse intervalo, o SQS entrega novamente; a transação e a inbox impedem efeito repetido. O visibility timeout tem heartbeat enquanto o comando está em andamento.

Classificação:

- rejeição de negócio: resultado REJECTED persistido, evento e ack;
- referência pendente: pendência persistida, evento e ack;
- contrato inválido, conflito ou carteira inexistente: DLQ com mensagem original e ack após confirmar o envio à DLQ;
- falha transitória: sem ack, visibilidade adiada com backoff;
- erro permanente de schema ou limite de tentativas: DLQ; quando o banco permite, transação FAILED auditável e evento adicional `WagerTransactionFailed`.

Se o próprio PostgreSQL estiver completamente indisponível, não é possível persistir FAILED nele. Nesse caso a mensagem original na DLQ é o registro durável para análise e reenvio manual. O redrive do SQS também limita tentativas mesmo quando a aplicação cai antes de executar o próprio tratamento.

No SIGTERM, a aplicação para de aceitar novas requisições e espera as iterações em andamento, incluindo consumidores e publishers. O Compose concede 90 segundos. Em encerramento forçado, a visibilidade expira e a mensagem volta; operações confirmadas continuam idempotentes.

## Outbox

O publisher seleciona até dez linhas vencidas com `FOR UPDATE SKIP LOCKED`. O envio acontece depois do commit financeiro e dentro de uma transação separada do publisher. Outros publishers selecionam linhas desbloqueadas.

O `eventId` permanece o mesmo em toda tentativa e é usado como deduplication ID. Se houver crash depois do SendMessage e antes de gravar published_at, a próxima instância pode publicar novamente. A garantia é at-least-once, não exactly-once. Consumidores externos devem deduplicar por eventId em armazenamento persistente; a janela FIFO sozinha não basta.

Falhas de publicação incrementam attempts e agendam backoff de até 60 segundos. Não há descarte automático da outbox por excesso de tentativas; eventos financeiros confirmados precisam continuar disponíveis. Logs e outbox lag permitem detectar acúmulo.

Eventos de carteiras distintas podem sair em paralelo. Dois publishers podem publicar eventos da mesma carteira em ordem diferente; consumidores que mantêm projeção de saldo devem considerar walletVersion. A fonte da verdade continua sendo banco e ledger.

## Taxonomia de falhas

| Código | Significado |
| --- | --- |
| INVALID_AMOUNT / AMOUNT_OUT_OF_RANGE | Formato/limite monetário inválido |
| INVALID_CURRENCY | Moeda não reconhecida |
| INVALID_OPERATION_AMOUNT | LOSS não zero ou operação financeira sem valor positivo |
| INVALID_KIND / RESERVED_PROVIDER | Tipo ou namespace interno indevido |
| REFERENCE_REQUIRED / UNEXPECTED_REFERENCE / SELF_REFERENCE | Referência inválida no contrato |
| INVALID_IDEMPOTENCY_KEY | Header/chave ausente ou inválido |
| IDEMPOTENCY_CONFLICT / INBOX_CONFLICT | Identificador reutilizado com outro comando |
| DUPLICATE_RESOURCE | Colisão de unicidade, como carteira duplicada |
| WALLET_NOT_FOUND / TRANSACTION_NOT_FOUND | Recurso ausente |
| PLAYER_MISMATCH / CURRENCY_MISMATCH | Operação não corresponde à carteira |
| INSUFFICIENT_FUNDS | Aposta sem saldo |
| REVERSAL_INSUFFICIENT_FUNDS | Reversão de crédito deixaria saldo negativo |
| REFERENCE_CONTEXT_MISMATCH | Referência de outro contexto |
| INVALID_REFERENCE_KIND / REFERENCE_AMOUNT_MISMATCH | Tipo ou valor da referência incorreto |
| REFERENCE_NOT_PROCESSED | Referência terminou sem ser aplicada |
| REFERENCE_ALREADY_REVERSED | Segunda reversão do mesmo tipo |
| REFERENCE_EXPIRED | Tentativas para localizar referência esgotadas |
| CONCURRENCY_RETRY | Repetir com a mesma chave após disputa de lock |
| INFRASTRUCTURE_UNAVAILABLE / DEPENDENCY_UNAVAILABLE | Dependência indisponível |
| PERMANENT_INFRASTRUCTURE_ERROR / INFRASTRUCTURE_RETRY_EXHAUSTED | Falha auditável encaminhada à DLQ |

Validadores também retornam códigos específicos como INVALID_UUID, INVALID_PROVIDER, INVALID_CURSOR e INVALID_LIMIT. Clientes devem decidir pelo código e status HTTP, não pela mensagem textual.

## Autenticação

Não foi implementado um IdP, pois o enunciado permite priorizar o núcleo financeiro. `ProviderAuthGuard` é o ponto de extensão e atualmente permite acesso.

O desenho de produção usaria OIDC com Keycloak ou IdP equivalente: validar assinatura por JWKS, issuer, audience, expiração e scopes; vincular o providerId ao claim autenticado e aplicar autorização nas consultas de carteiras e transações. Health permaneceria aberto, e métricas ficariam restritas à rede de observabilidade. A fila é um canal interno confiável, mas sua identidade de domínio continua sendo validada.

## Observabilidade e limites

Logs são JSON com campos de contexto fixos; não imprimem o corpo completo nem valores monetários. Métricas cobrem transições de status, replay, retry, DLQ, conflitos de lock, idade da outbox, duração e divergências. Métricas são locais ao processo e reiniciam com ele; Prometheus deve coletar cada instância. Contadores de status representam transições, não o total de registros de cada status no banco.

Não foram incluídos UI, autenticação artesanal, cache de saldo, load test, partidas dobradas ou deployment público. O foco é a correção do processamento. Testes e condições realmente verificadas constam em `VALIDATION.md`.
