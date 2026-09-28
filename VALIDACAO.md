# Validação — atualização de inicialização e assistente

## 28/09/2026 — cadastro e portal dos membros

- Suíte completa: `node --test --test-concurrency=2`, **217 testes aprovados, zero falhas**.
- Vinte e três testes novos de cadastro por IFJ, confirmação enviada somente ao Discord registrado, proteção de senhas/códigos/sessões, expiração, cinco tentativas, reenvio, duplicidades, Origin/CSRF e isolamento das contas de moderação.
- Nome vem do IFJ e acompanha atualizações. Exclusão ou troca do Discord revoga o acesso anterior; troca pela API permite novo cadastro do titular. A criação da conta não concede cargos ou permissões de equipe.
- Edge real com API simulada: cadastro com zeros iniciais, confirmação de senha, falha de envio, código incorreto, confirmação, login, logout, sessão existente, nome tratado como texto e recuperação após falha de consulta depois da confirmação.
- Desktop 1365 px e celular 390 px conferidos, sem erros JavaScript nem transbordamento horizontal. Boas-vindas mostra o nome oficial, a mensagem solicitada e Sair; nenhuma categoria da moderação.
- Prévia com dados fictícios: `../EXEMPLOS/portal-membro.png` e `../EXEMPLOS/cadastro-membro-mobile.png`.
- Sintaxe do novo módulo de autenticação, bot, API e JavaScript do portal aprovada. As novas tabelas estão incluídas no preflight e na migração transacional.

Validação local com PGlite e Discord simulado. Nenhum cadastro real, mensagem privada real ou deploy foi executado. Publique a pasta `projeto` completa para disponibilizar o portal e criar as novas tabelas automaticamente.

---

## 28/09/2026 — inicialização conjunta do banco e Discord

- Suíte completa: `node --test --test-concurrency=2`, **194 testes aprovados, zero falhas**.
- Nove testes do banco: criação do primeiro administrador com senha utilizável, rollback quando falta configuração inicial, atualização de esquema antigo preservando IFJ/credenciais/denúncia, repetição sem duplicar sincronizações, dados incompatíveis preservados, limites locais à transação, ordem do bloqueio de migração, descarte da conexão após rollback falhar e diagnóstico sem dados privados.
- Três testes de integração executam `boot`, migrações e verificações SQL reais em PGlite, usando o Client do Discord com login simulado. O caso de sucesso abre HTTP local e recebe `200 {"status":"ready"}`. Cancelamento de migração e erro de intents permanecem distintos e impedem abertura do servidor.
- Vinte testes da conexão Discord, incluindo relógio simulado com prontidão aos 40 segundos, além do antigo prazo de 35 segundos.
- Limites do banco: 60 segundos por instrução SQL durante a migração, 15 segundos para bloqueios e 75 segundos por chamada do cliente. `SET LOCAL` restaura os limites normais ao concluir ou desfazer a transação. Um bloqueio transacional serializa inicializadores desta versão.
- Falha de rollback não substitui a causa original. Registros informam etapa e SQLSTATE sem expor senhas, URLs privadas ou conteúdo dos cadastros.
- Botões, tribunal, Sub líder, tutorial, acesso da equipe e High member com Equipe continuam aprovados na suíte completa. Sintaxe de `db.js` e `preflight.js` conferida.

Limite da validação: PGlite é PostgreSQL embarcado, não a instância Supabase do usuário; transporte e permissões do Discord são simulados. A configuração real de rede, pooler, dados antigos e intents no serviço Render não foi acessada. O aviso genérico fornecido não revela qual SQLSTATE ocorreu em produção; esta versão corrige os defeitos encontrados no código e fornece a etapa/código se houver um problema externo ou dados incompatíveis no novo deploy.

---

## 27/09/2026 — timeout na conexão Discord

- Suíte completa executada: `node --test --test-concurrency=2`, **181 testes aprovados, zero falhas**.
- Dezenove testes da conexão: evento de prontidão, estado `isReady`, login ainda pendente, reconexão transitória, erros definitivos do Gateway, HTTP 401 com código de API zero, limites de requisições, timeout, limpeza de timers/listeners e ausência de segredos nos logs.
- Integração com `createBot.start` validada usando o Client real com transporte simulado; `BOT_ENABLED=false` continua dispensando o login.
- Bot e instalador compartilham a rotina de conexão. Espera Discord ajustada de 35 para 90 segundos e limite global de ambos para 180 segundos. Erros `shardError` de autenticação e intents agora produzem orientação específica imediatamente.
- Sintaxe de `discord-connection.js`, `bot.js`, `server.js` e `setup-server.js` conferida. README e tutorial atualizados com os novos prazos e instruções de publicação.

Validação local, com banco e transporte Discord simulados. O log fornecido comprova o timeout da versão anterior, mas não identifica sozinho sua causa externa. Não foi feito deploy nem acesso à instância Render; os novos registros de conexão permitem identificar a etapa caso a falha persista após publicar.

---

## 27/09/2026 — botões, Sub líder, tutorial e High member

- Suíte completa executada com processos isolados: `node --test --test-concurrency=2`, **162 testes aprovados, zero falhas**.
- Nove regressões dos botões: abertura imediata dos modais, confirmação/cancelamento na mensagem original, intervalos independentes por divisão/token, ticket preservado se a resposta expira, recuperação da mensagem e botão após rollback, ID de fechamento inválido, autorização de administrador Discord e fechamento sem duplicar jobs.
- Startup identifica um Interactions Endpoint URL que desvia cliques do Gateway. Logs registram chegada de interação, estado do bot e reconexões, sem token ou conteúdo enviado no formulário.
- Nove testes da patente Sub líder: acesso completo, IFJs de terceiros, gestão de equipe, `/warn`, tribunal, migração e tutorial persistente com autenticação e CSRF. Treze testes da interface para Meu Discord, navegação, tutorial por patente e acesso completo do Sub líder.
- High member recebe Equipe nas duas divisões; testadas remoção por rebaixamento/revogação e preservação de cargos não gerenciados.
- Edge headless real com API simulada: tutorial Sub líder no desktop, dez categorias administrativas, seletor de nova patente, tutorial concluído sem reaparecer no reload; tutorial e vínculo obrigatório de moderador/recrutador em tela de 390 px. Sem erros JavaScript ou transbordamento horizontal.
- Capturas com contas fictícias: `../EXEMPLOS/boas-vindas-sublider.png` e `../EXEMPLOS/boas-vindas-moderador-mobile.png`.

Não foi fornecido endereço ou acesso à instância Render. O timeout geral relatado não foi reproduzido no servidor publicado; os defeitos locais foram corrigidos e foram adicionadas verificações e registros para identificar se os cliques chegam ao bot. Nenhum deploy, clique em bot de produção ou mudança em contas Discord reais foi realizado.

---

## 27/09/2026 — tribunal, Meu Discord e embeds

- Suíte completa: `node --test --test-concurrency=2`, **135 testes aprovados, zero falhas**.
- Sintaxe dos módulos de tribunal, API, bot e painel aprovada.
- Tribunal: 16 testes do módulo e 7 de integração API/bot com PGlite e Discord simulado. Validados autenticação, patente, CSRF, vínculo confirmado, identidade original, migração repetida, criação única, permissões privadas, convites, erros e nova tentativa, recuperação após falha, encerramento e preservação do canal.
- Fechamento bloqueia mensagens, threads, gerenciamento de mensagens e webhooks dos participantes comuns. Administradores nativos do Discord mantêm suas permissões.
- Meu Discord: seis testes de regressão para estado confirmado, troca opcional, navegação, primeiro vínculo obrigatório e respostas atrasadas.
- Embeds: serialização, campos de até 1.024 caracteres, orçamento total de 6.000 caracteres, preservação do texto integral em anexo, identidade e atualização dos painéis existentes.
- Navegador Edge real em modo headless, com API simulada: fluxo de abrir/concluir tribunal; Discord confirmado; troca opcional; navegação por categorias; confirmação inicial do moderador. Desktop 1440 px e celular 390 px, sem erros JavaScript e sem transbordamento horizontal.
- Capturas locais em `../EXEMPLOS/tribunal-painel.png`, `../EXEMPLOS/tribunal-mobile.png` e `../EXEMPLOS/discord-confirmado.png`, com dados fictícios.

Não houve implantação nem envio para servidores Discord reais. A migração e a atualização dos painéis permanentes serão executadas ao iniciar esta versão no ambiente configurado.

---

Verificado em 20/09/2026.

- `npm test`: 25 testes aprovados, sem falhas.
- `npm run check`: sintaxe dos módulos de entrada, bot e painel aprovada.
- Processo real com configuração inválida: encerrou com código 1, sem anunciar servidor pronto e sem imprimir o segredo usado no teste.
- Testes de falha em sistema, conexão PostgreSQL, esquema, escrita/leitura, login Discord e permissões: nenhum abriu o listener HTTP; recursos criados foram encerrados.
- Sucesso: listener aberto somente após os testes, fila ativada por último.
- BOT_ENABLED=false: Discord explicitamente dispensado, apenas painel iniciado.
- PostgreSQL embarcado (PGlite): leitura/escrita com rollback deixou zero registros de teste.
- Checks Discord usam simulação: hierarquia e tipo incorreto de canal foram rejeitados sem publicar mensagens.
- Chromium: assistente percorreu 29 etapas, validou URL inválida, realizou 30 gravações por um handle de arquivo simulado, gerou download com conteúdo compatível com o parser .env do Node e importou os valores novamente.
- Assistente: falha de escrita e navegador sem seletor de arquivos tratados sem alegar salvamento. Layout móvel conferido sem transbordamento horizontal.
- O nome do download pode ser ajustado pelo navegador (ex.: env.txt); o aplicativo orienta renomear para .env. A gravação direta depende do seletor e da permissão do navegador real.

Os 10 testes anteriores de autenticação, permissões, IFJ, denúncias, filas e tickets continuam aprovados.

Não executado: conexão aos servidores Discord reais do usuário, implantação Render/Supabase ou diálogo nativo de gravação do sistema operacional. São necessários seus tokens, banco e IDs para essas verificações. O preflight real roda automaticamente quando você iniciar o projeto configurado.


Atualização Caçados/Guerras/carteiras: 84 testes automatizados aprovados. Navegador: upload real de arquivo local, prévia, criação de quatro jobs (dois caçados e duas guerras), viewport de 390 pixels sem overflow e sem erros JavaScript. PNGs dos dois tipos renderizados e inspecionados. Discord e banco de produção não acessados.
