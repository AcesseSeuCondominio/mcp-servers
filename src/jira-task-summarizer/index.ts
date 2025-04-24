#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import JiraClient from "jira-client";
import OpenAI from "openai";

// Esquemas Zod para validação de parâmetros
const summarizeTaskSchema = z.object({
  taskId: z.string()
    .describe("ID da tarefa do Jira (ex: PROJ-123)")
});

const analyzeIssueSchema = z.object({
  issueId: z.string()
    .describe("ID do problema ou bug no Jira (ex: PROJ-456)"),
  focus: z.enum(["causa", "solução", "ambos"]).optional().default("ambos")
    .describe("Em qual aspecto focar a análise")
});

const generateDevPlanSchema = z.object({
  taskId: z.string()
    .describe("ID da tarefa do Jira (ex: PROJ-789)"),
  detailLevel: z.enum(["básico", "detalhado", "técnico"]).optional().default("detalhado")
    .describe("Nível de detalhamento do plano de desenvolvimento")
});

// Criar instância do servidor MCP
const mcpServer = new McpServer({
  name: "jira-task-summarizer",
  version: "0.0.1",
  capabilities: {
    resources: {},
    tools: {},
  },
});

// Verificar variáveis de ambiente necessárias
const JIRA_HOST = process.env.JIRA_HOST;
const JIRA_USERNAME = process.env.JIRA_USERNAME;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!JIRA_HOST || !JIRA_USERNAME || !JIRA_API_TOKEN) {
  console.error("Erro: Variáveis de ambiente JIRA_HOST, JIRA_USERNAME e JIRA_API_TOKEN são obrigatórias");
  process.exit(1);
}

if (!OPENAI_API_KEY) {
  console.error("Erro: Variável de ambiente OPENAI_API_KEY é obrigatória");
  process.exit(1);
}

// Inicializar clientes Jira e OpenAI
const jiraClient = new JiraClient({
  protocol: 'https',
  host: JIRA_HOST,
  username: JIRA_USERNAME,
  password: JIRA_API_TOKEN,
  apiVersion: '2',
  strictSSL: true
});

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY
});

// Classe para gerenciar as operações do Jira
class JiraTaskManager {
  private client: any; // Usando any temporariamente para evitar problemas de tipagem

  constructor(client: any) {
    this.client = client;
  }

  async getIssue(issueId: string) {
    try {
      return await this.client.findIssue(issueId, 'summary,description,status,issuetype,parent,customfield_10014');
    } catch (error) {
      console.error(`Erro ao buscar tarefa ${issueId}:`, error);
      throw new Error(`Não foi possível encontrar a tarefa ${issueId}`);
    }
  }

  async getEpic(epicKey: string) {
    try {
      return await this.client.findIssue(epicKey, 'summary,description');
    } catch (error) {
      console.error(`Erro ao buscar épico ${epicKey}:`, error);
      return null;
    }
  }

  async getSubtasks(issueId: string) {
    try {
      const jql = `parent = ${issueId} ORDER BY created ASC`;
      const result = await this.client.searchJira(jql);
      return result.issues || [];
    } catch (error) {
      console.error(`Erro ao buscar subtarefas para ${issueId}:`, error);
      return [];
    }
  }

  async getFullTaskContext(taskId: string) {
    try {
      // Buscar a tarefa principal
      const issue = await this.getIssue(taskId);
      let context: any = {
        task: {
          id: issue.key,
          type: issue.fields.issuetype.name,
          summary: issue.fields.summary,
          description: issue.fields.description || "Sem descrição",
          status: issue.fields.status.name
        }
      };

      // Buscar história pai se for subtask
      if (issue.fields.parent) {
        const parent = await this.getIssue(issue.fields.parent.key);
        context.parent = {
          id: parent.key,
          summary: parent.fields.summary,
          description: parent.fields.description || "Sem descrição"
        };
      }

      // Buscar épico se existir
      const epicKey = issue.fields.customfield_10014; // Campo customizado para Epic Link
      if (epicKey) {
        const epic = await this.getEpic(epicKey);
        if (epic) {
          context.epic = {
            id: epic.key,
            summary: epic.fields.summary,
            description: epic.fields.description || "Sem descrição"
          };
        }
      }

      // Buscar subtarefas se for história ou épico
      if (["Story", "Epic", "Task"].includes(issue.fields.issuetype.name)) {
        const subtasks = await this.getSubtasks(taskId);
        context.subtasks = subtasks.map((subtask: any) => ({
          id: subtask.key,
          summary: subtask.fields.summary,
          description: subtask.fields.description || "Sem descrição",
          status: subtask.fields.status.name
        }));
      }

      return context;
    } catch (error) {
      console.error(`Erro ao buscar contexto completo para ${taskId}:`, error);
      throw new Error(`Não foi possível obter o contexto completo da tarefa ${taskId}`);
    }
  }
}

// Classe para análise de tarefas via IA
class TaskAnalyzer {
  private openai: OpenAI;

  constructor(openaiClient: OpenAI) {
    this.openai = openaiClient;
  }

  async summarizeTask(taskContext: any) {
    const prompt = this.buildSummarizePrompt(taskContext);
    return await this.generateResponse(prompt);
  }

  async analyzeIssue(taskContext: any, focus: string) {
    const prompt = this.buildAnalyzePrompt(taskContext, focus);
    return await this.generateResponse(prompt);
  }

  async generateDevPlan(taskContext: any, detailLevel: string) {
    const prompt = this.buildDevPlanPrompt(taskContext, detailLevel);
    return await this.generateResponse(prompt);
  }

  private buildSummarizePrompt(context: any) {
    let prompt = `Resumo da tarefa ${context.task.id}: ${context.task.summary}\n\n`;
    prompt += `Tipo: ${context.task.type}\n`;
    prompt += `Status: ${context.task.status}\n\n`;
    
    prompt += `Descrição da Tarefa:\n${context.task.description}\n\n`;
    
    if (context.parent) {
      prompt += `História Pai ${context.parent.id}: ${context.parent.summary}\n`;
      prompt += `Descrição da História:\n${context.parent.description}\n\n`;
    }
    
    if (context.epic) {
      prompt += `Épico ${context.epic.id}: ${context.epic.summary}\n`;
      prompt += `Descrição do Épico:\n${context.epic.description}\n\n`;
    }
    
    if (context.subtasks && context.subtasks.length > 0) {
      prompt += `Subtarefas:\n`;
      for (const subtask of context.subtasks) {
        prompt += `- ${subtask.id}: ${subtask.summary} (${subtask.status})\n`;
        prompt += `  ${subtask.description.replace(/\n/g, '\n  ')}\n`;
      }
      prompt += '\n';
    }
    
    prompt += `
    Por favor, forneça um resumo claro e conciso da tarefa, incluindo:
    1. Um resumo geral do que precisa ser feito
    2. Como esta tarefa se relaciona com o épico/história (se aplicável)
    3. Quais são os principais pontos que o desenvolvedor deve entender
    4. Como o desenvolvedor deve abordar a implementação
    5. Quaisquer detalhes técnicos relevantes mencionados na descrição
    
    Por favor, responda em português, de forma clara e objetiva para um desenvolvedor.
    `;
    
    return prompt;
  }

  private buildAnalyzePrompt(context: any, focus: string) {
    let prompt = `Análise do Problema ${context.task.id}: ${context.task.summary}\n\n`;
    prompt += `Tipo: ${context.task.type}\n`;
    prompt += `Status: ${context.task.status}\n\n`;
    
    prompt += `Descrição do Problema:\n${context.task.description}\n\n`;
    
    if (context.parent) {
      prompt += `História Relacionada ${context.parent.id}: ${context.parent.summary}\n`;
      prompt += `Descrição da História:\n${context.parent.description}\n\n`;
    }
    
    if (context.epic) {
      prompt += `Épico ${context.epic.id}: ${context.epic.summary}\n`;
      prompt += `Descrição do Épico:\n${context.epic.description}\n\n`;
    }
    
    if (focus === "causa" || focus === "ambos") {
      prompt += `
      Por favor, analise o problema e identifique:
      1. Qual parece ser a causa raiz do problema
      2. Quais sistemas ou componentes estão envolvidos
      3. Quais condições levam ao problema ocorrer
      `;
    }
    
    if (focus === "solução" || focus === "ambos") {
      prompt += `
      Por favor, sugira uma abordagem para resolver o problema:
      1. Passos recomendados para resolver o bug
      2. Áreas de código que provavelmente precisam ser modificadas
      3. Testes que devem ser realizados para verificar a correção
      `;
    }
    
    prompt += `
    Por favor, responda em português, de forma clara e objetiva para um desenvolvedor que vai resolver este problema.
    `;
    
    return prompt;
  }

  private buildDevPlanPrompt(context: any, detailLevel: string) {
    let prompt = `Plano de Desenvolvimento para ${context.task.id}: ${context.task.summary}\n\n`;
    prompt += `Tipo: ${context.task.type}\n`;
    prompt += `Status: ${context.task.status}\n\n`;
    
    prompt += `Descrição da Tarefa:\n${context.task.description}\n\n`;
    
    if (context.parent) {
      prompt += `História Pai ${context.parent.id}: ${context.parent.summary}\n`;
      prompt += `Descrição da História:\n${context.parent.description}\n\n`;
    }
    
    if (context.epic) {
      prompt += `Épico ${context.epic.id}: ${context.epic.summary}\n`;
      prompt += `Descrição do Épico:\n${context.epic.description}\n\n`;
    }
    
    if (context.subtasks && context.subtasks.length > 0) {
      prompt += `Subtarefas:\n`;
      for (const subtask of context.subtasks) {
        prompt += `- ${subtask.id}: ${subtask.summary} (${subtask.status})\n`;
        prompt += `  ${subtask.description.replace(/\n/g, '\n  ')}\n`;
      }
      prompt += '\n';
    }
    
    let detailInstructions = "";
    
    if (detailLevel === "básico") {
      detailInstructions = "Forneça um plano de alto nível com os principais passos para implementar esta tarefa.";
    } else if (detailLevel === "detalhado") {
      detailInstructions = "Forneça um plano detalhado com passos específicos, incluindo considerações de design e possíveis desafios.";
    } else if (detailLevel === "técnico") {
      detailInstructions = "Forneça um plano técnico detalhado com referências a padrões de código, arquitetura, e considerações de performance e segurança.";
    }
    
    prompt += `
    Crie um guia prático para implementar esta tarefa, incluindo:
    1. Uma visão geral do que precisa ser feito
    2. Um plano passo a passo para implementação
    3. Considerações técnicas importantes
    4. Como testar a implementação
    5. Critérios para considerar a tarefa concluída
    
    ${detailInstructions}
    
    Por favor, responda em português, de forma clara e objetiva para um desenvolvedor que vai implementar esta tarefa.
    `;
    
    return prompt;
  }

  private async generateResponse(prompt: string) {
    try {
      const completion = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { 
            role: "system", 
            content: "Você é um assistente especializado em analisar tarefas de desenvolvimento de software e explicá-las de forma clara para desenvolvedores. Suas respostas devem ser diretas, práticas e úteis." 
          },
          { role: "user", content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 3000
      });

      return completion.choices[0].message.content || "Não foi possível gerar uma resposta.";
    } catch (error) {
      console.error("Erro ao gerar resposta via OpenAI:", error);
      throw new Error("Falha ao analisar a tarefa com IA. Tente novamente mais tarde.");
    }
  }
}

// Inicializar as classes para gerenciamento de tarefas e análise
const jiraTaskManager = new JiraTaskManager(jiraClient);
const taskAnalyzer = new TaskAnalyzer(openai);

// Registrar as ferramentas no servidor MCP
mcpServer.tool(
  "summarizeTask",
  "Resume uma tarefa específica do Jira com todo o contexto relacionado",
  summarizeTaskSchema.shape,
  async ({ taskId }) => {
    try {
      console.error(`Resumindo tarefa: ${taskId}`);
      const taskContext = await jiraTaskManager.getFullTaskContext(taskId);
      const summary = await taskAnalyzer.summarizeTask(taskContext);
      
      return {
        content: [{ type: "text", text: summary }]
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
  "analyzeIssue",
  "Analisa profundamente um problema ou bug para entender causa e solução",
  analyzeIssueSchema.shape,
  async ({ issueId, focus }) => {
    try {
      console.error(`Analisando problema: ${issueId} (foco: ${focus})`);
      const taskContext = await jiraTaskManager.getFullTaskContext(issueId);
      const analysis = await taskAnalyzer.analyzeIssue(taskContext, focus);
      
      return {
        content: [{ type: "text", text: analysis }]
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
  "generateDevPlan",
  "Cria um guia passo a passo para implementar a tarefa",
  generateDevPlanSchema.shape,
  async ({ taskId, detailLevel }) => {
    try {
      console.error(`Gerando plano de desenvolvimento para: ${taskId} (nível: ${detailLevel})`);
      const taskContext = await jiraTaskManager.getFullTaskContext(taskId);
      const plan = await taskAnalyzer.generateDevPlan(taskContext, detailLevel);
      
      return {
        content: [{ type: "text", text: plan }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true
      };
    }
  }
);

// Verificar argumentos CLI e executar comandos se necessário
async function handleCliCommands() {
  const args = process.argv.slice(2);
  if (args.length === 0) return false;

  try {
    const command = args[0];
    
    if (command === 'summarizeTask' && args[1]) {
      const taskId = args[1];
      const taskContext = await jiraTaskManager.getFullTaskContext(taskId);
      const summary = await taskAnalyzer.summarizeTask(taskContext);
      console.log(summary);
      return true;
    }
    
    if (command === 'analyzeIssue' && args[1]) {
      const issueId = args[1];
      const focus = args[2] || 'ambos';
      const taskContext = await jiraTaskManager.getFullTaskContext(issueId);
      const analysis = await taskAnalyzer.analyzeIssue(taskContext, focus);
      console.log(analysis);
      return true;
    }
    
    if (command === 'generateDevPlan' && args[1]) {
      const taskId = args[1];
      const detailLevel = args[2] || 'detalhado';
      const taskContext = await jiraTaskManager.getFullTaskContext(taskId);
      const plan = await taskAnalyzer.generateDevPlan(taskContext, detailLevel);
      console.log(plan);
      return true;
    }

    console.error('Comando não reconhecido ou parâmetros insuficientes');
    console.error('Uso: node dist/index.js <comando> <taskId> [opções]');
    console.error('Comandos disponíveis: summarizeTask, analyzeIssue, generateDevPlan');
    return true;
  } catch (error) {
    console.error('Erro ao executar comando CLI:', error);
    return true;
  }
}

// Função principal para iniciar o servidor
async function main() {
  console.error("Jira Task Summarizer MCP Server iniciando...");
  
  // Verificar se está sendo executado como CLI
  const cliHandled = await handleCliCommands();
  if (cliHandled) return;
  
  try {
    // Configurar tratamento de sinais para encerramento adequado
    process.on('SIGINT', () => {
      console.error('Jira Task Summarizer MCP Server recebeu SIGINT, encerrando...');
      process.exit(0);
    });
    
    process.on('SIGTERM', () => {
      console.error('Jira Task Summarizer MCP Server recebeu SIGTERM, encerrando...');
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
    console.error("Jira Task Summarizer MCP Server executando em stdio");
    
    // Manter o processo vivo
    setInterval(() => {
      // Heartbeat para manter o processo ativo
    }, 10000);
  } catch (error) {
    console.error("Erro ao iniciar o servidor:", error);
    process.exit(1);
  }
}

// Iniciar o servidor
main(); 