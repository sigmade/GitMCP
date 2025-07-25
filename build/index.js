import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, } from '@modelcontextprotocol/sdk/types.js';
import { execSync } from 'child_process';
import * as fs from 'fs';
class SimpleFileDiffMCP {
    server;
    constructor() {
        this.server = new Server({
            name: 'simple-file-diff',
            version: '1.0.0',
            capabilities: {
                tools: {},
            },
        });
        this.setupToolHandlers();
    }
    setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: 'show_file_diff',
                        description: 'Показать изменения в файле между ветками и сделай код ревью изменений',
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
            }
            else {
                throw new McpError(ErrorCode.MethodNotFound, `Неизвестный инструмент: ${name}`);
            }
        });
    }
    async showFileDiff(args) {
        const { repoPath, filename, fromBranch = 'master', toBranch = 'HEAD' } = args;
        if (!fs.existsSync(repoPath)) {
            throw new Error(`Репозиторий не найден: ${repoPath}`);
        }
        // Получаем diff
        const diffOutput = this.executeGit(`git diff ${fromBranch}..${toBranch} -- "${filename}"`, repoPath);
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
    executeGit(command, repoPath) {
        try {
            return execSync(command, { cwd: repoPath, encoding: 'utf8' }).toString();
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Git ошибка: ${errorMessage}`);
        }
    }
    parseChanges(diffOutput) {
        const lines = diffOutput.split('\n');
        const added = [];
        const removed = [];
        let addedCount = 0;
        let removedCount = 0;
        for (const line of lines) {
            if (line.startsWith('+') && !line.startsWith('+++')) {
                added.push(line.substring(1));
                addedCount++;
            }
            else if (line.startsWith('-') && !line.startsWith('---')) {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLE1BQU0sRUFBRSxNQUFNLDJDQUEyQyxDQUFDO0FBQ25FLE9BQU8sRUFBRSxvQkFBb0IsRUFBRSxNQUFNLDJDQUEyQyxDQUFDO0FBQ2pGLE9BQU8sRUFDTCxxQkFBcUIsRUFDckIsU0FBUyxFQUNULHNCQUFzQixFQUN0QixRQUFRLEdBQ1QsTUFBTSxvQ0FBb0MsQ0FBQztBQUM1QyxPQUFPLEVBQUUsUUFBUSxFQUFFLE1BQU0sZUFBZSxDQUFDO0FBQ3pDLE9BQU8sS0FBSyxFQUFFLE1BQU0sSUFBSSxDQUFDO0FBRXpCLE1BQU0saUJBQWlCO0lBQ2IsTUFBTSxDQUFTO0lBRXZCO1FBQ0UsSUFBSSxDQUFDLE1BQU0sR0FBRyxJQUFJLE1BQU0sQ0FDdEI7WUFDRSxJQUFJLEVBQUUsa0JBQWtCO1lBQ3hCLE9BQU8sRUFBRSxPQUFPO1lBQ2hCLFlBQVksRUFBRTtnQkFDWixLQUFLLEVBQUUsRUFBRTthQUNWO1NBQ0YsQ0FDRixDQUFDO1FBRUYsSUFBSSxDQUFDLGlCQUFpQixFQUFFLENBQUM7SUFDM0IsQ0FBQztJQUVPLGlCQUFpQjtRQUN2QixJQUFJLENBQUMsTUFBTSxDQUFDLGlCQUFpQixDQUFDLHNCQUFzQixFQUFFLEtBQUssSUFBSSxFQUFFO1lBQy9ELE9BQU87Z0JBQ0wsS0FBSyxFQUFFO29CQUNMO3dCQUNFLElBQUksRUFBRSxnQkFBZ0I7d0JBQ3RCLFdBQVcsRUFBRSwwQ0FBMEM7d0JBQ3ZELFdBQVcsRUFBRTs0QkFDWCxJQUFJLEVBQUUsUUFBUTs0QkFDZCxVQUFVLEVBQUU7Z0NBQ1YsUUFBUSxFQUFFO29DQUNSLElBQUksRUFBRSxRQUFRO29DQUNkLFdBQVcsRUFBRSx3QkFBd0I7aUNBQ3RDO2dDQUNELFFBQVEsRUFBRTtvQ0FDUixJQUFJLEVBQUUsUUFBUTtvQ0FDZCxXQUFXLEVBQUUsY0FB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