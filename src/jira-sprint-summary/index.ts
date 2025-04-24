#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import JiraClient from "jira-client";
import OpenAI from "openai";

// Esquemas Zod para validação de parâmetros
const getSprintSummarySchema = z.object({
  boardId: z.union([
    z.number(),
    z.string().transform(val => {
      const parsed = parseInt(val);
      return isNaN(parsed) ? undefined : parsed;
    })
  ])
    .optional()
    .describe("ID opcional do quadro do Jira (se não for fornecido, usará a variável de ambiente)")
});

const getUserTasksSchema = z.object({
  userName: z.string()
    .describe("Nome do usuário no Jira (ex: João Silva)"),
  boardId: z.union([
    z.number(),
    z.string().transform(val => {
      const parsed = parseInt(val);
      return isNaN(parsed) ? undefined : parsed;
    })
  ])
    .optional()
    .describe("ID opcional do quadro do Jira (se não for fornecido, usará a variável de ambiente)")
});

const getSprintProgressSchema = z.object({
  boardId: z.union([
    z.number(),
    z.string().transform(val => {
      const parsed = parseInt(val);
      return isNaN(parsed) ? undefined : parsed;
    })
  ])
    .optional()
    .describe("ID opcional do quadro do Jira (se não for fornecido, usará a variável de ambiente)")
});

// Criar instância do servidor MCP
const mcpServer = new McpServer({
  name: "jira-sprint-summary",
  version: "0.0.7",
  capabilities: {
    resources: {},
    tools: {},
  },
});

// Verificar e carregar variáveis de ambiente necessárias
const loadEnvVars = () => {
  const requiredVars = [
    'JIRA_HOST',
    'JIRA_USERNAME',
    'JIRA_API_TOKEN',
    'OPENAI_API_KEY',
    'JIRA_PROJECT_KEY'
  ];
  
  const missingVars = requiredVars.filter(varName => !process.env[varName]);
  
  if (missingVars.length > 0) {
    console.error(`Erro: As seguintes variáveis de ambiente são obrigatórias mas não foram encontradas: ${missingVars.join(', ')}`);
    process.exit(1);
  }
  
  return {
    JIRA_HOST: process.env.JIRA_HOST!,
    JIRA_USERNAME: process.env.JIRA_USERNAME!,
    JIRA_API_TOKEN: process.env.JIRA_API_TOKEN!,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
    JIRA_PROJECT_KEY: process.env.JIRA_PROJECT_KEY!,
    JIRA_BOARD_ID: process.env.JIRA_BOARD_ID ? parseInt(process.env.JIRA_BOARD_ID) : undefined
  };
};

// Carregar variáveis de ambiente
const envVars = loadEnvVars();
console.error("Variáveis de ambiente carregadas com sucesso");

// Log para debug (apenas no console de erro)
console.error(`Configurações: 
  - Host Jira: ${envVars.JIRA_HOST}
  - Usuário Jira: ${envVars.JIRA_USERNAME}
  - Projeto Jira: ${envVars.JIRA_PROJECT_KEY}
  - Board ID: ${envVars.JIRA_BOARD_ID || 'Não definido'}`);

// Inicializar clientes Jira e OpenAI
const jiraClient = new JiraClient({
  protocol: 'https',
  host: envVars.JIRA_HOST,
  username: envVars.JIRA_USERNAME,
  password: envVars.JIRA_API_TOKEN,
  apiVersion: '2',
  strictSSL: true
});

const openai = new OpenAI({
  apiKey: envVars.OPENAI_API_KEY
});

// Classe para gerenciar as operações do Jira
class JiraSprintManager {
  private client: any;
  private projectKey: string;
  private defaultBoardId?: number;
  private jiraHost: string;
  
  constructor(client: any, projectKey: string, defaultBoardId?: number) {
    this.client = client;
    this.projectKey = projectKey;
    this.defaultBoardId = defaultBoardId;
    this.jiraHost = client.host || envVars.JIRA_HOST;
  }

  // Implementação do método buildURL caso o cliente não o tenha
  private buildURL(path: string): string {
    // Remover barras iniciais duplicadas
    const cleanPath = path.startsWith('/') ? path.substring(1) : path;
    return `https://${this.jiraHost}/${cleanPath}`;
  }

  async getActiveSprint(boardId?: number) {
    try {
      let targetBoardId = boardId || this.defaultBoardId;
      
      console.error(`Tentando buscar sprint ativa. boardId recebido: ${boardId}, defaultBoardId: ${this.defaultBoardId}, targetBoardId: ${targetBoardId}`);
      
      if (!targetBoardId) {
        console.error("Board ID não fornecido nem nas variáveis de ambiente. Tentando buscar o primeiro quadro do projeto...");
        // Se não tiver boardId, busca o primeiro board do projeto
        try {
          const boards = await this.client.getBoardsForProject(this.projectKey);
          if (!boards || boards.values.length === 0) {
            throw new Error(`Não foi possível encontrar quadros para o projeto ${this.projectKey}`);
          }
          targetBoardId = boards.values[0].id;
          console.error(`Encontrado board ID: ${targetBoardId}`);
        } catch (err) {
          console.error("Erro ao buscar boards do projeto:", err);
          throw new Error(`Não foi possível encontrar um board para o projeto ${this.projectKey}. Por favor, forneça um Board ID.`);
        }
      }
      
      // Log para debug
      console.error(`Buscando sprint ativa para o board ID: ${targetBoardId}`);
      
      // Usando a API de sprints do board para buscar todas as sprints e filtrar as ativas
      try {
        // GET /rest/agile/1.0/board/{boardId}/sprint?state=active
        const pathActive = `/rest/agile/1.0/board/${targetBoardId}/sprint?state=active`;
        console.error(`Chamando API: ${pathActive}`);
        
        const resultActive = await this.client.doRequest({
          method: 'GET',
          uri: this.client.buildURL ? this.client.buildURL(pathActive) : this.buildURL(pathActive)
        });
        
        if (resultActive && resultActive.values && resultActive.values.length > 0) {
          console.error(`Sprint ativa encontrada: ${resultActive.values[0].name} (ID: ${resultActive.values[0].id})`);
          return resultActive.values[0];
        }
        
        // Se não encontrou sprint ativa, tenta buscar sprints recentes
        console.error(`Não foi encontrada sprint ativa. Buscando sprints recentes...`);
        const pathRecent = `/rest/agile/1.0/board/${targetBoardId}/sprint`;
        
        const resultRecent = await this.client.doRequest({
          method: 'GET',
          uri: this.client.buildURL ? this.client.buildURL(pathRecent) : this.buildURL(pathRecent)
        });
        
        if (!resultRecent || !resultRecent.values || resultRecent.values.length === 0) {
          throw new Error(`Não foram encontradas sprints para o quadro ${targetBoardId}`);
        }
        
        // Ordenar por data de início (mais recente primeiro)
        const sortedSprints = resultRecent.values.sort((a: any, b: any) => {
          if (!a.startDate) return 1;
          if (!b.startDate) return -1;
          return new Date(b.startDate).getTime() - new Date(a.startDate).getTime();
        });
        
        console.error(`Sprint mais recente encontrada: ${sortedSprints[0].name} (ID: ${sortedSprints[0].id})`);
        return sortedSprints[0];
      } catch (apiError: unknown) {
        console.error("Erro na chamada da API:", apiError);
        throw new Error(`Erro ao buscar sprint ativa: ${apiError instanceof Error ? apiError.message : JSON.stringify(apiError)}`);
      }
    } catch (error) {
      console.error("Erro ao buscar sprint ativa:", error);
      
      // Mensagem de erro mais específica
      if (error instanceof Error) {
        throw new Error(`Não foi possível encontrar a sprint ativa: ${error.message}`);
      } else {
        throw new Error("Não foi possível encontrar a sprint ativa. Verifique se o Board ID está correto e se existe uma sprint ativa.");
      }
    }
  }

  async getSprintIssues(sprintId: number) {
    try {
      const jql = `sprint = ${sprintId} ORDER BY status ASC, created DESC`;
      const result = await this.client.searchJira(jql);
      return result.issues || [];
    } catch (error) {
      console.error(`Erro ao buscar tarefas da sprint ${sprintId}:`, error);
      return [];
    }
  }

  async getUserTasks(userName: string, sprintId: number) {
    try {
      console.error(`Buscando tarefas do usuário ${userName} na sprint ${sprintId}`);
      
      // Aprimorar a busca para nomes de usuário (aceita nome parcial e não diferencia maiúsculas de minúsculas)
      // Usamos assignee ~ para buscar correspondências parciais e insensíveis a maiúsculas/minúsculas
      let jql = '';
      
      // Se o nome de usuário contém espaços, envolva em aspas
      if (userName.includes(' ')) {
        jql = `sprint = ${sprintId} AND assignee ~ "${userName}" ORDER BY status ASC, created DESC`;
      } else {
        jql = `sprint = ${sprintId} AND assignee ~ ${userName} ORDER BY status ASC, created DESC`;
      }
      
      console.error(`JQL: ${jql}`);
      
      const result = await this.client.searchJira(jql);
      console.error(`Tarefas encontradas: ${result.issues?.length || 0}`);
      
      return result.issues || [];
    } catch (error) {
      console.error(`Erro ao buscar tarefas do usuário ${userName} na sprint ${sprintId}:`, error);
      return [];
    }
  }

  async getSprintDetails(boardId?: number) {
    try {
      // Obter a sprint ativa
      const sprint = await this.getActiveSprint(boardId);
      
      // Obter todas as tarefas da sprint
      const issues = await this.getSprintIssues(sprint.id);
      
      // Calcular o progresso da sprint
      const statusCounts: Record<string, number> = {};
      const typeCounts: Record<string, number> = {};
      let completedPoints = 0;
      let totalPoints = 0;
      
      for (const issue of issues) {
        // Contar por status
        const status = issue.fields.status.name;
        statusCounts[status] = (statusCounts[status] || 0) + 1;
        
        // Contar por tipo
        const type = issue.fields.issuetype.name;
        typeCounts[type] = (typeCounts[type] || 0) + 1;
        
        // Calcular story points
        const storyPoints = issue.fields.customfield_10016 || 0; // Campo customizado para Story Points
        totalPoints += storyPoints;
        
        // Verificar se está concluída (Done, Closed, etc.)
        const doneStatuses = ['Done', 'Closed', 'Resolved', 'Completed', 'Finalizado', 'Concluído'];
        if (doneStatuses.includes(status)) {
          completedPoints += storyPoints;
        }
      }
      
      // Retornar detalhes da sprint
      return {
        sprint: {
          id: sprint.id,
          name: sprint.name,
          goal: sprint.goal || "Sem objetivo definido",
          startDate: sprint.startDate,
          endDate: sprint.endDate,
          state: sprint.state
        },
        issues: {
          total: issues.length,
          byStatus: statusCounts,
          byType: typeCounts
        },
        progress: {
          completedPoints,
          totalPoints,
          percentComplete: totalPoints > 0 ? Math.round((completedPoints / totalPoints) * 100) : 0
        },
        allIssues: issues
      };
    } catch (error) {
      console.error("Erro ao buscar detalhes da sprint:", error);
      throw new Error("Não foi possível obter os detalhes da sprint");
    }
  }
}

// Classe para análise da sprint via IA
class SprintAnalyzer {
  private openai: OpenAI;

  constructor(openaiClient: OpenAI) {
    this.openai = openaiClient;
  }

  async generateSprintSummary(sprintDetails: any) {
    const prompt = this.buildSprintSummaryPrompt(sprintDetails);
    return await this.generateResponse(prompt);
  }

  async generateUserTasksList(tasks: any[], userName: string, sprintName: string) {
    const prompt = this.buildUserTasksListPrompt(tasks, userName, sprintName);
    return await this.generateResponse(prompt);
  }

  async generateSprintProgress(sprintDetails: any) {
    const prompt = this.buildSprintProgressPrompt(sprintDetails);
    return await this.generateResponse(prompt);
  }

  private buildSprintSummaryPrompt(details: any) {
    const { sprint, issues, progress } = details;
    
    let prompt = `Resumo da Sprint: ${sprint.name}\n\n`;
    prompt += `Objetivo: ${sprint.goal}\n`;
    prompt += `Estado: ${sprint.state}\n`;
    prompt += `Data de início: ${new Date(sprint.startDate).toLocaleDateString('pt-BR')}\n`;
    prompt += `Data de término: ${new Date(sprint.endDate).toLocaleDateString('pt-BR')}\n\n`;
    
    prompt += `Total de tarefas: ${issues.total}\n`;
    prompt += `Progresso: ${progress.completedPoints} de ${progress.totalPoints} pontos (${progress.percentComplete}%)\n\n`;
    
    prompt += `Distribuição por status:\n`;
    for (const [status, count] of Object.entries(issues.byStatus)) {
      prompt += `- ${status}: ${count} tarefas\n`;
    }
    
    prompt += `\nDistribuição por tipo:\n`;
    for (const [type, count] of Object.entries(issues.byType)) {
      prompt += `- ${type}: ${count} tarefas\n`;
    }
    
    prompt += `\nPor favor, forneça um resumo claro e conciso da sprint atual, incluindo:
    1. Uma visão geral do objetivo da sprint
    2. O progresso atual da sprint
    3. Destaque das principais métricas (total de tarefas, distribuição por status)
    4. Avaliação do ritmo atual em relação à data de término
    5. Recomendações para melhorar o progresso, se necessário

    Por favor, responda em português, de forma clara e objetiva.`;
    
    return prompt;
  }

  private buildUserTasksListPrompt(tasks: any[], userName: string, sprintName: string) {
    let prompt = `Tarefas de ${userName} na Sprint ${sprintName}\n\n`;
    
    if (tasks.length === 0) {
      prompt += `Não foram encontradas tarefas atribuídas a ${userName} na sprint atual.\n\n`;
      prompt += `Por favor, forneça uma resposta informando que não há tarefas atribuídas a este usuário na sprint atual.`;
      return prompt;
    }
    
    prompt += `Total de tarefas: ${tasks.length}\n\n`;
    
    prompt += `Lista de tarefas:\n`;
    tasks.forEach((task, index) => {
      const storyPoints = task.fields.customfield_10016 || "N/A";
      prompt += `${index + 1}. [${task.key}] ${task.fields.summary}\n`;
      prompt += `   Tipo: ${task.fields.issuetype.name}\n`;
      prompt += `   Status: ${task.fields.status.name}\n`;
      prompt += `   Story Points: ${storyPoints}\n`;
      if (task.fields.description) {
        // Limitar a descrição para não ficar muito grande
        const description = task.fields.description.substring(0, 200);
        prompt += `   Descrição: ${description}${task.fields.description.length > 200 ? "..." : ""}\n`;
      }
      prompt += `\n`;
    });
    
    prompt += `Por favor, forneça uma lista clara das tarefas atribuídas a ${userName} na sprint atual, incluindo:
    1. Uma lista numerada com todas as tarefas, seus códigos e títulos
    2. O status de cada tarefa
    3. Um resumo breve das responsabilidades do usuário na sprint
    4. Sugestões de priorização, se aplicável
    
    Por favor, responda em português, de forma clara e objetiva, como uma lista formatada.`;
    
    return prompt;
  }

  private buildSprintProgressPrompt(details: any) {
    const { sprint, issues, progress } = details;
    
    let prompt = `Análise de Progresso da Sprint: ${sprint.name}\n\n`;
    prompt += `Objetivo: ${sprint.goal}\n`;
    prompt += `Data de início: ${new Date(sprint.startDate).toLocaleDateString('pt-BR')}\n`;
    prompt += `Data de término: ${new Date(sprint.endDate).toLocaleDateString('pt-BR')}\n\n`;
    
    // Calcular dias restantes
    const today = new Date();
    const endDate = new Date(sprint.endDate);
    const totalDays = Math.floor((endDate.getTime() - new Date(sprint.startDate).getTime()) / (1000 * 60 * 60 * 24));
    const daysLeft = Math.max(0, Math.floor((endDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)));
    const percentTimeElapsed = Math.round(((totalDays - daysLeft) / totalDays) * 100);
    
    prompt += `Dias restantes: ${daysLeft} de ${totalDays} (${percentTimeElapsed}% do tempo decorrido)\n`;
    prompt += `Progresso: ${progress.completedPoints} de ${progress.totalPoints} pontos (${progress.percentComplete}% concluído)\n\n`;
    
    prompt += `Distribuição por status:\n`;
    for (const [status, count] of Object.entries(issues.byStatus)) {
      prompt += `- ${status}: ${count} tarefas\n`;
    }
    
    // Calcular velocidade e projeção
    const pointsPerDay = progress.completedPoints / (totalDays - daysLeft || 1);
    const projectedCompletion = Math.round(pointsPerDay * totalDays);
    const burndownDifference = progress.percentComplete - percentTimeElapsed;
    
    prompt += `\nVelocidade atual: ${pointsPerDay.toFixed(1)} pontos por dia\n`;
    prompt += `Projeção de entrega: ${projectedCompletion} de ${progress.totalPoints} pontos\n`;
    prompt += `Diferença no burndown: ${burndownDifference > 0 ? "+" : ""}${burndownDifference}%\n\n`;
    
    prompt += `Por favor, forneça uma análise detalhada do progresso da sprint atual, incluindo:
    1. Uma avaliação do ritmo atual em relação ao ideal (burndown)
    2. Se o progresso está adiantado, no prazo ou atrasado
    3. Previsão de conclusão baseada na velocidade atual
    4. Principais gargalos ou bloqueios (baseados na distribuição de status)
    5. Recomendações concretas para melhorar o progresso
    
    Por favor, responda em português, de forma clara e objetiva, colocando a conclusão mais importante como o primeiro ponto.`;
    
    return prompt;
  }

  private async generateResponse(prompt: string) {
    try {
      const response = await this.openai.chat.completions.create({
        model: "gpt-4-turbo",
        messages: [{
          role: "system",
          content: "Você é um assistente especializado em análise de sprints ágeis. Forneça respostas claras, concisas e úteis com base nas informações fornecidas sobre a sprint."
        }, {
          role: "user",
          content: prompt
        }],
        temperature: 0.5,
        max_tokens: 1000
      });
      
      return response.choices[0]?.message?.content || "Não foi possível gerar uma resposta.";
    } catch (error) {
      console.error("Erro ao gerar resposta via OpenAI:", error);
      return "Ocorreu um erro ao gerar a análise. Tente novamente mais tarde.";
    }
  }
}

// Instâncias das classes de gerenciamento
const jiraManager = new JiraSprintManager(jiraClient, envVars.JIRA_PROJECT_KEY, envVars.JIRA_BOARD_ID);
const sprintAnalyzer = new SprintAnalyzer(openai);

// Registrar função para obter resumo da sprint
mcpServer.tool(
  "getSprintSummary",
  "Obter um resumo da sprint atual, incluindo objetivo, progresso e métricas principais",
  getSprintSummarySchema.shape,
  async (params: z.infer<typeof getSprintSummarySchema>) => {
    try {
      console.error(`Executando getSprintSummary com parâmetros: ${JSON.stringify(params)}`);
      
      const sprintDetails = await jiraManager.getSprintDetails(params.boardId);
      const summary = await sprintAnalyzer.generateSprintSummary(sprintDetails);
      
      return {
        content: [{ type: "text", text: summary }]
      };
    } catch (error) {
      console.error(`Erro em getSprintSummary: ${error instanceof Error ? error.message : String(error)}`);
      
      return {
        content: [{ 
          type: "text", 
          text: error instanceof Error 
            ? `Erro ao obter resumo da sprint: ${error.message}` 
            : `Erro ao obter resumo da sprint: ${String(error)}` 
        }],
        isError: true
      };
    }
  }
);

// Registrar função para listar tarefas do usuário
mcpServer.tool(
  "getUserTasks",
  "Listar todas as tarefas atribuídas a um usuário específico na sprint atual",
  getUserTasksSchema.shape,
  async (params: z.infer<typeof getUserTasksSchema>) => {
    try {
      console.error(`Executando getUserTasks com parâmetros: ${JSON.stringify(params)}`);
      
      // Obter sprint ativa
      const sprint = await jiraManager.getActiveSprint(params.boardId);
      
      // Obter tarefas do usuário na sprint
      const tasks = await jiraManager.getUserTasks(params.userName, sprint.id);
      
      // Gerar lista formatada
      const tasksList = await sprintAnalyzer.generateUserTasksList(tasks, params.userName, sprint.name);
      
      return {
        content: [{ type: "text", text: tasksList }]
      };
    } catch (error) {
      console.error(`Erro em getUserTasks: ${error instanceof Error ? error.message : String(error)}`);
      
      return {
        content: [{ 
          type: "text", 
          text: error instanceof Error 
            ? `Erro ao buscar tarefas do usuário: ${error.message}` 
            : `Erro ao buscar tarefas do usuário: ${String(error)}` 
        }],
        isError: true
      };
    }
  }
);

// Registrar função para analisar progresso da sprint
mcpServer.tool(
  "getSprintProgress",
  "Obter uma análise detalhada do progresso da sprint atual, com projeções e recomendações",
  getSprintProgressSchema.shape,
  async (params: z.infer<typeof getSprintProgressSchema>) => {
    try {
      console.error(`Executando getSprintProgress com parâmetros: ${JSON.stringify(params)}`);
      
      const sprintDetails = await jiraManager.getSprintDetails(params.boardId);
      const progressAnalysis = await sprintAnalyzer.generateSprintProgress(sprintDetails);
      
      return {
        content: [{ type: "text", text: progressAnalysis }]
      };
    } catch (error) {
      console.error(`Erro em getSprintProgress: ${error instanceof Error ? error.message : String(error)}`);
      
      return {
        content: [{ 
          type: "text", 
          text: error instanceof Error 
            ? `Erro ao analisar progresso da sprint: ${error.message}` 
            : `Erro ao analisar progresso da sprint: ${String(error)}` 
        }],
        isError: true
      };
    }
  }
);

// Função principal
async function main() {
  try {
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    
    console.error("Iniciando servidor Jira Sprint Summary...");
    console.error("Servidor iniciado com sucesso!");
    
    // Manter o processo vivo
    setInterval(() => {
      // Heartbeat para manter o processo ativo
    }, 10000);
  } catch (error) {
    console.error("Erro ao iniciar servidor:", error);
    process.exit(1);
  }
}

// Iniciar servidor
main();