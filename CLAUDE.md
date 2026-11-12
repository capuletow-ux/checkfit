# CheckFit — contexto do projeto (para continuar em outra conversa)

Atualizado em 12/11/2026, versão 50 do app.

## Quem sou e como trabalho
- **Quem:** Alexandre (pt-BR). Uso iPhone e não sou programador. Respostas em português, diretas, com passo a passo quando eu precisar mexer em algo.
- **Como atualizo o app:** subo os arquivos pelo GitHub (site, pelo celular). Sempre me entregue os arquivos prontos (`index.html`, `teste.html`, `regras-firebase.txt`, `functions/index.js`), sem trechos para eu colar.
- **Segurança:** nunca peça nem aceite a chave da Anthropic ou o JSON da conta de serviço do Firebase. Eu colo esses dados só nos Secrets do GitHub.
- **Prints:** antes de pedir, lembre de cobrir dados pessoais (CPF, endereço).

## O que é
O CheckFit é um app (PWA) de checklist diário de saúde: plano alimentar, água, peso, treinos (musculação com ficha e cardio), suplementos e remédios, medidas e bioimpedância, diário "Minha Jornada", desafios em grupo e notificações.
- **Público:** quem tem nutricionista/personal e quem quer montar o próprio plano. Também tem o modo "hábitos", para quem não tem dieta.
- **Modelo de cobrança:** assinatura mensal paga pelo usuário.
- **Liberação de acesso:** por enquanto é manual (o cliente fala comigo). O pagamento automático foi adiado de propósito.

## Onde está tudo
- **Site:** https://checkfitapp.com.br (publicado pelo GitHub Pages).
- **Código:** repositório GitHub `checkfitapp/checkfit`.
  - `index.html`: o app inteiro em um arquivo só (HTML, CSS e JS, cerca de 5.500 linhas).
  - `teste.html`: cópia idêntica, usada para testes.
  - `sw.js` e `manifest.webmanifest`: PWA e notificações.
  - `functions/index.js` e `functions/package.json`: servidor (Cloud Functions).
  - `.github/workflows/deploy-servidor.yaml`: publica o servidor sozinho a cada alteração em `functions/`. Secrets usados: `FIREBASE_SERVICE_ACCOUNT` e `ANTHROPIC_API_KEY`. A chave fica no Secret Manager.
- **Firebase:** projeto `dieta-alexandre`, plano Blaze.
  - Usa o SDK compat 10.12.2 (app, auth, firestore, messaging).
  - Persistência offline ligada.
  - As regras do Firestore são coladas à mão no console (arquivo `regras-firebase.txt`).
- **Contas e admins:** os e-mails de admin estão definidos nas regras do Firestore (`isAdmin()`).
- **IA para ler planos e fichas:** conta da Anthropic com créditos pré-pagos.

## Como o app é organizado (index.html)
- **Estado global:** `S` (`S.user`, `S.db` = `users/{uid}`, `S.days`, `S.prof`, `S.date`, `S.mode`, `S.tab`). Ação principal: `render()`.
- **Cliques:** passam por `data-act="..."` em um único `document.addEventListener('click')`. Módulos novos usam o padrão `if(/^xxx/.test(a) && xxxAct(a,b)) return;`.
- **Módulos novos:** ficam antes do comentário `/* ---------- Treino de musculação: ficha, modo treinar, descanso, recordes ---------- */`.
- **Salvar o dia:** `save(date)` carimba `_t`, guarda uma cópia no aparelho (`cofreGuardar`, no localStorage `cf-cofre-{uid}`) e envia depois de 450 ms (`cofreEnviar`, que faz `set` do documento inteiro).
  - Ao ler do servidor, `cofreConferir` restaura e reenvia a cópia local se ela for mais nova.
  - Ao sair do app, `cofreDescarregar` envia na hora.
  - O aviso "Enviando… / Sem internet" fica em `#syncpill`.
- **Leitura dos dados:** `diasBind` / `diasOuvir` ficam ouvindo os últimos 70 dias. Os dias antigos viram um resumo em `config/historico`.
- **iPhone instalado (PWA):**
  - `html.pwa` faz o `.wrap` virar o container de rolagem.
  - Depois que o teclado fecha, a tela é reposicionada.
  - A virada do dia é conferida ao voltar para o app (`viraDia`).
- **Relatórios:** `relView` (tela e versão completa para o PDF) usa `relDados()`, que calcula o período pelo `relPeriodo()` (`S.relPer` = 'sem' ou 'mes').
  - Tela com botões Semanal/Mensal e setas para trocar o período (`relPerAct`).
  - Imagem estilo infográfico de 1 página em canvas (`relImgGerar`, `relImgPrep`, `relImgBox`), com o mesmo visual do relatório de bioimpedância (helpers `IC`, `icT`, `icPanel`).
  - Na semana aparece o "Dia a dia"; no mês, um calendário colorido.
  - Destaques e próximos passos são gerados automaticamente (`relDestaques`, `relInsights`).
  - Entradas: cartão "Relatório da semana" na visão semanal (`relsem`) e "Relatório do mês" na visão mensal (`rel`).
- **Refeições:** ficam encolhidas (`mealCard`, `mealHead`, `mealDaVez`, `mealAct`). A refeição da hora abre sozinha. "Marcar tudo" ou "Pulei" fecham e passam para a próxima.

## Dados no Firestore
- `users/{uid}`:
  - `dias/{AAAA-MM-DD}`: meals, agua, peso, treinos, musc, cardio, tomas, med, bio, bem, `_t`;
  - `config/plano`, `config/treino` (origem: prof, proprio ou ia);
  - `config/perfil`, `config/historico`, `config/alimentos`, `config/ajustes`;
  - `diario/*`.
- `assinaturas/{uid}`: `ativoAte` ou `vitalicio`. A regra `ativo(uid)` libera a gravação.
- `lembretes/{uid}`: tokens de notificação, preferências, refeições, remédios, fuso, descanso.
- `iaUso/{uid}`: limite de 5 leituras por dia.
- Grupos:
  - `codigos/{CODIGO}` {gid, admin, nome};
  - `grupos/{gid}` {nome, codigo, admin, membros[]}, com as subcoleções `membros/{uid}`, `desafios/{did}/part/{uid}` e `mural/{mid}`.
  - Convite por link: `?g=CODIGO`.
- Outras coleções do painel de admin: `clientes`, `log`, `app`.
- **Atenção nas regras:** usar `$(db)` (não `$(database)`).

## Servidor (functions/index.js, Cloud Functions v2)
- `agendar` / `enviarAgendado`: aviso de fim do descanso.
- `testar`: notificação de teste.
- `lembretesTick`: roda a cada 15 min (refeições, água, peso, sequência, cartas, remédios).
- `lerPlano`: lê foto ou PDF do plano alimentar ou da ficha de treino com o Claude (modelo `claude-sonnet-5-5`, tools `salvar_plano`/`salvar_ficha`, max_tokens 32000, timeout de 540 s).
- `avisarDesafio`: avisa os membros do grupo sobre um desafio novo.
- **Como o app chama o servidor:** por `fetch` em `https://us-central1-dieta-alexandre.cloudfunctions.net/<nome>` com o token do usuário. Não usar o SDK de functions, porque ele quebra o service worker das notificações.

## O que já está pronto
Login e assinatura manual, plano da nutricionista (por texto ou leitura com IA), modo "monte o seu", modo hábitos, água, peso, medidas, bioimpedância, musculação com ficha (semanas e periodização, descanso, recordes, cartão de story), cardio, suplementos e remédios com estoque, notificações push, Minha Jornada com cartas para o futuro, grupos e desafios fase 1 (prontos, personalizado e perda de peso com ranking em %), refeições encolhidas, cópia de segurança do dia, relatório semanal e mensal em imagem e PDF.

## Pendências e próximos passos
1. Apagar os 2 grupos órfãos "Desafio teste" (Editar › Encerrar).
2. Área da nutricionista, versão mínima: só leitura, resumo semanal e mensal do paciente.
3. Depois: pagamento automático, grupos fase 2, lojas (App Store e Google Play).
4. Ideia em aberto: juntar as alterações quando o app for usado em dois aparelhos ao mesmo tempo (hoje vale a última gravação).
5. Ideia pequena: mostrar "500 ml 💧" em vez de "0 kcal" nas refeições só de água.

## Documentos já feitos (artefatos no Claude)
- Manual do CheckFit: https://claude.ai/artifact/AmcE5kqVTQVz9BkU52cpYD
- CheckFit para nutricionistas, argumento de venda: https://claude.ai/artifact/EeMww8fExA5PG1ijD688Qi

## Como testar antes de entregar
Pegue o `index.html` do repositório e teste com Playwright no Chromium, simulando um iPhone e trocando o Firebase por um stub em memória. Sempre confira se não há erros de JavaScript e mande prints das telas novas antes de eu subir.
