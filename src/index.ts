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

class SimpleFileDiffMCP {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'simple-file-diff',
        version: '1.0.0',
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'show_file_diff',
            description: 'Показать изменения в файле между ветками',
            inputSchema: {
              type: 'object',
              properties: {
                repoPath: {
                  type: 'string',
                  description: 'Путь к git репозиторию',
                },
                filename: {
                  type: 'string',
                  description: 'Путь к файлу',
                },
                fromBranch: {
                  type: 'string',
                  description: 'Ветка откуда (по умолчанию master)',
                  default: 'master',
                },
                toBranch: {
                  type: 'string',
                  description: 'Ветка куда (по умолчанию HEAD)',
                  default: 'HEAD',
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

      if (name === 'show_file_diff') {
        return await this.showFileDiff(args);
      } else {
        throw new McpError(ErrorCode.MethodNotFound, `Неизвестный инструмент: ${name}`);
      }
    });
  }

  private async showFileDiff(args: any) {
    const { repoPath, filename, fromBranch = 'master', toBranch = 'HEAD' } = args;
    
    if (!fs.existsSync(repoPath)) {
      throw new Error(`Репозиторий не найден: ${repoPath}`);
    }

    // Получаем diff
    const diffOutput = this.executeGit(
      `git diff ${fromBranch}..${toBranch} -- "${filename}"`,
      repoPath
    );

    if (!diffOutput.trim()) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              filename,
              fromBranch,
              toBranch,
              hasChanges: false,
              message: 'Нет изменений в файле',
            }, null, 2),
          },
        ],
      };
    }

    // Парсим изменения
    const changes = this.parseChanges(diffOutput);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            filename,
            fromBranch,
            toBranch,
            hasChanges: true,
            ...changes,
          }, null, 2),
        },
      ],
    };
  }

  private executeGit(command: string, repoPath: string): string {
    try {
      return execSync(command, { cwd: repoPath, encoding: 'utf8' }).toString();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Git ошибка: ${errorMessage}`);
    }
  }

  private parseChanges(diffOutput: string) {
    const lines = diffOutput.split('\n');
    const added: string[] = [];
    const removed: string[] = [];
    
    let addedCount = 0;
    let removedCount = 0;

    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        added.push(line.substring(1));
        addedCount++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        removed.push(line.substring(1));
        removedCount++;
      }
    }

    return {
      summary: `+${addedCount} строк, -${removedCount} строк`,
      added: added.slice(0, 20), // Показываем только первые 20 строк
      removed: removed.slice(0, 20),
      totalAdded: addedCount,
      totalRemoved: removedCount,
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Simple File Diff MCP running');
  }
}

// Запуск
const server = new SimpleFileDiffMCP();
server.run().catch(console.error);