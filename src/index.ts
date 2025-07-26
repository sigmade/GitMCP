import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { execSync } from 'child_process';
import * as fs from 'fs';

// Simple types
interface MergeInfo {
  sourceBranch: string;
  targetBranch: string;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  commits: number;
  summary: string;
}

class SimpleMergeReviewMCP {
  private server: Server;

  constructor() {
    this.server = new Server({
      name: 'simple-merge-review',
      version: '1.0.0',
    });

    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'show_merge_diff',
            description: 'Show changes between branches before merge',
            inputSchema: {
              type: 'object',
              properties: {
                repoPath: {
                  type: 'string',
                  description: 'Path to the git repository',
                },
                fromBranch: {
                  type: 'string',
                  description: 'Branch to merge from (default: main)',
                  default: 'main',
                },
                toBranch: {
                  type: 'string',
                  description: 'Branch to merge into (default: current)',
                },
              },
              required: ['repoPath'],
            },
          },
          {
            name: 'quick_merge_summary',
            description: 'Quick summary of changes for merge',
            inputSchema: {
              type: 'object',
              properties: {
                repoPath: {
                  type: 'string',
                  description: 'Path to the git repository',
                },
                branch: {
                  type: 'string',
                  description: 'Branch to analyze (default: current)',
                },
              },
              required: ['repoPath'],
            },
          },
          {
            name: 'show_file_diff',
            description: 'Show specific changes in a file between branches',
            inputSchema: {
              type: 'object',
              properties: {
                repoPath: {
                  type: 'string',
                  description: 'Path to the git repository',
                },
                filename: {
                  type: 'string',
                  description: 'Path to the file relative to the repository root',
                },
                fromBranch: {
                  type: 'string',
                  description: 'Branch to compare from (default: main/master)',
                },
                toBranch: {
                  type: 'string',
                  description: 'Branch to compare to (default: current)',
                },
              },
              required: ['repoPath', 'filename'],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'show_merge_diff':
            return await this.showMergeDiff(args);
          case 'quick_merge_summary':
            return await this.quickMergeSummary(args);
          case 'show_file_diff':
            return await this.showFileDiff(args);
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error) {
        throw new McpError(ErrorCode.InternalError, `Error: ${(error as Error).message}`);
      }
    });
  }

  private async showMergeDiff(args: any) {
    const { repoPath, fromBranch = 'main', toBranch } = args;
    
    if (!fs.existsSync(repoPath)) {
      throw new Error(`Repository not found: ${repoPath}`);
    }

    const currentBranch = toBranch || this.getCurrentBranch(repoPath);
    const mergeInfo = this.getMergeInfo(repoPath, fromBranch, currentBranch);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(mergeInfo, null, 2),
        },
      ],
    };
  }

  private async quickMergeSummary(args: any) {
    const { repoPath, branch } = args;
    
    if (!fs.existsSync(repoPath)) {
      throw new Error(`Repository not found: ${repoPath}`);
    }

    const currentBranch = branch || this.getCurrentBranch(repoPath);
    const mainBranch = this.getMainBranch(repoPath);
    
    // Simple summary of changes
    const summary = {
      currentBranch,
      baseBranch: mainBranch,
      ...this.getQuickStats(repoPath, mainBranch, currentBranch),
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(summary, null, 2),
        },
      ],
    };
  }

  private async showFileDiff(args: any) {
    const { repoPath, filename, fromBranch, toBranch } = args;
    
    if (!fs.existsSync(repoPath)) {
      throw new Error(`Repository not found: ${repoPath}`);
    }

    // Determine branches
    const sourceBranch = fromBranch || this.getMainBranch(repoPath);
    const targetBranch = toBranch || this.getCurrentBranch(repoPath);

    // Get diff for the specific file
    const diffOutput = this.getFileDiff(repoPath, filename, sourceBranch, targetBranch);
    
    // Parse diff for more readable output
    const parsedDiff = this.parseFileDiff(diffOutput);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            filename,
            fromBranch: sourceBranch,
            toBranch: targetBranch,
            ...parsedDiff,
            rawDiff: diffOutput.split('\n').slice(0, 100), // Limit the number of lines
          }, null, 2),
        },
      ],
    };
  }

  private getFileDiff(repoPath: string, filename: string, fromBranch: string, toBranch: string): string {
    try {
      return this.executeGit(
        `git diff ${fromBranch}..${toBranch} -- "${filename}"`,
        repoPath
      );
    } catch (error) {
      throw new Error(`Failed to get diff for file ${filename}: ${(error as Error).message}`);
    }
  }

  private parseFileDiff(diffOutput: string): { hasChanges: boolean; additions: string[]; deletions: string[]; summary: string } {
    const lines = diffOutput.split('\n');
    const additions: string[] = [];
    const deletions: string[] = [];
    
    let addedLines = 0;
    let deletedLines = 0;

    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        additions.push(line.substring(1)); // Remove the + sign
        addedLines++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletions.push(line.substring(1)); // Remove the - sign
        deletedLines++;
      }
    }

    const hasChanges = addedLines > 0 || deletedLines > 0;
    const summary = hasChanges 
      ? `+${addedLines} lines, -${deletedLines} lines`
      : 'No changes in the file';

    return {
      hasChanges,
      additions: additions.slice(0, 50), // Limit output
      deletions: deletions.slice(0, 50),
      summary,
    };
  }

  private executeGit(command: string, repoPath: string): string {
    try {
      return execSync(command, { cwd: repoPath, encoding: 'utf8' }).toString().trim();
    } catch (error) {
      throw new Error(`Git error: ${(error as Error).message}`);
    }
  }

  private getCurrentBranch(repoPath: string): string {
    return this.executeGit('git branch --show-current', repoPath);
  }

  private getMainBranch(repoPath: string): string {
    // Try to find main or master
    try {
      this.executeGit('git show-ref --verify refs/heads/main', repoPath);
      return 'main';
    } catch {
      return 'master';
    }
  }

  private getMergeInfo(repoPath: string, fromBranch: string, toBranch: string): MergeInfo {
    // Get the list of changed files
    const filesOutput = this.executeGit(
      `git diff --name-only ${fromBranch}..${toBranch}`,
      repoPath
    );
    const filesChanged = filesOutput ? filesOutput.split('\n').filter(f => f.trim()) : [];

    // Get stats of changes
    const statsOutput = this.executeGit(
      `git diff --numstat ${fromBranch}..${toBranch}`,
      repoPath
    );
    
    let insertions = 0;
    let deletions = 0;
    
    if (statsOutput) {
      statsOutput.split('\n').forEach(line => {
        const parts = line.split('\t');
        if (parts.length >= 2) {
          insertions += parseInt(parts[0]) || 0;
          deletions += parseInt(parts[1]) || 0;
        }
      });
    }

    // Number of commits
    const commitsOutput = this.executeGit(
      `git rev-list --count ${fromBranch}..${toBranch}`,
      repoPath
    );
    const commits = parseInt(commitsOutput) || 0;

    // Generate a simple summary
    let summary = '';
    if (commits === 0) {
      summary = 'No new commits for merge';
    } else {
      summary = `${commits} commits, ${filesChanged.length} files, +${insertions}/-${deletions} lines`;
    }

    return {
      sourceBranch: fromBranch,
      targetBranch: toBranch,
      filesChanged,
      insertions,
      deletions,
      commits,
      summary,
    };
  }

  private getQuickStats(repoPath: string, baseBranch: string, currentBranch: string) {
    if (baseBranch === currentBranch) {
      return {
        message: 'Already on the base branch',
        needsMerge: false,
      };
    }

    try {
      // Check if there are changes to merge
      const ahead = this.executeGit(
        `git rev-list --count ${baseBranch}..${currentBranch}`,
        repoPath
      );
      
      const behind = this.executeGit(
        `git rev-list --count ${currentBranch}..${baseBranch}`,
        repoPath
      );

      const aheadCount = parseInt(ahead) || 0;
      const behindCount = parseInt(behind) || 0;

      let message = '';
      if (aheadCount === 0 && behindCount === 0) {
        message = 'Branches are synchronized';
      } else if (aheadCount > 0 && behindCount === 0) {
        message = `Ahead by ${aheadCount} commits`;
      } else if (aheadCount === 0 && behindCount > 0) {
        message = `Behind by ${behindCount} commits`;
      } else {
        message = `Ahead by ${aheadCount}, behind by ${behindCount} commits`;
      }

      return {
        message,
        aheadBy: aheadCount,
        behindBy: behindCount,
        needsMerge: aheadCount > 0 || behindCount > 0,
      };
    } catch (error) {
      return {
        message: 'Failed to determine status',
        error: (error as Error).message,
      };
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Simple Merge Review MCP running');
  }
}

// Start
const server = new SimpleMergeReviewMCP();
server.run().catch(console.error);