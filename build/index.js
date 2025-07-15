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
            }
            catch (error) {
                throw new McpError(ErrorCode.InternalError, `Ошибка: ${error.message}`);
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
    async showFileDiff(args) {
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
    getFileDiff(repoPath, filename, fromBranch, toBranch) {
        try {
            return this.executeGit(`git diff ${fromBranch}..${toBranch} -- "${filename}"`, repoPath);
        }
        catch (error) {
            throw new Error(`Не удалось получить diff для файла ${filename}: ${error.message}`);
        }
    }
    parseFileDiff(diffOutput) {
        const lines = diffOutput.split('\n');
        const additions = [];
        const deletions = [];
        let addedLines = 0;
        let deletedLines = 0;
        for (const line of lines) {
            if (line.startsWith('+') && !line.startsWith('+++')) {
                additions.push(line.substring(1)); // Убираем знак +
                addedLines++;
            }
            else if (line.startsWith('-') && !line.startsWith('---')) {
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
    executeGit(command, repoPath) {
        try {
            return execSync(command, { cwd: repoPath, encoding: 'utf8' }).toString().trim();
        }
        catch (error) {
            throw new Error(`Git ошибка: ${error.message}`);
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
                error: error.message,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLE1BQU0sRUFBRSxNQUFNLDJDQUEyQyxDQUFDO0FBQ25FLE9BQU8sRUFBRSxvQkFBb0IsRUFBRSxNQUFNLDJDQUEyQyxDQUFDO0FBQ2pGLE9BQU8sRUFDTCxxQkFBcUIsRUFDckIsU0FBUyxFQUNULHNCQUFzQixFQUN0QixRQUFRLEdBQ1QsTUFBTSxvQ0FBb0MsQ0FBQztBQUM1QyxPQUFPLEVBQUUsUUFBUSxFQUFFLE1BQU0sZUFBZSxDQUFDO0FBQ3pDLE9BQU8sS0FBSyxFQUFFLE1BQU0sSUFBSSxDQUFDO0FBYXpCLE1BQU0sb0JBQW9CO0lBQ2hCLE1BQU0sQ0FBUztJQUV2QjtRQUNFLElBQUksQ0FBQyxNQUFNLEdBQUcsSUFBSSxNQUFNLENBQUM7WUFDdkIsSUFBSSxFQUFFLHFCQUFxQjtZQUMzQixPQUFPLEVBQUUsT0FBTztTQUNqQixDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsaUJBQWlCLEVBQUUsQ0FBQztJQUMzQixDQUFDO0lBRU8saUJBQWlCO1FBQ3ZCLElBQUksQ0FBQyxNQUFNLENBQUMsaUJBQWlCLENBQUMsc0JBQXNCLEVBQUUsS0FBSyxJQUFJLEVBQUU7WUFDL0QsT0FBTztnQkFDTCxLQUFLLEVBQUU7b0JBQ0w7d0JBQ0UsSUFBSSxFQUFFLGlCQUFpQjt3QkFDdkIsV0FBVyxFQUFFLDhDQUE4Qzt3QkFDM0QsV0FBVyxFQUFFOzRCQUNYLElBQUksRUFBRSxRQUFROzRCQUNkLFVBQVUsRUFBRTtnQ0FDVixRQUFRLEVBQUU7b0NBQ1IsSUFBSSxFQUFFLFFBQVE7b0NBQ2QsV0FBVyxFQUFFLHdCQUF3QjtpQ0FDdEM7Z0NBQ0QsVUFBVSxFQUFFO29DQUNWLElBQUksRUFBRSxRQUFRO29DQUNkLFdBQVcsRUFBRSx3Q0FBd0M7b0NBQ3JELE9BQU8sRUFBRSxNQUFNO2lDQUNoQjtnQ0FDRCxRQUFRLEVBQUU7b0NBQ1IsSUFBSSxFQUFFLFFBQVE7b0NBQ2QsV0FBVyxFQUFFLHlDQUF5QztpQ0FDdkQ7NkJBQ0Y7NEJBQ0QsUUFBUSxFQUFFLENBQUMsVUFBVSxDQUFDO3lCQUN2QjtxQkFDRjtvQkFDRDt3QkFDRSxJQUFJLEVBQUUscUJBQXFCO3dCQUMzQixXQUFXLEVBQUUsb0NBQW9DO3dCQUNqRCxXQUFXLEVBQUU7NEJBQ1gsSUFBSSxFQUFFLFFBQVE7NEJBQ2QsVUFBVSxFQUFFO2dDQUNWLFFBQVEsRUFBRTtvQ0FDUixJQUFJLEVBQUUsUUFBUTtvQ0FDZCxXQUFXLEVBQUUsd0JBQXdCO2lDQUN0QztnQ0FDRCxNQUFNLEVBQUU7b0NBQ04sSUFBSSxFQUFFLFFBQVE7b0NBQ2QsV0FBVyxFQUFFLDBDQUEwQztpQ0FDeEQ7NkJBQ0Y7NEJBQ0QsUUFBUSxFQUFFLENBQUMsVUFBVSxDQUFDO3lCQUN2QjtxQkFDRjtvQkFDRDt3QkFDRSxJQUFJLEVBQUUsZ0JBQWdCO3dCQUN0QixXQUFXLEVBQUUscURBQXFEO3dCQUNsRSxXQUFXLEVBQUU7NEJBQ1gsSUFBSSxFQUFFLFFBQVE7NEJBQ2QsVUFBVSxFQUFFO2dDQUNWLFFBQVEsRUFBRTtvQ0FDUixJQUFJLEVBQUUsUUFBUTtvQ0FDZCxXQUFXLEVBQUUsd0JBQXdCO2lDQUN0QztnQ0FDRCxRQUFRLEVBQUU7b0NBQ1IsSUFBSSxFQUFFLFFBQVE7b0NBQ2QsV0FBVyxFQUFFLDZDQUE2QztpQ0FDM0Q7Z0NBQ0QsVUFBVSxFQUFFO29DQUNWLElBQUksRUFBRSxRQUFRO29DQUNkLFdBQVcsRUFBRSx5Q0FBeUM7aUNBQ3ZEO2dDQUNELFFBQVEsRUFBRTtvQ0FDUixJQUFJLEVBQUUsUUFBUTtvQ0FDZCxXQUFXLEVBQUUsbUNBQW1DO2lDQUNqRDs2QkFDRjs0QkFDRCxRQUFRLEVBQUUsQ0FBQyxVQUFVLEVBQUUsVUFBVSxDQUFDO3lCQUNuQztxQkFDRjtpQkFDRjthQUNGLENBQUM7UUFDSixDQUFDLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyxNQUFNLENBQUMsaUJBQWlCLENBQUMscUJBQXFCLEVBQUUsS0FBSyxFQUFFLE9BQU8sRUFBRSxFQUFFO1lBQ3JFLE1BQU0sRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLElBQUksRUFBRSxHQUFHLE9BQU8sQ0FBQyxNQUFNLENBQUM7WUFFakQsSUFBSSxDQUFDO2dCQUNILFFBQVEsSUFBSSxFQUFFLENBQUM7b0JBQ2IsS0FBSyxpQkFBaUI7d0JBQ3BCLE9BQU8sTUFBTSxJQUFJLENBQUMsYUFBYSxDQUFDLElBQUksQ0FBQyxDQUFDO29CQUN4QyxLQUFLLHFCQUFxQjt3QkFDeEIsT0FBTyxNQUFNLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxJQUFJLENBQUMsQ0FBQztvQkFDNUMsS0FBSyxnQkFBZ0I7d0JBQ25CLE9BQU8sTUFBTSxJQUFJLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxDQUFDO29CQUN2Qzt3QkFDRSxNQUFNLElBQUksUUFBUSxDQUFDLFNBQVMsQ0FBQyxjQUFjLEVBQUUsMkJBQTJCLElBQUksRUFBRSxDQUFDLENBQUM7Z0JBQ3BGLENBQUM7WUFDSCxDQUFDO1lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztnQkFDZixNQUFNLElBQUksUUFBUSxDQUFDLFNBQVMsQ0FBQyxhQUFhLEVBQUUsV0FBWSxLQUFlLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQztZQUNyRixDQUFDO1FBQ0gsQ0FBQyxDQUFDLENBQUM7SUFDTCxDQUFDO0lBRU8sS0FBSyxDQUFDLGFBQWEsQ0FBQyxJQUFTO1FBQ25DLE1BQU0sRUFBRSxRQUFRLEVBQUUsVUFBVSxHQUFHLE1BQU0sRUFBRSxRQUFRLEVBQUUsR0FBRyxJQUFJLENBQUM7UUFFekQsSUFBSSxDQUFDLEVBQUUsQ0FBQyxVQUFVLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQztZQUM3QixNQUFNLElBQUksS0FBSyxDQUFDLDBCQUEwQixRQUFRLEVBQUUsQ0FBQyxDQUFDO1FBQ3hELENBQUM7UUFFRCxNQUFNLGFBQWEsR0FBRyxRQUFRLElBQUksSUFBSSxDQUFDLGdCQUFnQixDQUFDLFFBQVEsQ0FBQyxDQUFDO1FBQ2xFLE1BQU0sU0FBUyxHQUFHLElBQUksQ0FBQyxZQUFZLENBQUMsUUFBUSxFQUFFLFVBQVUsRUFBRSxhQUFhLENBQUMsQ0FBQztRQUV6RSxPQUFPO1lBQ0wsT0FBTyxFQUFFO2dCQUNQO29CQUNFLElBQUksRUFBRSxNQUFNO29CQUNaLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLFNBQVMsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDO2lCQUN6QzthQUNGO1NBQ0YsQ0FBQztJQUNKLENBQUM7SUFFTyxLQUFLLENBQUMsaUJBQWlCLENBQUMsSUFBUztRQUN2QyxNQUFNLEVBQUUsUUFBUSxFQUFFLE1BQU0sRUFBRSxHQUFHLElBQUksQ0FBQztRQUVsQyxJQUFJLENBQUMsRUFBRSxDQUFDLFVBQVUsQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDO1lBQzdCLE1BQU0sSUFBSSxLQUFLLENBQUMsMEJBQTBCLFFBQVEsRUFBRSxDQUFDLENBQUM7UUFDeEQsQ0FBQztRQUVELE1BQU0sYUFBYSxHQUFHLE1BQU0sSUFBSSxJQUFJLENBQUMsZ0JBQWdCLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDaEUsTUFBTSxVQUFVLEdBQUcsSUFBSSxDQUFDLGFBQWEsQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUVoRCwyQkFBMkI7UUFDM0IsTUFBTSxPQUFPLEdBQUc7WUFDZCxhQUFhO1lBQ2IsVUFBVSxFQUFFLFVBQVU7WUFDdEIsR0FBRyxJQUFJLENBQUMsYUFBYSxDQUFDLFFBQVEsRUFBRSxVQUFVLEVBQUUsYUFBYSxDQUFDO1NBQzNELENBQUM7UUFFRixPQUFPO1lBQ0wsT0FBTyxFQUFFO2dCQUNQO29CQUNFLElBQUksRUFBRSxNQUFNO29CQUNaLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLE9BQU8sRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDO2lCQUN2QzthQUNGO1NBQ0YsQ0FBQztJQUNKLENBQUM7SUFFTyxLQUFLLENBQUMsWUFBWSxDQUFDLElBQVM7UUFDbEMsTUFBTSxFQUFFLFFBQVEsRUFBRSxRQUFRLEVBQUUsVUFBVSxFQUFFLFFBQVEsRUFBRSxHQUFHLElBQUksQ0FBQztRQUUxRCxJQUFJLENBQUMsRUFBRSxDQUFDLFVBQVUsQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDO1lBQzdCLE1BQU0sSUFBSSxLQUFLLENBQUMsMEJBQTBCLFFBQVEsRUFBRSxDQUFDLENBQUM7UUFDeEQsQ0FBQztRQUVELG1CQUFtQjtRQUNuQixNQUFNLFlBQVksR0FBRyxVQUFVLElBQUksSUFBSSxDQUFDLGFBQWEsQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUNoRSxNQUFNLFlBQVksR0FBRyxRQUFRLElBQUksSUFBSSxDQUFDLGdCQUFnQixDQUFDLFFBQVEsQ0FBQyxDQUFDO1FBRWpFLHNDQUFzQztRQUN0QyxNQUFNLFVBQVUsR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDLFFBQVEsRUFBRSxRQUFRLEVBQUUsWUFBWSxFQUFFLFlBQVksQ0FBQyxDQUFDO1FBRXBGLHlDQUF5QztRQUN6QyxNQUFNLFVBQVUsR0FBRyxJQUFJLENBQUMsYUFBYSxDQUFDLFVBQVUsQ0FBQyxDQUFDO1FBRWxELE9BQU87WUFDTCxPQUFPLEVBQUU7Z0JBQ1A7b0JBQ0UsSUFBSSxFQUFFLE1BQU07b0JBQ1osSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUM7d0JBQ25CLFFBQVE7d0JBQ1IsVUFBVSxFQUFFLFlBQVk7d0JBQ3hCLFFBQVEsRUFBRSxZQUFZO3dCQUN0QixHQUFHLFVBQVU7d0JBQ2IsT0FBTyxFQUFFLFVBQVUsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxHQUFHLENBQUMsRUFBRSxnQ0FBZ0M7cUJBQ2hGLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztpQkFDWjthQUNGO1NBQ0YsQ0FBQztJQUNKLENBQUM7SUFFTyxXQUFXLENBQUMsUUFBZ0IsRUFBRSxRQUFnQixFQUFFLFVBQWtCLEVBQUUsUUFBZ0I7UUFDMUYsSUFBSSxDQUFDO1lBQ0gsT0FBTyxJQUFJLENBQUMsVUFBVSxDQUNwQixZQUFZLFVBQVUsS0FBSyxRQUFRLFFBQVEsUUFBUSxHQUFHLEVBQ3RELFFBQVEsQ0FDVCxDQUFDO1FBQ0osQ0FBQztRQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7WUFDZixNQUFNLElBQUksS0FBSyxDQUFDLHNDQUFzQyxRQUFRLEtBQU0sS0FBZSxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUM7UUFDakcsQ0FBQztJQUNILENBQUM7SUFFTyxhQUFhLENBQUMsVUFBa0I7UUFDdEMsTUFBTSxLQUFLLEdBQUcsVUFBVSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUNyQyxNQUFNLFNBQVMsR0FBYSxFQUFFLENBQUM7UUFDL0IsTUFBTSxTQUFTLEdBQWEsRUFBRSxDQUFDO1FBRS9CLElBQUksVUFBVSxHQUFHLENBQUMsQ0FBQztRQUNuQixJQUFJLFlBQVksR0FBRyxDQUFDLENBQUM7UUFFckIsS0FBSyxNQUFNLElBQUksSUFBSSxLQUFLLEVBQUUsQ0FBQztZQUN6QixJQUFJLElBQUksQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUM7Z0JBQ3BELFNBQVMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsaUJBQWlCO2dCQUNwRCxVQUFVLEVBQUUsQ0FBQztZQUNmLENBQUM7aUJBQU0sSUFBSSxJQUFJLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDO2dCQUMzRCxTQUFTLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLGlCQUFpQjtnQkFDcEQsWUFBWSxFQUFFLENBQUM7WUFDakIsQ0FBQztRQUNILENBQUM7UUFFRCxNQUFNLFVBQVUsR0FBRyxVQUFVLEdBQUcsQ0FBQyxJQUFJLFlBQVksR0FBRyxDQUFDLENBQUM7UUFDdEQsTUFBTSxPQUFPLEdBQUcsVUFBVTtZQUN4QixDQUFDLENBQUMsSUFBSSxVQUFVLFlBQVksWUFBWSxRQUFRO1lBQ2hELENBQUMsQ0FBQyx1QkFBdUIsQ0FBQztRQUU1QixPQUFPO1lBQ0wsVUFBVTtZQUNWLFNBQVMsRUFBRSxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsRUFBRSxxQkFBcUI7WUFDeEQsU0FBUyxFQUFFLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQztZQUNqQyxPQUFPO1NBQ1IsQ0FBQztJQUNKLENBQUM7SUFFTyxVQUFVLENBQUMsT0FBZSxFQUFFLFFBQWdCO1FBQ2xELElBQUksQ0FBQztZQUNILE9BQU8sUUFBUSxDQUFDLE9BQU8sRUFBRSxFQUFFLEdBQUcsRUFBRSxRQUFRLEVBQUUsUUFBUSxFQUFFLE1BQU0sRUFBRSxDQUFDLENBQUMsUUFBUSxFQUFFLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDbEYsQ0FBQztRQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7WUFDZixNQUFNLElBQUksS0FBSyxDQUFDLGVBQWdCLEtBQWUsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDO1FBQzdELENBQUM7SUFDSCxDQUFDO0lBRU8sZ0JBQWdCLENBQUMsUUFBZ0I7UUFDdkMsT0FBTyxJQUFJLENBQUMsVUFBVSxDQUFDLDJCQUEyQixFQUFFLFFBQVEsQ0FBQyxDQUFDO0lBQ2hFLENBQUM7SUFFTyxhQUFhLENBQUMsUUFBZ0I7UUFDcEMsaUNBQWlDO1FBQ2pDLElBQUksQ0FBQztZQUNILElBQUksQ0FBQyxVQUFVLENBQUMsdUNBQXVDLEVBQUUsUUFBUSxDQUFDLENBQUM7WUFDbkUsT0FBTyxNQUFNLENBQUM7UUFDaEIsQ0FBQztRQUFDLE1BQU0sQ0FBQztZQUNQLE9BQU8sUUFBUSxDQUFDO1FBQ2xCLENBQUM7SUFDSCxDQUFDO0lBRU8sWUFBWSxDQUFDLFFBQWdCLEVBQUUsVUFBa0IsRUFBRSxRQUFnQjtRQUN6RSxvQ0FBb0M7UUFDcEMsTUFBTSxXQUFXLEdBQUcsSUFBSSxDQUFDLFVBQVUsQ0FDakMsd0JBQXdCLFVBQVUsS0FBSyxRQUFRLEVBQUUsRUFDakQsUUFBUSxDQUNULENBQUM7UUFDRixNQUFNLFlBQVksR0FBRyxXQUFXLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztRQUV0RixnQ0FBZ0M7UUFDaEMsTUFBTSxXQUFXLEdBQUcsSUFBSSxDQUFDLFVBQVUsQ0FDakMsc0JBQXNCLFVBQVUsS0FBSyxRQUFRLEVBQUUsRUFDL0MsUUFBUSxDQUNULENBQUM7UUFFRixJQUFJLFVBQVUsR0FBRyxDQUFDLENBQUM7UUFDbkIsSUFBSSxTQUFTLEdBQUcsQ0FBQyxDQUFDO1FBRWxCLElBQUksV0FBVyxFQUFFLENBQUM7WUFDaEIsV0FBVyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLEVBQUU7Z0JBQ3JDLE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQy9CLElBQUksS0FBSyxDQUFDLE1BQU0sSUFBSSxDQUFDLEVBQUUsQ0FBQztvQkFDdEIsVUFBVSxJQUFJLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUM7b0JBQ3RDLFNBQVMsSUFBSSxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDO2dCQUN2QyxDQUFDO1lBQ0gsQ0FBQyxDQUFDLENBQUM7UUFDTCxDQUFDO1FBRUQsc0JBQXNCO1FBQ3RCLE1BQU0sYUFBYSxHQUFHLElBQUksQ0FBQyxVQUFVLENBQ25DLHdCQUF3QixVQUFVLEtBQUssUUFBUSxFQUFFLEVBQ2pELFFBQVEsQ0FDVCxDQUFDO1FBQ0YsTUFBTSxPQUFPLEdBQUcsUUFBUSxDQUFDLGFBQWEsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUU3Qyw0QkFBNEI7UUFDNUIsSUFBSSxPQUFPLEdBQUcsRUFBRSxDQUFDO1FBQ2pCLElBQUksT0FBTyxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQ2xCLE9BQU8sR0FBRyw4QkFBOEIsQ0FBQztRQUMzQyxDQUFDO2FBQU0sQ0FBQztZQUNOLE9BQU8sR0FBRyxHQUFHLE9BQU8sY0FBYyxZQUFZLENBQUMsTUFBTSxhQUFhLFVBQVUsS0FBSyxTQUFTLFFBQVEsQ0FBQztRQUNyRyxDQUFDO1FBRUQsT0FBTztZQUNMLFlBQVksRUFBRSxVQUFVO1lBQ3hCLFlBQVksRUFBRSxRQUFRO1lBQ3RCLFlBQVk7WUFDWixVQUFVO1lBQ1YsU0FBUztZQUNULE9BQU87WUFDUCxPQUFPO1NBQ1IsQ0FBQztJQUNKLENBQUM7SUFFTyxhQUFhLENBQUMsUUFBZ0IsRUFBRSxVQUFrQixFQUFFLGFBQXFCO1FBQy9FLElBQUksVUFBVSxLQUFLLGFBQWEsRUFBRSxDQUFDO1lBQ2pDLE9BQU87Z0JBQ0wsT0FBTyxFQUFFLHNCQUFzQjtnQkFDL0IsVUFBVSxFQUFFLEtBQUs7YUFDbEIsQ0FBQztRQUNKLENBQUM7UUFFRCxJQUFJLENBQUM7WUFDSCx5Q0FBeUM7WUFDekMsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLFVBQVUsQ0FDM0Isd0JBQXdCLFVBQVUsS0FBSyxhQUFhLEVBQUUsRUFDdEQsUUFBUSxDQUNULENBQUM7WUFFRixNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsVUFBVSxDQUM1Qix3QkFBd0IsYUFBYSxLQUFLLFVBQVUsRUFBRSxFQUN0RCxRQUFRLENBQ1QsQ0FBQztZQUVGLE1BQU0sVUFBVSxHQUFHLFFBQVEsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDeEMsTUFBTSxXQUFXLEdBQUcsUUFBUSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUUxQyxJQUFJLE9BQU8sR0FBRyxFQUFFLENBQUM7WUFDakIsSUFBSSxVQUFVLEtBQUssQ0FBQyxJQUFJLFdBQVcsS0FBSyxDQUFDLEVBQUUsQ0FBQztnQkFDMUMsT0FBTyxHQUFHLHdCQUF3QixDQUFDO1lBQ3JDLENBQUM7aUJBQU0sSUFBSSxVQUFVLEdBQUcsQ0FBQyxJQUFJLFdBQVcsS0FBSyxDQUFDLEVBQUUsQ0FBQztnQkFDL0MsT0FBTyxHQUFHLGdCQUFnQixVQUFVLFdBQVcsQ0FBQztZQUNsRCxDQUFDO2lCQUFNLElBQUksVUFBVSxLQUFLLENBQUMsSUFBSSxXQUFXLEdBQUcsQ0FBQyxFQUFFLENBQUM7Z0JBQy9DLE9BQU8sR0FBRyxjQUFjLFdBQVcsV0FBVyxDQUFDO1lBQ2pELENBQUM7aUJBQU0sQ0FBQztnQkFDTixPQUFPLEdBQUcsZ0JBQWdCLFVBQVUsZ0JBQWdCLFdBQVcsV0FBVyxDQUFDO1lBQzdFLENBQUM7WUFFRCxPQUFPO2dCQUNMLE9BQU87Z0JBQ1AsT0FBTyxFQUFFLFVBQVU7Z0JBQ25CLFFBQVEsRUFBRSxXQUFXO2dCQUNyQixVQUFVLEVBQUUsVUFBVSxHQUFHLENBQUMsSUFBSSxXQUFXLEdBQUcsQ0FBQzthQUM5QyxDQUFDO1FBQ0osQ0FBQztRQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7WUFDZixPQUFPO2dCQUNMLE9BQU8sRUFBRSw4QkFBOEI7Z0JBQ3ZDLEtBQUssRUFBRyxLQUFlLENBQUMsT0FBTzthQUNoQyxDQUFDO1FBQ0osQ0FBQztJQUNILENBQUM7SUFFRCxLQUFLLENBQUMsR0FBRztRQUNQLE1BQU0sU0FBUyxHQUFHLElBQUksb0JBQW9CLEVBQUUsQ0FBQztRQUM3QyxNQUFNLElBQUksQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFDO1FBQ3JDLE9BQU8sQ0FBQyxLQUFLLENBQUMsaUNBQWlDLENBQUMsQ0FBQztJQUNuRCxDQUFDO0NBQ0Y7QUFFRCxTQUFTO0FBQ1QsTUFBTSxNQUFNLEdBQUcsSUFBSSxvQkFBb0IsRUFBRSxDQUFDO0FBQzFDLE1BQU0sQ0FBQyxHQUFHLEVBQUUsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDIn0=