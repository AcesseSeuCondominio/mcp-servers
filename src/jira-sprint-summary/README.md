# Jira Sprint Summary

MCP Server para resumir sprints e listar tarefas de usuários no Jira.

## Funcionalidades

- Resumo da sprint atual em andamento
- Listar tarefas atribuídas a um usuário específico na sprint atual
- Análise do progresso da sprint

## Instalação

```bash
npm install -g @acesseseucondominio/jira-sprint-summary
```

## Configuração

Este MCP Server requer as seguintes variáveis de ambiente:

- `JIRA_HOST`: Host do Jira (exemplo: seudominio.atlassian.net)
- `JIRA_USERNAME`: Nome de usuário do Jira (normalmente seu e-mail)
- `JIRA_API_TOKEN`: Token de API do Jira
- `OPENAI_API_KEY`: Chave de API da OpenAI
- `JIRA_PROJECT_KEY`: Chave do projeto no Jira (exemplo: PROJ)
- `JIRA_BOARD_ID`: ID do quadro no Jira (opcional)

## Uso

Você pode usar este MCP através da Claude ou ChatGPT com plugins MCP habilitados.

### Exemplos de comandos:

- "Resumo da sprint atual"
- "Liste as tarefas do usuário [nome do usuário]"
- "Qual o progresso da sprint atual?"

## Desenvolvimento

1. Clone o repositório
2. Instale as dependências: `npm install`
3. Compile o código: `npm run build`
4. Execute o servidor: `node dist/index.js`

## Licença

MIT 