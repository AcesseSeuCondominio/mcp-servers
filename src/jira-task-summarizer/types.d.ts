declare module 'jira-client' {
  class JiraApi {
    constructor(options: any);
    findIssue(issueId: string, fields?: string): Promise<any>;
    searchJira(jql: string, options?: any): Promise<any>;
    // Adicione outros métodos conforme necessário
  }
  export default JiraApi;
} 