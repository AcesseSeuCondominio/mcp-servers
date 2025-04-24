# GitHub Reports MCP

Este MCP (Model Context Protocol) gera relatórios sobre atividades em repositórios GitHub de uma organização. Ele analisa commits, pull requests e outras atividades para fornecer insights valiosos sobre o andamento dos projetos.

## Operações

### getOrganizationReport
Gera um relatório da atividade de toda a organização.

Parâmetros:
- `time_period`: Período de tempo para o relatório ("hoje", "ontem", "semana", "mês")
- `limit`: Número máximo de repositórios a incluir no relatório (padrão: 10)

### getRepositoryReport
Gera um relatório detalhado da atividade de um repositório específico.

Parâmetros:
- `repo`: Nome do repositório para gerar o relatório
- `time_period`: Período de tempo para o relatório ("hoje", "ontem", "semana", "mês")

### getUserActivity
Gera um relatório da atividade de um usuário específico na organização.

Parâmetros:
- `username`: Nome de usuário do GitHub para gerar relatório de atividade
- `time_period`: Período de tempo para o relatório ("hoje", "ontem", "semana", "mês")

## Configuração

Variáveis de ambiente necessárias:
- `GITHUB_TOKEN`: Token de acesso à API do GitHub
- `GITHUB_ORG` ou `GITHUB_ORGANIZATION`: Nome da organização GitHub
- `OPENAI_API_KEY`: Chave de API do OpenAI para análise dos dados

## Uso via CLI

Para testes, você pode usar a interface de linha de comando:

```bash
# Relatório da organização
node index.js org [período] [limite]

# Relatório de um repositório
node index.js repo [nome-do-repo] [período]

# Atividade de um usuário
node index.js user [nome-do-usuário] [período]
```

Exemplo:
```bash
node index.js org semana 5
node index.js repo meu-projeto hoje
node index.js user johndoe semana
```

## Instalação

```bash
cd src/github-reports
npm install
``` 