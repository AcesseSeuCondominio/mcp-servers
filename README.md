# MCP Servers

Servidores Model Context Protocol (MCP) que estendem as capacidades do Claude com integrações externas.

## O que é MCP?

O MCP permite que assistentes de IA como o Claude interajam com ferramentas e serviços externos através de interfaces padronizadas. Baseado no [Model Context Protocol](https://github.com/anthropics/model-context-protocol) da Anthropic.

## Servidores Disponíveis

| Servidor | Descrição | Pacote NPM |
|----------|-----------|------------|
| Brave Search | Pesquisa web usando a API Brave Search | [@acesseseucondominio/brave-search](https://www.npmjs.com/package/@acesseseucondominio/brave-search) |
| GitHub PR | Integração com Pull Requests do GitHub | [@acesseseucondominio/github-pr](https://www.npmjs.com/package/@acesseseucondominio/github-pr) |
| Jira Task Summarizer | Resumo e análise de tarefas do Jira | [@acesseseucondominio/jira-task-summarizer](https://www.npmjs.com/package/@acesseseucondominio/jira-task-summarizer) |

## Comandos

```bash
# Construir todos os servidores
npm run build

# Desenvolver com atualização automática
npm run watch

# Publicar todos os pacotes
npm run publish-all
```

## Licença

MIT License 