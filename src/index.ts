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

// Простые типы
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
            description: 'Показать изменения между ветками перед merge',
            inputSchema: {
              type: 'object',
              properties: {
                repoPath: {
                  type: 'string',
                  description: 'Путь к git репозиторию',
                },
                fromBranch: {
                  type: 'string',
                  description: 'Ветка откуда merge (по умолчанию main)',
                  default: 'main',
                },
                toBranch: {
                  type: 'string',
                  description: 'Ветка куда merge (по умолчанию текущая)',
                },
              },
              required: ['repoPath'],
            },
          },
          {
            name: 'quick_merge_summary',
            description: 'Быстрая сводка изменений для merge',
            inputSchema: {
              type: 'object',
              properties: {
                repoPath: {
                  type: 'string',
                  description: 'Путь к git репозиторию',
                },
                branch: {
                  type: 'string',
                  description: 'Ветка для анализа (по умолчанию текущая)',
                },
              },
              required: ['repoPath'],
            },
          },
          {
            name: 'show_file_diff',
            description: 'Показать конкретные изменения в файле между ветками',
            inputSchema: {
              type: 'object',
              properties: {
                repoPath: {
                  type: 'string',
                  description: 'Путь к git репозиторию',
                },
                filename: {
                  type: 'string',
                  description: 'Путь к файлу относительно корня репозитория',
                },
                fromBranch: {
                  type: 'string',
                  description: 'Ветка откуда (по умолчанию main/master)',
                },
                toBranch: {
                  type: 'string',
                  description: 'Ветка куда (по умолчанию текущая)',
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
            throw new McpError(ErrorCode.MethodNotFound, `Неизвестный инструмент: ${name}`);
        }
      } catch (error) {
        throw new McpError(ErrorCode.InternalError, `Ошибка: ${(error as Error).message}`);
      }
    });
  }

  private async showMergeDiff(args: any) {
    const { repoPath, fromBranch = 'main', toBranch } = args;
    
    if (!fs.existsSync(repoPath)) {
      throw new Error(`Репозиторий не найден: ${repoPath}`);
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
      throw new Error(`Репозиторий не найден: ${repoPath}`);
    }

    const currentBranch = branch || this.getCurrentBranch(repoPath);
    const mainBranch = this.getMainBranch(repoPath);
    
    // Простая сводка изменений
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
      throw new Error(`Репозиторий не найден: ${repoPath}`);
    }

    // Определяем ветки
    const sourceBranch = fromBranch || this.getMainBranch(repoPath);
    const targetBranch = toBranch || this.getCurrentBranch(repoPath);

    // Получаем diff для конкретного файла
    const diffOutput = this.getFileDiff(repoPath, filename, sourceBranch, targetBranch);
    
    // Парсим diff для более читаемого вывода
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
            rawDiff: diffOutput.split('\n').slice(0, 100), // Ограничиваем количество строк
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
      throw new Error(`Не удалось получить diff для файла ${filename}: ${(error as Error).message}`);
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
        additions.push(line.substring(1)); // Убираем знак +
        addedLines++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletions.push(line.substring(1)); // Убираем знак -
        deletedLines++;
      }
    }

    const hasChanges = addedLines > 0 || deletedLines > 0;
    const summary = hasChanges 
      ? `+${addedLines} строк, -${deletedLines} строк`
      : 'Нет изменений в файле';

    return {
      hasChanges,
      additions: additions.slice(0, 50), // Ограничиваем вывод
      deletions: deletions.slice(0, 50),
      summary,
    };
  }

  private executeGit(command: string, repoPath: string): string {
    try {
      return execSync(command, { cwd: repoPath, encoding: 'utf8' }).toString().trim();
    } catch (error) {
      throw new Error(`Git ошибка: ${(error as Error).message}`);
    }
  }

  private getCurrentBranch(repoPath: string): string {
    return this.executeGit('git branch --show-current', repoPath);
  }

  private getMainBranch(repoPath: string): string {
    // Пытаемся найти main или master
    try {
      this.executeGit('git show-ref --verify refs/heads/main', repoPath);
      return 'main';
    } catch {
      return 'master';
    }
  }

  private getMergeInfo(repoPath: string, fromBranch: string, toBranch: string): MergeInfo {
    // Получаем список измененных файлов
    const filesOutput = this.executeGit(
      `git diff --name-only ${fromBranch}..${toBranch}`,
      repoPath
    );
    const filesChanged = filesOutput ? filesOutput.split('\n').filter(f => f.trim()) : [];

    // Получаем статистику изменений
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

    // Количество коммитов
    const commitsOutput = this.executeGit(
      `git rev-list --count ${fromBranch}..${toBranch}`,
      repoPath
    );
    const commits = parseInt(commitsOutput) || 0;

    // Генерируем простую сводку
    let summary = '';
    if (commits === 0) {
      summary = 'Нет новых коммитов для merge';
    } else {
      summary = `${commits} коммитов, ${filesChanged.length} файлов, +${insertions}/-${deletions} строк`;
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
        message: 'Уже на базовой ветке',
        needsMerge: false,
      };
    }

    try {
      // Проверяем, есть ли изменения для merge
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
        message = 'Ветки синхронизированы';
      } else if (aheadCount > 0 && behindCount === 0) {
        message = `Опережает на ${aheadCount} коммитов`;
      } else if (aheadCount === 0 && behindCount > 0) {
        message = `Отстает на ${behindCount} коммитов`;
      } else {
        message = `Опережает на ${aheadCount}, отстает на ${behindCount} коммитов`;
      }

      return {
        message,
        aheadBy: aheadCount,
        behindBy: behindCount,
        needsMerge: aheadCount > 0 || behindCount > 0,
      };
    } catch (error) {
      return {
        message: 'Не удалось определить статус',
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

// Запуск
const server = new SimpleMergeReviewMCP();
server.run().catch(console.error);