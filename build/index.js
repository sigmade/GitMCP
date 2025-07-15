import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, } from '@modelcontextprotocol/sdk/types.js';
import { execSync } from 'child_process';
import * as fs from 'fs';
class SimpleMergeReviewMCP {
    server;
    constructor() {
        this.server = new Server({
            name: 'simple-merge-review',
            version: '1.0.0',
        });
        this.setupToolHandlers();
    }
    setupToolHandlers() {
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
                    default:
                        throw new McpError(ErrorCode.MethodNotFound, `Неизвестный инструмент: ${name}`);
                }
            }
            catch (error) {
                const message = typeof error === 'object' && error !== null && 'message' in error
                    ? error.message
                    : String(error);
                throw new McpError(ErrorCode.InternalError, `Ошибка: ${message}`);
            }
        });
    }
    async showMergeDiff(args) {
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
    async quickMergeSummary(args) {
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
    executeGit(command, repoPath) {
        try {
            return execSync(command, { cwd: repoPath, encoding: 'utf8' }).toString().trim();
        }
        catch (error) {
            const message = typeof error === 'object' && error !== null && 'message' in error
                ? error.message
                : String(error);
            throw new Error(`Git ошибка: ${message}`);
        }
    }    
    getCurrentBranch(repoPath) {
        return this.executeGit('git branch --show-current', repoPath);
    }
    getMainBranch(repoPath) {
        // Пытаемся найти main или master
        try {
            this.executeGit('git show-ref --verify refs/heads/main', repoPath);
            return 'main';
        }
        catch {
            return 'master';
        }
    }
    getMergeInfo(repoPath, fromBranch, toBranch) {
        // Получаем список измененных файлов
        const filesOutput = this.executeGit(`git diff --name-only ${fromBranch}..${toBranch}`, repoPath);
        const filesChanged = filesOutput ? filesOutput.split('\n').filter(f => f.trim()) : [];
        // Получаем статистику изменений
        const statsOutput = this.executeGit(`git diff --numstat ${fromBranch}..${toBranch}`, repoPath);
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
        const commitsOutput = this.executeGit(`git rev-list --count ${fromBranch}..${toBranch}`, repoPath);
        const commits = parseInt(commitsOutput) || 0;
        // Генерируем простую сводку
        let summary = '';
        if (commits === 0) {
            summary = 'Нет новых коммитов для merge';
        }
        else {
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
    getQuickStats(repoPath, baseBranch, currentBranch) {
        if (baseBranch === currentBranch) {
            return {
                message: 'Уже на базовой ветке',
                needsMerge: false,
            };
        }
        try {
            // Проверяем, есть ли изменения для merge
            const ahead = this.executeGit(`git rev-list --count ${baseBranch}..${currentBranch}`, repoPath);
            const behind = this.executeGit(`git rev-list --count ${currentBranch}..${baseBranch}`, repoPath);
            const aheadCount = parseInt(ahead) || 0;
            const behindCount = parseInt(behind) || 0;
            let message = '';
            if (aheadCount === 0 && behindCount === 0) {
                message = 'Ветки синхронизированы';
            }
            else if (aheadCount > 0 && behindCount === 0) {
                message = `Опережает на ${aheadCount} коммитов`;
            }
            else if (aheadCount === 0 && behindCount > 0) {
                message = `Отстает на ${behindCount} коммитов`;
            }
            else {
                message = `Опережает на ${aheadCount}, отстает на ${behindCount} коммитов`;
            }
            return {
                message,
                aheadBy: aheadCount,
                behindBy: behindCount,
                needsMerge: aheadCount > 0 || behindCount > 0,
            };
        }
        catch (error) {
            return {
                message: 'Не удалось определить статус',
                error: typeof error === 'object' && error !== null && 'message' in error ? error.message : String(error),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLE1BQU0sRUFBRSxNQUFNLDJDQUEyQyxDQUFDO0FBQ25FLE9BQU8sRUFBRSxvQkFBb0IsRUFBRSxNQUFNLDJDQUEyQyxDQUFDO0FBQ2pGLE9BQU8sRUFDTCxxQkFBcUIsRUFDckIsU0FBUyxFQUNULHNCQUFzQixFQUN0QixRQUFRLEdBQ1QsTUFBTSxvQ0FBb0MsQ0FBQztBQUM1QyxPQUFPLEVBQUUsUUFBUSxFQUFFLE1BQU0sZUFBZSxDQUFDO0FBQ3pDLE9BQU8sS0FBSyxFQUFFLE1BQU0sSUFBSSxDQUFDO0FBYXpCLE1BQU0sb0JBQW9CO0lBQ2hCLE1BQU0sQ0FBUztJQUV2QjtRQUNFLElBQUksQ0FBQyxNQUFNLEdBQUcsSUFBSSxNQUFNLENBQUM7WUFDdkIsSUFBSSxFQUFFLHFCQUFxQjtZQUMzQixPQUFPLEVBQUUsT0FBTztTQUNqQixDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsaUJBQWlCLEVBQUUsQ0FBQztJQUMzQixDQUFDO0lBRU8saUJBQWlCO1FBQ3ZCLElBQUksQ0FBQyxNQUFNLENBQUMsaUJBQWlCLENBQUMsc0JBQXNCLEVBQUUsS0FBSyxJQUFJLEVBQUU7WUFDL0QsT0FBTztnQkFDTCxLQUFLLEVBQUU7b0JBQ0w7d0JBQ0UsSUFBSSxFQUFFLGlCQUFpQjt3QkFDdkIsV0FBVyxFQUFFLDhDQUE4Qzt3QkFDM0QsV0FBVyxFQUFFOzRCQUNYLElBQUksRUFBRSxRQUFROzRCQUNkLFVBQVUsRUFBRTtnQ0FDVixRQUFRLEVBQUU7b0NBQ1IsSUFBSSxFQUFFLFFBQVE7b0NBQ2QsV0FBVyxFQUFFLHdCQUF3QjtpQ0FDdEM7Z0NBQ0QsVUFBVSxFQUFFO29DQUNWLElBQUksRUFBRSxRQUFRO29DQUNkLFdBQVcsRUFBRSx3Q0FBd0M7b0NBQ3JELE9BQU8sRUFBRSxNQUFNO2lDQUNoQjtnQ0FDRCxR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