# Jira Task Summarizer MCP

Este MCP (Model Context Protocol) resume e analisa tarefas do Jira para ajudar desenvolvedores a compreender melhor seu trabalho.

## Funcionalidades

- Resumir subtasks do Jira com contexto da história e épico
- Analisar bugs e problemas para gerar planos de ação
- Oferecer guias práticos de como iniciar o desenvolvimento
- Integração completa com a API do Jira

## Requisitos

- Node.js 18+
- Acesso a uma instância do Jira
- Chave de API OpenAI para geração de resumos

## Configuração

Configure as seguintes variáveis de ambiente:

```
JIRA_HOST=seu_host_jira (ex: your-company.atlassian.net)
JIRA_USERNAME=seu_email
JIRA_API_TOKEN=seu_token_api_jira
OPENAI_API_KEY=sua_chave_api
```

Você pode criar um arquivo `.env` na raiz do projeto:

```bash
cp .env.example .env
# Edite o arquivo .env com suas credenciais
```

## Instalação

```bash
npm install
npm run build
```

## Uso

Este MCP expõe três ferramentas principais:

1. `summarizeTask` - Resume uma tarefa específica do Jira com todo o contexto relacionado
2. `analyzeIssue` - Analisa profundamente um problema ou bug para entender causa e solução
3. `generateDevPlan` - Cria um guia passo a passo para implementar a tarefa

## Exemplos

### Resumir uma tarefa

```
Preciso entender melhor a tarefa PROJ-123
```

### Analisar um bug

```
Ajude-me a entender como resolver o bug PROJ-456
```

### Gerar plano de desenvolvimento

```
Crie um plano para implementar a feature PROJ-789
```

## Uso via CLI

O MCP também pode ser usado como uma ferramenta de linha de comando:

```bash
# Resumir tarefa
node dist/index.js summarizeTask PROJ-123

# Analisar bug
node dist/index.js analyzeIssue PROJ-456

# Gerar plano de desenvolvimento
node dist/index.js generateDevPlan PROJ-789
```

## Desenvolvimento

```bash
npm run watch
```

## Licença

Este projeto está licenciado sob a Licença MIT. 