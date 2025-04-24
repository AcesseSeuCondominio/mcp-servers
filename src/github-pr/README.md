# GitHub PR Search & Analysis MCP

Este MCP (Model Context Protocol) permite pesquisar e analisar Pull Requests do GitHub.

## Funcionalidades

- Pesquisar PRs por nome em repositórios da organização
- Analisar código e regras de negócio de PRs usando gpt-4o-mini
- Suporte a variáveis de ambiente para configuração

## Requisitos

- Node.js 18+
- Token de acesso ao GitHub com permissões adequadas
- Chave de API para o modelo gpt-4o-mini

## Configuração

Configure as seguintes variáveis de ambiente:

```
GITHUB_TOKEN=seu_token_github
OPENAI_API_KEY=sua_chave_api
GITHUB_ORG=sua_organizacao
```

Você pode criar um arquivo `.env` na raiz do projeto, baseado no arquivo `.env.example` fornecido:

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

1. `searchPullRequests` - Pesquisa PRs pelo nome nos repositórios da organização
2. `analyzePullRequest` - Analisa o código, regras de negócio e outros aspectos de um PR específico
3. `pr` - Pesquisa e analisa um PR pelo ID (por exemplo, ASCP-123)

## Exemplos

### Pesquisar PRs

```
Quero encontrar PRs relacionados a "feature login"
```

### Analisar PR

```
Analise o PR #123 do repositório "meu-repo" para entender as mudanças de regras de negócio
```

### Buscar por ID

```
Analise o PR com ID "ASCP-123"
```

## Uso via CLI

O MCP também pode ser usado como uma ferramenta de linha de comando:

```bash
# Pesquisar PRs
node dist/index.js searchPullRequests "feature login" 5

# Analisar PR
node dist/index.js analyzePullRequest "meu-repo" 123 "código"

# Buscar por ID
node dist/index.js pr "ASCP-123" --repo "meu-repo"
```

## Desenvolvimento

```bash
npm run watch
``` 