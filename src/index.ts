import { appendFile, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import chalk from "chalk";
import { input } from "@inquirer/prompts";
import { OpenRouter } from "@openrouter/sdk";
import type { ChatAssistantMessage, ChatMessages } from "@openrouter/sdk/models";
import { marked, type MarkedExtension } from "marked";
import { markedTerminal } from "marked-terminal";

const client = new OpenRouter();
const model = process.env.OPENROUTER_MODEL ?? "openai/gpt-5.6-luna"

marked.use(markedTerminal() as MarkedExtension);

const messages: ChatMessages[] = [];

function log(entry: string) {
    return appendFile("agent.log", `${new Date().toISOString()} ${entry}\n`);
}

function logResponse(message: ChatAssistantMessage | undefined) {
    const calls = message?.toolCalls;
    if (calls?.length) {
        const details = calls.map(({ function: fn }) => `${fn.name}(${fn.name === "edit_file" ? "replacement text omitted" : fn.arguments})`);
        return log(`[llm] response: tool_calls: ${details.join(", ")}`);
    }

    const content = message?.content;
    if (typeof content === "string" && content.trim()) {
        return log(`[llm] response: assistant text: ${content.length} chars`);
    }

    return log("[llm] response: empty");
}

async function askModel() {
    await log(`[llm] request: ${messages.length} messages, tools: read_file, edit_file`);
    return client.chat.send({
        chatRequest: {
            model,
            messages,
            tools: [{
                type: "function",
                function: {
                    name: "read_file",
                    description: "Read a file inside this project.",
                    parameters: {
                        type: "object",
                        properties: { path: { type: "string", description: "Relative project path" } },
                        required: ["path"],
                    },
                },
            }, {
                type: "function",
                function: {
                    name: "edit_file",
                    description: "Replace exactly one occurrence of old_text in an existing project file.",
                    parameters: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "Relative project path" },
                            old_text: { type: "string", description: "Exact text to replace" },
                            new_text: { type: "string", description: "Replacement text" },
                        },
                        required: ["path", "old_text", "new_text"],
                    },
                },
            }],
        },
    });
}

while (true) {
    let userMessage: string;
    try {
        userMessage = await input({ message: chalk.cyan("You:") });
    } catch (error) {
        if (error instanceof Error && error.name === "ExitPromptError") {
            break;
        }
        throw error;
    }

    messages.push({ role: "user", content: userMessage });

    let response: string;
    for (let rounds = 0; ; rounds++) {
        const result = await askModel();
        const message = result.choices[0]?.message;
        await logResponse(message);
        const toolCalls = message?.toolCalls ?? [];

        if (toolCalls.length === 0) {
            const content = message?.content;
            response = typeof content === "string" && content.trim()
                ? content
                : "The model returned no text.";
            break;
        }

        if (rounds === 5) {
            response = "The model reached the five-round tool limit.";
            break;
        }

        messages.push({ ...message, role: "assistant", toolCalls });

        for (const toolCall of toolCalls) {
            const { name, arguments: args } = toolCall.function;
            let toolResult: string;
            let toolPath = "<invalid path>";
            try {
                const { path, old_text: oldText, new_text: newText } = JSON.parse(args);
                if (typeof path === "string") toolPath = path;
                if (typeof path !== "string" || !path || isAbsolute(path)) {
                    throw new Error("Expected a relative project path.");
                }

                const trace = name === "edit_file" ? `${path}, ${oldText}, ${newText}` : path;
                console.log(`Tool: ${name}(${trace})`);
                if (name !== "read_file" && name !== "edit_file") {
                    throw new Error(`Unknown tool: ${name}`);
                }
                const root = await realpath(process.cwd());
                const file = await realpath(resolve(root, path));
                const projectPath = relative(root, file);
                if (projectPath === ".." || projectPath.startsWith(`..${sep}`) || isAbsolute(projectPath)) {
                    throw new Error("The path is outside the project.");
                }

                const text = await readFile(file, "utf8");
                if (name === "read_file") {
                    toolResult = text;
                } else {
                    if (typeof oldText !== "string" || !oldText || typeof newText !== "string") {
                        throw new Error("Expected non-empty old_text and a string new_text.");
                    }
                    const start = text.indexOf(oldText);
                    if (start === -1) throw new Error("old_text was not found.");
                    if (text.indexOf(oldText, start + 1) !== -1) {
                        throw new Error("old_text matched more than once.");
                    }
                    await writeFile(file, text.slice(0, start) + newText + text.slice(start + oldText.length));
                    toolResult = `Updated ${path}.`;
                }
            } catch (error) {
                toolResult = `${name} failed: ${error instanceof Error ? error.message : String(error)}`;
            }

            await log(`[tool] ${name}(${toolPath}): ${toolResult.length} chars`);
            messages.push({ role: "tool", toolCallId: toolCall.id, content: toolResult });
        }
    }

    messages.push({ role: "assistant", content: response });
    const formatted = await marked.parse(response);
    console.log(chalk.green("Assistant:"));
    console.log(formatted.trimEnd());
    console.log(chalk.dim("─".repeat(40)));
}
