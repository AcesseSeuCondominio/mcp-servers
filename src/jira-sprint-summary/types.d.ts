declare module "jira-client" {
  export default class JiraApi {
    constructor(options: any);
    findIssue(issueId: string, fields?: string): Promise<any>;
    searchJira(jql: string, options?: any): Promise<any>;
    getActiveSprintForBoard(boardId: number): Promise<any>;
    getBoardsForProject(projectId: string): Promise<any>;
  }
} 