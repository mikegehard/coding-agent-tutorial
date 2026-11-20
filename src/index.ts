import { spawn } from "node:child_process";
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

const codingSystemPrompt = `Read a file before changing it.
When working test-first, add one behavior test at a time. Run it and confirm it fails for the expected reason before changing the implementation. Make the smallest change that passes it, then rerun the suite before adding another test.
After making changes, run the relevant check and read its output.
If a check fails, address that failure before moving on.
Only claim the work is done when a check you ran confirms it.`;

const messages: ChatMessages[] = [{ role: "system", content: codingSystemPrompt }];

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

function runBash(command: string) {
    return new Promise<string>((resolveResult, reject) => {
        const child = spawn("bash", ["-c", `exec 2>&1\n${command}`], {
            cwd: process.cwd(),
            detached: true,
            stdio: ["ignore", "pipe", "inherit"],
        });
        const outputLimit = 8000;
        let output = "";
        let truncated = false;
        let timedOut = false;

        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
            const remaining = outputLimit - output.length;
            output += chunk.slice(0, remaining);
            truncated ||= chunk.length > remaining;
        });

        const timeout = setTimeout(() => {
            if (child.pid === undefined) return;
            timedOut = true;
            try {
                process.kill(-child.pid, "SIGKILL");
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH") reject(error);
            }
        }, 30_000);

        child.on("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.on("close", (code, signal) => {
            clearTimeout(timeout);
            const notes = [
                output,
                truncated ? "Output truncated after 8000 characters." : "",
                timedOut ? "Command killed after 30 seconds." : "",
                `Exit code: ${code ?? `none (${signal})`}`,
            ];
            resolveResult(notes.filter(Boolean).join("\n"));
        });
    });
}

async function askModel() {
    await log(`[llm] request: ${messages.length} messages, tools: read_file, edit_file, bash`);
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
            }, {
                type: "function",
                function: {
                    name: "bash",
                    description: "Run a Bash command from the project root.",
                    parameters: {
                        type: "object",
                        properties: { command: { type: "string" } },
                        required: ["command"],
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
            let toolTarget = "<invalid arguments>";
            try {
                const { command, path, old_text: oldText, new_text: newText } = JSON.parse(args);
                if (name === "bash") {
                    if (typeof command !== "string") throw new Error("Expected a command string.");
                    toolTarget = command;
                    console.log(`Using: bash(${command})`);
                    toolResult = await runBash(command);
                } else {
                    if (typeof path === "string") toolTarget = path;
                    if (typeof path !== "string" || !path || isAbsolute(path)) {
                        throw new Error("Expected a relative project path.");
                    }

                    const trace = name === "edit_file" ? `${path}, ${oldText}, ${newText}` : path;
                    console.log(`Using: ${name}(${trace})`);
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
                }
            } catch (error) {
                toolResult = `${name} failed: ${error instanceof Error ? error.message : String(error)}`;
            }

            await log(`[tool] ${name}(${toolTarget}): ${toolResult.length} chars`);
            messages.push({ role: "tool", toolCallId: toolCall.id, content: toolResult });
        }
    }

    messages.push({ role: "assistant", content: response });
    const formatted = await marked.parse(response);
    console.log(chalk.green("Assistant:"));
    console.log(formatted.trimEnd());
    console.log(chalk.dim("─".repeat(40)));
}
