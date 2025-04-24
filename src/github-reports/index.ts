#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import OpenAI from "openai";

// Esquemas Zod para validação de parâmetros
const getOrganizationReportSchema = z.object({
  time_period: z.enum(["hoje", "ontem", "semana", "mês"]).default("hoje")
    .describe("Período de tempo para o relatório (hoje, ontem, semana, mês)"),
  limit: z.number().optional().default(10)
    .describe("Número máximo de repositórios a incluir no relatório")
});

const getRepositoryReportSchema = z.object({
  repo: z.string()
    .describe("Nome do repositório para gerar o relatório"),
  time_period: z.enum(["hoje", "ontem", "semana", "mês"]).default("hoje")
    .describe("Período de tempo para o relatório (hoje, ontem, semana, mês)")
});

const getUserActivitySchema = z.object({
  username: z.string()
    .describe("Nome de usuário do GitHub para gerar relatório de atividade"),
  time_period: z.enum(["hoje", "ontem", "semana", "mês"]).default("semana")
    .describe("Período de tempo para o relatório (hoje, ontem, semana, mês)")
});

// Tipos do Zod
type GetOrganizationReportParams = z.infer<typeof getOrganizationReportSchema>;
type GetRepositoryReportParams = z.infer<typeof getRepositoryReportSchema>;
type GetUserActivityParams = z.infer<typeof getUserActivitySchema>;

// Criar instância do servidor MCP
const mcpServer = new McpServer({
  name: "github-reports",
  version: "0.0.1",
  capabilities: {
    resources: {},
    tools: {},
  },
});

// Verificar variáveis de ambiente necessárias
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
if (!GITHUB_TOKEN) {
  console.error("Error: GITHUB_TOKEN environment variable is required");
  process.exit(1);
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
if (!OPENAI_API_KEY) {
  console.error("Error: OPENAI_API_KEY environment variable is required");
  process.exit(1);
}

const GITHUB_ORG = process.env.GITHUB_ORG || process.env.GITHUB_ORGANIZATION || "";
if (!GITHUB_ORG) {
  console.error("Error: GITHUB_ORG or GITHUB_ORGANIZATION environment variable is required");
  process.exit(1);
}

// Classe para o cliente GitHub
class GitHubClient {
  private headers: { Authorization: string; Accept: string };
  private organization: string;

  constructor(token: string, organization: string) {
    this.headers = {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
    };
    this.organization = organization;
  }

  async getOrganizationRepositories(limit: number = 10): Promise<any> {
    const url = `https://api.github.com/orgs/${this.organization}/repos?per_page=${limit}&sort=updated`;
    const response = await this.fetchWithTimeout(url, { headers: this.headers });
    const data = await response.json();
    
    return data.map((repo: any) => ({
      name: repo.name,
      full_name: repo.full_name,
      html_url: repo.html_url,
      description: repo.description,
      updated_at: repo.updated_at,
      pushed_at: repo.pushed_at,
      language: repo.language,
      stargazers_count: repo.stargazers_count,
      forks_count: repo.forks_count
    }));
  }

  async getRepositoryCommits(repo: string, since?: string): Promise<any> {
    let url = `https://api.github.com/repos/${this.organization}/${repo}/commits?per_page=100`;
    if (since) {
      url += `&since=${since}`;
    }
    
    const response = await this.fetchWithTimeout(url, { headers: this.headers });
    const data = await response.json();

    return Array.isArray(data) ? data.map((commit: any) => ({
      sha: commit.sha,
      message: commit.commit.message,
      author: commit.commit.author.name,
      author_email: commit.commit.author.email,
      date: commit.commit.author.date,
      html_url: commit.html_url
    })) : [];
  }

  async getRepositoryPullRequests(repo: string, state: string = "all"): Promise<any> {
    const url = `https://api.github.com/repos/${this.organization}/${repo}/pulls?state=${state}&per_page=100`;
    const response = await this.fetchWithTimeout(url, { headers: this.headers });
    const data = await response.json();

    return Array.isArray(data) ? data.map((pr: any) => ({
      number: pr.number,
      title: pr.title,
      user: pr.user.login,
      state: pr.state,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      closed_at: pr.closed_at,
      merged_at: pr.merged_at,
      html_url: pr.html_url
    })) : [];
  }

  async getPullRequestReviews(repo: string, prNumber: number): Promise<any> {
    const url = `https://api.github.com/repos/${this.organization}/${repo}/pulls/${prNumber}/reviews`;
    const response = await this.fetchWithTimeout(url, { headers: this.headers });
    const data = await response.json();

    return Array.isArray(data) ? data.map((review: any) => ({
      user: review.user.login,
      state: review.state,
      submitted_at: review.submitted_at,
      html_url: review.html_url
    })) : [];
  }

  async getIssueComments(repo: string, issueNumber: number): Promise<any> {
    const url = `https://api.github.com/repos/${this.organization}/${repo}/issues/${issueNumber}/comments`;
    const response = await this.fetchWithTimeout(url, { headers: this.headers });
    const data = await response.json();

    return Array.isArray(data) ? data.map((comment: any) => ({
      user: comment.user.login,
      created_at: comment.created_at,
      updated_at: comment.updated_at,
      body: comment.body
    })) : [];
  }

  async getUserActivity(username: string, since?: string): Promise<any> {
    const searchQuery = encodeURIComponent(`author:${username} org:${this.organization}`);
    let url = `https://api.github.com/search/issues?q=${searchQuery}&per_page=100`;
    
    const response = await this.fetchWithTimeout(url, { headers: this.headers });
    const data = await response.json();

    const activities = [];
    
    if (data.items && Array.isArray(data.items)) {
      for (const item of data.items) {
        // Verificar se o item está dentro do período 'since'
        if (since && new Date(item.updated_at) < new Date(since)) {
          continue;
        }
        
        const activity = {
          type: item.pull_request ? "pull_request" : "issue",
          number: item.number,
          title: item.title,
          repo: item.repository_url.split('/').pop(),
          state: item.state,
          created_at: item.created_at,
          updated_at: item.updated_at,
          html_url: item.html_url
        };
        
        activities.push(activity);
      }
    }
    
    return activities;
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit = {},
    timeout: number = 15000
  ): Promise<Response> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      
      // Verificar se há rate limit
      const rateLimitRemaining = response.headers.get("X-RateLimit-Remaining");
      if (rateLimitRemaining && parseInt(rateLimitRemaining) < 10) {
        console.warn(`GitHub API rate limit warning: ${rateLimitRemaining} requests remaining`);
      }
      
      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }
      
      return response;
    } finally {
      clearTimeout(id);
    }
  }
}

// Classe para gerar relatórios usando IA
class ReportAnalyzer {
  private openai: OpenAI;
  
  constructor(apiKey: string) {
    this.openai = new OpenAI({
      apiKey: apiKey
    });
  }
  
  async analyzeOrganizationActivity(
    repos: any[],
    repoDetails: Record<string, any>,
    timePeriod: string
  ): Promise<string> {
    const contextData = {
      timePeriod,
      organization: GITHUB_ORG,
      repositories: repos.map(repo => {
        const details = repoDetails[repo.name] || {};
        return {
          name: repo.name,
          description: repo.description,
          lastUpdate: repo.updated_at,
          language: repo.language,
          activity: {
            commits: details.commits || [],
            pullRequests: details.pullRequests || [],
          }
        };
      })
    };

    const completion = await this.openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Você é um assistente especializado em analisar atividades de repositórios GitHub e gerar relatórios informativos e úteis para equipes de desenvolvimento." },
        { role: "user", content: `Gere um relatório de atividade para a organização ${GITHUB_ORG} no período: ${timePeriod}. Analise os dados a seguir e destaque informações relevantes como: repositórios mais ativos, principais contribuidores, tendências de atividade, e quaisquer insights importantes. Formate o relatório de maneira clara e organize as informações por repositório. Dados:\n${JSON.stringify(contextData, null, 2)}` }
      ],
      temperature: 0.3,
      max_tokens: 3000,
    });

    return completion.choices[0].message.content || "Não foi possível gerar análise.";
  }
  
  async analyzeRepositoryActivity(
    repo: any,
    commits: any[],
    pullRequests: any[],
    timePeriod: string
  ): Promise<string> {
    // Obtenha mais detalhes para cada PR (comentários, revisões)
    const prDetails = [];
    for (const pr of pullRequests.slice(0, 5)) { // Limite para evitar muitas requisições
      const details = {
        ...pr,
        reviews: [], // Será preenchido se implementarmos a busca por reviews
        comments: [] // Será preenchido se implementarmos a busca por comentários
      };
      prDetails.push(details);
    }

    const contextData = {
      timePeriod,
      repository: repo.name,
      description: repo.description,
      language: repo.language,
      lastUpdate: repo.updated_at,
      commits: commits,
      pullRequests: prDetails
    };

    const completion = await this.openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Você é um assistente especializado em analisar atividades de repositórios GitHub e gerar relatórios informativos e úteis para equipes de desenvolvimento." },
        { role: "user", content: `Gere um relatório detalhado de atividade para o repositório ${repo.name} no período: ${timePeriod}. Analise os dados a seguir e destaque informações como: padrões nos commits, PRs abertos e fechados, principais contribuidores, velocidade de revisão de código, e quaisquer insights úteis para a equipe. Formate o relatório de maneira clara e organizada. Dados:\n${JSON.stringify(contextData, null, 2)}` }
      ],
      temperature: 0.3,
      max_tokens: 3000,
    });

    return completion.choices[0].message.content || "Não foi possível gerar análise.";
  }

  async analyzeUserActivity(
    username: string,
    activities: any[],
    timePeriod: string
  ): Promise<string> {
    const contextData = {
      username,
      timePeriod,
      activities: activities.map(activity => ({
        type: activity.type,
        repo: activity.repo,
        title: activity.title,
        state: activity.state,
        created_at: activity.created_at,
        updated_at: activity.updated_at,
        url: activity.html_url
      }))
    };

    const completion = await this.openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Você é um assistente especializado em analisar atividades de desenvolvedores no GitHub e gerar relatórios informativos e úteis." },
        { role: "user", content: `Gere um relatório de atividade para o usuário ${username} no período: ${timePeriod}. Analise os dados a seguir e destaque informações como: repositórios em que mais contribuiu, tipos de contribuições (PRs, issues), frequência de atividade, e quaisquer padrões interessantes. Formate o relatório de maneira clara e organizada. Dados:\n${JSON.stringify(contextData, null, 2)}` }
      ],
      temperature: 0.3,
      max_tokens: 3000,
    });

    return completion.choices[0].message.content || "Não foi possível gerar análise.";
  }
}

// Calcular data de início com base no período
function getStartDate(timePeriod: string): string {
  const date = new Date();
  
  switch (timePeriod) {
    case "hoje":
      date.setHours(0, 0, 0, 0);
      break;
    case "ontem":
      date.setDate(date.getDate() - 1);
      date.setHours(0, 0, 0, 0);
      break;
    case "semana":
      date.setDate(date.getDate() - 7);
      break;
    case "mês":
      date.setMonth(date.getMonth() - 1);
      break;
    default:
      date.setHours(0, 0, 0, 0); // Padrão: hoje
  }
  
  return date.toISOString();
}

// Função principal para gerar relatório da organização
async function getOrganizationReport(params: GetOrganizationReportParams): Promise<string> {
  const { time_period, limit } = params;
  const startDate = getStartDate(time_period);
  
  const githubClient = new GitHubClient(GITHUB_TOKEN, GITHUB_ORG);
  const analyzer = new ReportAnalyzer(OPENAI_API_KEY);
  
  try {
    // Obter lista de repositórios da organização
    const repos = await githubClient.getOrganizationRepositories(limit);
    
    // Para cada repositório, obter commits e PRs recentes
    const repoDetails: Record<string, any> = {};
    
    for (const repo of repos) {
      // Obter commits recentes
      const commits = await githubClient.getRepositoryCommits(repo.name, startDate);
      
      // Obter PRs recentes (consideramos todos os PRs com atividade no período)
      const pullRequests = await githubClient.getRepositoryPullRequests(repo.name);
      const recentPRs = pullRequests.filter((pr: any) => 
        new Date(pr.updated_at) >= new Date(startDate)
      );
      
      repoDetails[repo.name] = {
        commits,
        pullRequests: recentPRs
      };
    }
    
    // Gerar relatório usando IA
    return await analyzer.analyzeOrganizationActivity(repos, repoDetails, time_period);
    
  } catch (error) {
    console.error("Erro ao gerar relatório da organização:", error);
    return `Ocorreu um erro ao gerar o relatório da organização: ${error}`;
  }
}

// Função para gerar relatório de um repositório específico
async function getRepositoryReport(params: GetRepositoryReportParams): Promise<string> {
  const { repo, time_period } = params;
  const startDate = getStartDate(time_period);
  
  const githubClient = new GitHubClient(GITHUB_TOKEN, GITHUB_ORG);
  const analyzer = new ReportAnalyzer(OPENAI_API_KEY);
  
  try {
    // Obter detalhes do repositório
    const repos = await githubClient.getOrganizationRepositories(100);
    const repository = repos.find((r: any) => r.name === repo);
    
    if (!repository) {
      return `Repositório ${repo} não encontrado na organização ${GITHUB_ORG}`;
    }
    
    // Obter commits recentes
    const commits = await githubClient.getRepositoryCommits(repo, startDate);
    
    // Obter PRs recentes
    const pullRequests = await githubClient.getRepositoryPullRequests(repo);
    const recentPRs = pullRequests.filter((pr: any) => 
      new Date(pr.updated_at) >= new Date(startDate)
    );
    
    // Gerar relatório usando IA
    return await analyzer.analyzeRepositoryActivity(
      repository,
      commits,
      recentPRs,
      time_period
    );
    
  } catch (error) {
    console.error(`Erro ao gerar relatório do repositório ${repo}:`, error);
    return `Ocorreu um erro ao gerar o relatório do repositório ${repo}: ${error}`;
  }
}

// Função para gerar relatório de atividade de um usuário
async function getUserActivity(params: GetUserActivityParams): Promise<string> {
  const { username, time_period } = params;
  const startDate = getStartDate(time_period);
  
  const githubClient = new GitHubClient(GITHUB_TOKEN, GITHUB_ORG);
  const analyzer = new ReportAnalyzer(OPENAI_API_KEY);
  
  try {
    // Obter atividades do usuário
    const activities = await githubClient.getUserActivity(username, startDate);
    
    // Gerar relatório usando IA
    return await analyzer.analyzeUserActivity(
      username,
      activities,
      time_period
    );
    
  } catch (error) {
    console.error(`Erro ao gerar relatório de atividade do usuário ${username}:`, error);
    return `Ocorreu um erro ao gerar o relatório de atividade do usuário ${username}: ${error}`;
  }
}

// Registrar operações no MCP
mcpServer.tool(
  "getOrganizationReport",
  "Gera um relatório de atividade da organização GitHub",
  getOrganizationReportSchema.shape,
  async (params: GetOrganizationReportParams) => {
    try {
      const result = await getOrganizationReport(params);
      return {
        content: [{ type: "text", text: result }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true
      };
    }
  }
);

mcpServer.tool(
  "getRepositoryReport",
  "Gera um relatório de atividade para um repositório específico",
  getRepositoryReportSchema.shape,
  async (params: GetRepositoryReportParams) => {
    try {
      const result = await getRepositoryReport(params);
      return {
        content: [{ type: "text", text: result }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true
      };
    }
  }
);

mcpServer.tool(
  "getUserActivity",
  "Gera um relatório de atividade de um usuário específico",
  getUserActivitySchema.shape,
  async (params: GetUserActivityParams) => {
    try {
      const result = await getUserActivity(params);
      return {
        content: [{ type: "text", text: result }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true
      };
    }
  }
);

// CLI de linha de comando para testes
async function handleCliCommands() {
  const args = process.argv.slice(2);
  if (args.length === 0) return false;

  try {
    switch (args[0]) {
      case "org":
        const timePeriod = args[1] || "hoje";
        const limit = parseInt(args[2] || "10");
        console.log(await getOrganizationReport({ time_period: timePeriod as any, limit }));
        return true;
      
      case "repo":
        if (!args[1]) throw new Error("Repository name is required");
        const repoTimePeriod = args[2] || "hoje";
        console.log(await getRepositoryReport({ repo: args[1], time_period: repoTimePeriod as any }));
        return true;
      
      case "user":
        if (!args[1]) throw new Error("Username is required");
        const userTimePeriod = args[2] || "semana";
        console.log(await getUserActivity({ username: args[1], time_period: userTimePeriod as any }));
        return true;
      
      default:
        return false;
    }
  } catch (error) {
    console.error("CLI Error:", error);
    return true;
  }
}

// Função principal
async function main() {
  // Verificar se foi chamado pela linha de comando
  const handledByCli = await handleCliCommands();
  if (handledByCli) return;
  
  // Iniciar servidor MCP
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  
  console.error("GitHub Reports MCP Server started");
}

main().catch(console.error); 