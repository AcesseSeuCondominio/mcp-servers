#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import OpenAI from "openai";

// Esquemas Zod para validação de parâmetros
const searchPullRequestsSchema = z.object({
  query: z.string()
    .describe("Nome ou parte do nome do Pull Request a ser pesquisado"),
  limit: z.number().optional().default(5)
    .describe("Número máximo de resultados a retornar (padrão: 5)")
});

const analyzePullRequestSchema = z.object({
  repo: z.string()
    .describe("Nome do repositório contendo o Pull Request"),
  pr_number: z.number()
    .describe("Número do Pull Request a ser analisado"),
  focus: z.enum(["código", "regras de negócio", "tudo"]).optional().default("tudo")
    .describe("Em quais aspectos focar a análise")
});

// Tipos do Zod
type SearchPullRequestsParams = z.infer<typeof searchPullRequestsSchema>;
type AnalyzePullRequestParams = z.infer<typeof analyzePullRequestSchema>;

// Criar instância do servidor MCP
const mcpServer = new McpServer({
  name: "github-pr",
  version: "0.0.3",
  capabilities: {
    resources: {},
    tools: {},
  },
});

// Verificar variáveis de ambiente necessárias
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  console.error("Error: GITHUB_TOKEN environment variable is required");
  process.exit(1);
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Error: OPENAI_API_KEY environment variable is required");
  process.exit(1);
}

const GITHUB_ORG = process.env.GITHUB_ORG || process.env.GITHUB_ORGANIZATION;
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

  async searchPullRequests(query: string, limit: number = 5): Promise<any> {
    // Construção da query de pesquisa do GitHub
    const searchQuery = encodeURIComponent(`${query} in:title org:${this.organization} is:pr`);
    const url = `https://api.github.com/search/issues?q=${searchQuery}&per_page=${limit}`;

    const response = await this.fetchWithTimeout(url, { headers: this.headers });
    const data = await response.json();

    // Formatando os resultados para retornar apenas os dados relevantes
    if (data.items && Array.isArray(data.items)) {
      return {
        total_count: data.total_count,
        items: data.items.map((item: any) => ({
          title: item.title,
          number: item.number,
          html_url: item.html_url,
          repository_url: item.repository_url,
          repository: item.repository_url.split('/').pop(),
          state: item.state,
          created_at: item.created_at,
          updated_at: item.updated_at,
          user: item.user.login
        }))
      };
    }

    return data;
  }

  async getPullRequestDetails(repo: string, prNumber: number): Promise<any> {
    const url = `https://api.github.com/repos/${this.organization}/${repo}/pulls/${prNumber}`;
    const response = await this.fetchWithTimeout(url, { headers: this.headers });
    return response.json();
  }

  async getPullRequestFiles(repo: string, prNumber: number): Promise<any> {
    const url = `https://api.github.com/repos/${this.organization}/${repo}/pulls/${prNumber}/files`;
    const response = await this.fetchWithTimeout(url, { headers: this.headers });
    return response.json();
  }

  async getPullRequestComments(repo: string, prNumber: number): Promise<any> {
    const url = `https://api.github.com/repos/${this.organization}/${repo}/pulls/${prNumber}/comments`;
    const response = await this.fetchWithTimeout(url, { headers: this.headers });
    return response.json();
  }

  async getFileContent(repo: string, path: string, ref: string): Promise<any> {
    const url = `https://api.github.com/repos/${this.organization}/${repo}/contents/${path}?ref=${ref}`;
    const response = await this.fetchWithTimeout(url, { headers: this.headers });
    const data = await response.json();
    
    if (data.content) {
      // O conteúdo vem codificado em base64
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
    
    return null;
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

// Classe para análise de código usando OpenAI
class CodeAnalyzer {
  private openai: OpenAI;
  
  constructor(apiKey: string) {
    this.openai = new OpenAI({
      apiKey: apiKey
    });
  }
  
  async analyzePullRequest(
    prDetails: any,
    files: any[],
    fileContents: Record<string, string>,
    focus: string
  ): Promise<string> {
    // Template para analisar o PR baseado no foco especificado
    let promptContent: string;
    
    // Construir um resumo dos arquivos alterados com suas estatísticas
    const filesSummary = files.map(file => {
      return `- **${file.filename}** (${file.status}, +${file.additions}/-${file.deletions} linhas)`
    }).join('\n');
    
    // Construir trechos de código com referências de arquivo e linha
    const codeSnippets = Object.entries(fileContents)
      .map(([filename, content]) => {
        // Dividir o conteúdo em linhas
        const lines = content.split('\n');
        
        // Para arquivos grandes, incluir apenas as linhas mais relevantes
        let relevantContent = content;
        if (lines.length > 100) {
          // Pegar os primeiros 30 linhas e os últimos 30 linhas
          const firstPart = lines.slice(0, 30).join('\n');
          const lastPart = lines.slice(-30).join('\n');
          relevantContent = `${firstPart}\n\n... (${lines.length - 60} linhas omitidas) ...\n\n${lastPart}`;
        }
        
        return `### Arquivo: ${filename}\n\n\`\`\`\n${relevantContent}\n\`\`\``;
      })
      .join('\n\n');
    
    if (focus === "código") {
      promptContent = `
      Você é um especialista em análise técnica de código e um crítico rigoroso de qualidade de código.
      Analise as alterações do seguinte Pull Request, fornecendo referências precisas de arquivos e linhas:
      
      Título: ${prDetails.title}
      Descrição: ${prDetails.body || "Sem descrição"}
      
      Alterações de arquivos:
      ${filesSummary}
      
      Conteúdo dos arquivos modificados:
      ${codeSnippets}
      
      Seja extremamente crítico na análise, não deixe passar código "feio" ou mal estruturado. Analise os aspectos mais relevantes, considerando:
      
      1. Legibilidade e qualidade do código:
         - Identifique código confuso, excessivamente complexo ou mal organizado
         - Critique variáveis mal nomeadas, funções muito longas ou difíceis de entender
         - Identifique estruturas de controle desnecessariamente complicadas
         - Aponte exatamente o arquivo e linhas onde há problemas
      
      2. Segurança:
         - Vulnerabilidades potenciais (injeção, XSS, problemas de autorização)
         - Manejo inadequado de dados sensíveis
         - Cite exemplos específicos com referência a arquivo e linhas
      
      3. Organização e estrutura:
         - Identifique responsabilidades mal definidas ou misturadas
         - Aponte problemas de acoplamento ou coesão
         - Sugira como o código deveria ser estruturado para melhor manutenção
         - Cite arquivos e linhas específicos
      
      4. Performance:
         - Identifique gargalos potenciais ou operações ineficientes
         - Aponte loops desnecessários, operações redundantes ou algoritmos ineficientes
         - Sugira otimizações específicas
         - Cite exemplos concretos com referência a arquivo e linhas
      
      5. Sugestão final:
         - Apresente uma recomendação concreta para melhorar o código como um todo
         - Seja direto sobre o que precisa ser corrigido para tornar o código de melhor qualidade
      
      Ao referenciar código, sempre use o formato "Arquivo: filename.ext (linhas X-Y)" para facilitar a localização.
      Inclua apenas os trechos mais relevantes, evitando análises extensas de código secundário.
      Não mencione ou avalie a documentação técnica.
      `;
    } else if (focus === "regras de negócio") {
      promptContent = `
      Você é um especialista em análise de regras de negócio em código e um crítico rigoroso de implementações.
      Analise as alterações do seguinte Pull Request, fornecendo referências precisas de arquivos e linhas:
      
      Título: ${prDetails.title}
      Descrição: ${prDetails.body || "Sem descrição"}
      
      Alterações de arquivos:
      ${filesSummary}
      
      Conteúdo dos arquivos modificados:
      ${codeSnippets}
      
      Seja extremamente crítico na análise, não deixe passar implementações confusas ou mal estruturadas. Analise os aspectos mais relevantes, considerando:
      
      1. Regras de negócio implementadas:
         - Identifique as principais regras de negócio adicionadas ou modificadas
         - Critique implementações confusas, excessivamente complexas ou que misturam responsabilidades
         - Aponte inconsistências ou lógica de negócio mal implementada
         - Cite arquivos e linhas específicos onde estão os problemas
      
      2. Fluxos de processos:
         - Critique fluxos de processo mal implementados ou difíceis de entender
         - Identifique falhas lógicas ou casos de borda não tratados
         - Aponte complexidade desnecessária ou falta de clareza
         - Cite exemplos específicos com referência a arquivo e linhas
      
      3. Validações e consistência:
         - Critique validações inadequadas, incompletas ou excessivas
         - Identifique inconsistências ou validações ausentes
         - Aponte como as validações deveriam ser implementadas
         - Cite arquivos e linhas específicos
      
      4. Integração com banco de dados:
         - Critique operações de banco de dados mal implementadas ou ineficientes
         - Identifique problemas de integridade, performance ou manutenção
         - Sugira como as operações deveriam ser implementadas corretamente
         - Cite exemplos concretos com referência a arquivo e linhas
      
      5. Sugestão final:
         - Apresente uma recomendação direta para corrigir os problemas identificados
         - Seja específico sobre o que precisa ser melhorado para implementar corretamente as regras de negócio
      
      Ao referenciar código, sempre use o formato "Arquivo: filename.ext (linhas X-Y)" para facilitar a localização.
      Inclua apenas os trechos mais relevantes para as regras de negócio, evitando análises extensas de código secundário.
      Não mencione ou avalie a documentação técnica.
      `;
    } else {
      promptContent = `
      Você é um especialista em análise técnica e de negócios de código e um crítico rigoroso de qualidade.
      Analise as alterações do seguinte Pull Request, fornecendo referências precisas de arquivos e linhas:
      
      Título: ${prDetails.title}
      Descrição: ${prDetails.body || "Sem descrição"}
      
      Alterações de arquivos:
      ${filesSummary}
      
      Conteúdo dos arquivos modificados:
      ${codeSnippets}
      
      Seja extremamente crítico na análise, não deixe passar código "feio", ilegível ou mal implementado. Analise os aspectos mais relevantes, considerando:
      
      1. Legibilidade e qualidade do código:
         - Critique código confuso, excessivamente complexo ou mal organizado
         - Identifique variáveis mal nomeadas, funções muito longas ou difíceis de entender
         - Aponte estruturas de controle desnecessariamente complicadas
         - Identifique falta de consistência no estilo ou abordagem
         - Aponte exatamente o arquivo e linhas onde há problemas
      
      2. Regras de negócio:
         - Critique implementações de regras de negócio confusas ou mal estruturadas
         - Identifique inconsistências ou lógica de negócio mal implementada
         - Aponte responsabilidades misturadas ou mal definidas
         - Cite arquivos e linhas específicos
      
      3. Segurança:
         - Identifique vulnerabilidades potenciais (injeção, XSS, problemas de autorização)
         - Critique manejo inadequado de dados sensíveis ou falhas de validação
         - Sugira como implementar corretamente aspectos de segurança
         - Cite exemplos específicos com referência a arquivo e linhas
      
      4. Estrutura e organização:
         - Critique organização confusa, responsabilidades mal definidas ou misturadas
         - Identifique problemas de acoplamento ou coesão
         - Sugira como o código deveria ser estruturado para melhor manutenção
         - Cite arquivos e linhas específicos
      
      5. Performance:
         - Identifique gargalos potenciais, operações ineficientes ou problemas de banco de dados
         - Critique loops desnecessários, operações redundantes ou algoritmos ineficientes
         - Sugira otimizações específicas
         - Cite exemplos concretos com referência a arquivo e linhas
      
      6. Sugestão final:
         - Apresente uma recomendação direta e concreta para melhorar a PR como um todo
         - Seja específico sobre o que precisa ser corrigido para tornar o código de melhor qualidade
         - Se aplicável, sugira melhorias no código, nas regras de negócio, ou no banco de dados
      
      Ao referenciar código, sempre use o formato "Arquivo: filename.ext (linhas X-Y)" para facilitar a localização.
      Inclua apenas os trechos mais relevantes, evitando análises extensas de código secundário.
      Concentre sua análise nos aspectos mais importantes, seja no código ou nas regras de negócio implementadas.
      Não mencione ou avalie a documentação técnica.
      `;
    }
    
    // Usar a API da OpenAI diretamente
    const response = await this.openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Você é um crítico rigoroso de código e implementações de negócio. Ao analisar PRs, seja direto e incisivo sobre problemas de qualidade, legibilidade e estrutura. Não deixe passar código 'feio' ou ilegível. Forneça referências específicas a arquivos e linhas. Seja preciso, objetivo e focado nos aspectos mais relevantes. Mantenha a análise concisa, destacando apenas os pontos críticos. Sempre termine com uma sugestão concreta para melhorar a PR como um todo. Não mencione ou avalie documentação técnica."
        },
        {
          role: "user",
          content: promptContent
        }
      ],
      temperature: 0.2,
      max_tokens: 3000
    });
    
    return response.choices[0].message.content || "Não foi possível analisar o PR.";
  }
}

// Inicializar clientes
const gitHubClient = new GitHubClient(GITHUB_TOKEN, GITHUB_ORG);
const codeAnalyzer = new CodeAnalyzer(OPENAI_API_KEY);

// Registrar as ferramentas com o servidor
mcpServer.tool(
  "searchPullRequests",
  "Pesquisa por Pull Requests na organização com base no nome",
  searchPullRequestsSchema.shape,
  async ({ query, limit }) => {
    try {
      const results = await gitHubClient.searchPullRequests(query, limit);
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }]
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
  "analyzePullRequest",
  "Analisa o código e regras de negócio de um Pull Request específico",
  analyzePullRequestSchema.shape,
  async ({ repo, pr_number, focus }) => {
    try {
      // Obter detalhes do PR
      const prDetails = await gitHubClient.getPullRequestDetails(repo, pr_number);
      
      // Obter arquivos modificados
      const files = await gitHubClient.getPullRequestFiles(repo, pr_number);
      
      // Limitar a quantidade de arquivos para análise
      const filesToAnalyze = files.slice(0, 10);
      
      // Obter o conteúdo de cada arquivo
      const fileContents: Record<string, string> = {};
      
      for (const file of filesToAnalyze) {
        if (file.status !== "removed") {
          try {
            const content = await gitHubClient.getFileContent(
              repo,
              file.filename,
              prDetails.head.sha
            );
            
            if (content) {
              fileContents[file.filename] = content;
            }
          } catch (fileError: unknown) {
            const errorMessage = fileError instanceof Error ? fileError.message : String(fileError);
            console.warn(`Não foi possível obter o conteúdo de ${file.filename}: ${errorMessage}`);
          }
        }
      }
      
      // Analisar o PR
      const analysis = await codeAnalyzer.analyzePullRequest(
        prDetails,
        filesToAnalyze,
        fileContents,
        focus
      );
      
      const result = {
        pr_number,
        repo,
        title: prDetails.title,
        url: prDetails.html_url,
        analysis
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
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
  "pr",
  "Busca e analisa um Pull Request pelo ID (ex: ASCP-123)",
  z.object({
    pr_id: z.string().describe("ID do Pull Request (ex: ASCP-123)"),
    repo: z.string().optional().describe("Nome do repositório (opcional)")
  }).shape,
  async ({ pr_id, repo }) => {
    try {
      // Primeiro buscar o PR pelo ID para obter informações básicas
      const searchResults = await gitHubClient.searchPullRequests(pr_id, 1);
      
      if (searchResults.items && searchResults.items.length > 0) {
        const prInfo = searchResults.items[0];
        const prNumber = prInfo.number;
        
        // Se o repositório não foi especificado, usar o do resultado da busca
        const repoName = repo || prInfo.repository;
        
        // Obter detalhes do PR
        const prDetails = await gitHubClient.getPullRequestDetails(repoName, prNumber);
        
        // Obter arquivos modificados
        const files = await gitHubClient.getPullRequestFiles(repoName, prNumber);
        
        // Limitar a quantidade de arquivos para análise
        const filesToAnalyze = files.slice(0, 10);
        
        // Obter o conteúdo de cada arquivo
        const fileContents: Record<string, string> = {};
        
        for (const file of filesToAnalyze) {
          if (file.status !== "removed") {
            try {
              const content = await gitHubClient.getFileContent(
                repoName,
                file.filename,
                prDetails.head.sha
              );
              
              if (content) {
                fileContents[file.filename] = content;
              }
            } catch (fileError: unknown) {
              const errorMessage = fileError instanceof Error ? fileError.message : String(fileError);
              console.warn(`Não foi possível obter o conteúdo de ${file.filename}: ${errorMessage}`);
            }
          }
        }
        
        // Analisar o PR
        const analysis = await codeAnalyzer.analyzePullRequest(
          prDetails,
          filesToAnalyze,
          fileContents,
          'tudo'
        );
        
        const result = {
          pr_number: prNumber,
          repo: repoName,
          title: prDetails.title,
          url: prDetails.html_url,
          analysis
        };
        
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } else {
        throw new Error(`Não foi encontrado PR com o ID: ${pr_id}`);
      }
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true
      };
    }
  }
);

// CLI support
const handleCliCommands = async () => {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    const command = args[0];
    
    if (command === 'searchPullRequests' && args.length >= 2) {
      const query = args[1];
      const limit = args.length >= 3 ? parseInt(args[2]) : 5;
      
      try {
        const results = await gitHubClient.searchPullRequests(query, limit);
        console.log(JSON.stringify(results, null, 2));
        process.exit(0);
      } catch (error: unknown) {
        console.error("Erro ao pesquisar PRs:", error);
        process.exit(1);
      }
    } else if (command === 'analyzePullRequest' && args.length >= 3) {
      const repo = args[1];
      const prNumber = parseInt(args[2]);
      const focus = args.length >= 4 ? args[3] : 'tudo';
      
      try {
        // Obter detalhes do PR e analisar (código reutilizado da ferramenta MCP)
        const result = await analyzePullRequest(repo, prNumber, focus);
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
      } catch (error: unknown) {
        console.error("Erro ao analisar PR:", error);
        process.exit(1);
      }
    } else if (command === 'pr' && args.length >= 2) {
      // Formato do comando: pr ASCP-123 --repo repo-name
      const prId = args[1];
      
      let repoName = '';
      
      // Procurar pelo parâmetro --repo
      for (let i = 2; i < args.length - 1; i++) {
        if (args[i] === '--repo') {
          repoName = args[i + 1];
          break;
        }
      }
      
      try {
        // Primeiro buscar o PR pelo ID para obter informações básicas
        const searchResults = await gitHubClient.searchPullRequests(prId, 1);
        
        if (searchResults.items && searchResults.items.length > 0) {
          const prInfo = searchResults.items[0];
          const prNumber = prInfo.number;
          
          // Se o repositório não foi especificado, usar o do resultado da busca
          if (!repoName) {
            repoName = prInfo.repository;
          }
          
          console.log(`Analisando PR #${prNumber} no repositório ${repoName}...`);
          
          // Usar a função auxiliar para analisar o PR
          const result = await analyzePullRequest(repoName, prNumber, 'tudo');
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.error(`Não foi encontrado PR com o ID: ${prId}`);
          process.exit(1);
        }
      } catch (error: unknown) {
        console.error("Erro ao processar PR:", error);
        process.exit(1);
      }
    } else {
      console.log("Uso CLI:");
      console.log("  searchPullRequests <query> [limit]");
      console.log("  analyzePullRequest <repo> <pr_number> [focus]");
      console.log("  pr <pr-id> [--repo repo-name]");
      process.exit(1);
    }
    
    return true; // CLI command was handled
  }
  
  return false; // No CLI command was provided
};

// Função auxiliar para analisar PRs (usada pelo CLI e pelo tool)
async function analyzePullRequest(repo: string, prNumber: number, focus: string) {
  // Obter detalhes do PR
  const prDetails = await gitHubClient.getPullRequestDetails(repo, prNumber);
  
  // Obter arquivos modificados
  const files = await gitHubClient.getPullRequestFiles(repo, prNumber);
  
  // Limitar a quantidade de arquivos para análise
  const filesToAnalyze = files.slice(0, 10);
  
  // Obter o conteúdo de cada arquivo
  const fileContents: Record<string, string> = {};
  
  for (const file of filesToAnalyze) {
    if (file.status !== "removed") {
      try {
        const content = await gitHubClient.getFileContent(
          repo,
          file.filename,
          prDetails.head.sha
        );
        
        if (content) {
          fileContents[file.filename] = content;
        }
      } catch (fileError: unknown) {
        const errorMessage = fileError instanceof Error ? fileError.message : String(fileError);
        console.warn(`Não foi possível obter o conteúdo de ${file.filename}: ${errorMessage}`);
      }
    }
  }
  
  // Analisar o PR
  const analysis = await codeAnalyzer.analyzePullRequest(
    prDetails,
    filesToAnalyze,
    fileContents,
    focus
  );
  
  return {
    pr_number: prNumber,
    repo,
    title: prDetails.title,
    url: prDetails.html_url,
    analysis
  };
}

async function main() {
  console.log("GitHub PR MCP Server iniciando...");
  console.log(`- Organização GitHub: ${GITHUB_ORG}`);
  console.log("- Token GitHub: ✓");
  console.log("- API OpenAI: ✓");
  
  // Verificar se está sendo executado como CLI
  const cliHandled = await handleCliCommands();
  if (cliHandled) {
    return; // Encerrar se foi executado em modo CLI
  }
  
  try {
    // Configurar tratamento de sinais para encerramento adequado
    process.on('SIGINT', () => {
      console.error('GitHub PR MCP Server recebeu SIGINT, encerrando...');
      process.exit(0);
    });
    
    process.on('SIGTERM', () => {
      console.error('GitHub PR MCP Server recebeu SIGTERM, encerrando...');
      process.exit(0);
    });
    
    // Garantir que erros não derrubem o processo
    process.on('uncaughtException', (error) => {
      console.error('Exceção não capturada:', error);
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      console.error('Rejeição não tratada em:', promise, 'motivo:', reason);
    });
    
    // Executar o servidor
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.error("GitHub PR MCP Server executando em stdio");
    
    // Manter o processo vivo
    setInterval(() => {
      // Heartbeat para manter o processo ativo
    }, 10000);
  } catch (error) {
    console.error("Erro ao iniciar o servidor:", error);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error("Erro fatal:", error);
  process.exit(1);
}); 